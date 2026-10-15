import { existsSync, readFileSync, mkdirSync, lstatSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { dirname } from "node:path"
import { AccountManager } from "./accounts.ts"
import { Database, DOWNLOAD_COLUMNS } from "./database.ts"
import { Downloader } from "./download.ts"
import { Source } from "./source.ts"
import { refreshEmby } from "./emby.ts"
import { createTransport, floodSeconds } from "./telegram.ts"
import {
  atomicWrite,
  checkConfig,
  defaults,
  ManagementError,
  now,
  reference,
  settingsFromEnv,
  version,
} from "./config.ts"
import { validateFilters, validateWrite } from "../lib/validation.ts"
import type { Settings } from "./config.ts"
import type { TransportFactory } from "./telegram.ts"
import type {
  Config,
  State,
  Scan,
  Filters,
  Downloads,
  Write,
  WriteResult,
} from "../lib/types.ts"

export class ManagementRuntime {
  db: Database
  accounts: AccountManager
  downloader: Downloader
  raw: Config
  version: string
  sources = new Map<string, Source>()
  bindings = new Map<string, string | null>()
  resolved = new Map<string, number>()
  scans = new Map<string, Scan>()
  active = new Set<Promise<void>>()
  scanning = new Map<string, Promise<void>>()
  pending = new Map<number, number>()
  restoreTask: Promise<void> = Promise.resolve()
  backfillTask?: Promise<void>
  restoring = true
  changed = true
  stopped = false
  recovered = false
  busy = false
  private serial: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  private nextRound = 0
  private nextRebuild = 0
  private refreshTask?: Promise<void>
  private instanceLock: DatabaseSync
  settings: Settings
  constructor(settings: Settings, factory: TransportFactory = createTransport) {
    this.settings = settings
    mkdirSync(dirname(settings.database), { recursive: true, mode: 0o700 })
    this.instanceLock = new DatabaseSync(
      settings.database + ".runtime-lock.sqlite3"
    )
    try {
      this.instanceLock.exec(
        "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE"
      )
    } catch {
      this.instanceLock.close()
      throw new ManagementError("该状态目录已被另一个后台实例使用", 503)
    }
    try {
      const data: unknown = existsSync(settings.config)
        ? { ...defaults, ...JSON.parse(readFileSync(settings.config, "utf8")) }
        : structuredClone(defaults)
      checkConfig(data)
      this.raw = data
      this.version = version(data)
      this.db = new Database(settings.database)
      this.accounts = new AccountManager(this.db, settings, factory, () => {
        this.changed = true
      })
      this.downloader = new Downloader(this.db, settings)
    } catch (error) {
      this.instanceLock.close()
      throw error
    }
  }
  async start() {
    await this.downloader.prepare()
    this.restoreTask = this.accounts.restore().finally(() => {
      this.restoring = false
    })
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.db.blocked = true
        this.nextRebuild = now() + 60
        this.changed = false
      })
    }, 1000)
    this.timer.unref()
    void this.tick()
  }
  private async tick() {
    if (this.ticking || this.stopped || this.restoring || this.busy) return
    this.ticking = true
    try {
      await this.exclusive(() => this.accounts.expire())
      if (
        (this.changed || (this.db.blocked && now() >= this.nextRebuild)) &&
        !this.active.size &&
        !this.backfillTask
      ) {
        await this.exclusive(() => this.rebuild())
      }
      for (const [id, source] of this.sources) {
        if (!source.client.connected) {
          this.accounts.errors.set(id, "连接中断，等待恢复")
          this.changed = true
          this.db.blocked = true
        }
      }
      if (!this.changed && !this.busy && !this.backfillTask)
        this.scheduleScans()
      if (
        !this.changed &&
        !this.busy &&
        this.recovered &&
        now() >= this.downloader.pauseUntil
      ) {
        while (this.active.size < this.raw.download_concurrency) {
          const channels = [...this.sources]
            .filter(
              ([id, s]) =>
                s.client.connected &&
                !this.accounts.errors.has(id) &&
                s.notBefore <= now()
            )
            .flatMap(([, s]) => [...s.entities.keys()])
          const task = this.db.claim(channels)
          if (!task) break
          const owner = this.owner(task.channel_id)!,
            source = this.sources.get(owner)!
          const work = this.downloader.process(
            task,
            source.client,
            source.entities.get(task.channel_id)!,
            (s) => source.flood(s),
            () => {
              this.accounts.errors.set(owner, "需要重新登录")
              this.changed = true
              this.db.blocked = true
            }
          )
          this.active.add(work)
          void work.finally(() => this.active.delete(work))
        }
      }
      if (!this.refreshTask) {
        this.refreshTask = refreshEmby(
          this.db,
          this.embyUrl(),
          this.embyKey()
        ).finally(() => {
          this.refreshTask = undefined
        })
      }
    } finally {
      this.ticking = false
    }
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.serial.then(async () => {
      this.busy = true
      try {
        return await fn()
      } finally {
        this.busy = false
      }
    })
    this.serial = work.catch(() => {})
    return work
  }
  embyUrl() {
    return (this.raw.emby_base_url ?? this.settings.embyUrl).replace(/\/+$/, "")
  }
  embyKey() {
    return this.raw.emby_api_key ?? this.settings.embyKey
  }
  publicConfig(): Config {
    const { emby_api_key: _key, ...config } = this.raw
    return structuredClone({ ...config, emby_base_url: this.embyUrl() })
  }
  owner(channel: number) {
    return (
      [...this.resolved]
        .map(([ref, id]) => (id === channel ? this.bindings.get(ref) : null))
        .find(Boolean) || null
    )
  }
  private async stopScans() {
    for (const [id, source] of this.sources) {
      this.accounts.waits.set(
        "account:" + id,
        Math.max(
          this.accounts.waits.get("account:" + id) || 0,
          source.notBefore
        )
      )
      source.stop()
    }
    await Promise.allSettled(this.scanning.values())
    this.scanning.clear()
    this.sources.clear()
    this.pending.clear()
  }
  async rebuild() {
    this.db.blocked = true
    await this.stopScans()
    this.bindings.clear()
    this.resolved.clear()
    this.scans.clear()
    const records = this.db.records(),
      fallback =
        records.find((r) => r.id === "legacy")?.id || records[0]?.id || null
    const groups = new Map<string | null, Config["channels"]>()
    const channels = new Map<number, string[]>()
    for (const item of this.raw.channels) {
      const ref = reference(item),
        account = item.account_id || fallback
      this.bindings.set(ref, account)
      const stored =
        item.id ??
        Number(
          this.db.sql
            .prepare(
              "SELECT channel_id FROM telegram_channel_ids WHERE reference=?"
            )
            .get(ref)?.channel_id || 0
        )
      if (stored) this.resolved.set(ref, stored)
      if (!groups.has(account)) groups.set(account, [])
      groups.get(account)!.push(item)
      this.scans.set(ref, {
        channel: ref,
        account_id: account,
        status: "waiting",
        last_error: "等待负责账号连接",
        started_at: null,
        finished_at: null,
      })
    }
    let allResolved = true
    for (const [id, items] of groups) {
      const client = id ? this.accounts.clients.get(id) : undefined
      if (!client || !id) {
        allResolved = false
        continue
      }
      const previous = this.accounts.waits.get("account:" + id) || 0
      if (previous > now()) {
        allResolved = false
        continue
      }
      try {
        if (!client.connected) await client.connect()
        if (!(await client.authorized())) {
          this.accounts.errors.set(id, "需要重新登录")
          allResolved = false
          continue
        }
        await client.dialogs()
        const entities = new Map()
        for (const item of items) {
          const ref = reference(item),
            entity = await client.entity(ref)
          if (
            channels.has(entity.id) ||
            entities.has(entity.id) ||
            (item.id !== undefined && entity.id !== item.id)
          )
            throw new ManagementError("多个配置引用同一频道或 ID 不符")
          entities.set(entity.id, entity)
        }
        for (const [index, entity] of [...entities.values()].entries()) {
          const ref = reference(items[index])
          this.resolved.set(ref, entity.id)
          channels.set(entity.id, items[index].series)
          this.db.sql
            .prepare(
              "INSERT INTO telegram_channel_ids(reference,channel_id) VALUES(?,?) ON CONFLICT(reference) DO UPDATE SET channel_id=excluded.channel_id"
            )
            .run(ref, entity.id)
        }
        this.sources.set(id, new Source(client, entities, this.raw, this.db))
        this.accounts.errors.delete(id)
      } catch (error) {
        allResolved = false
        const seconds = floodSeconds(error)
        if (seconds !== undefined)
          this.accounts.waits.set("account:" + id, now() + seconds + 1)
        this.accounts.errors.set(
          id,
          seconds !== undefined
            ? `Telegram 限流 ${seconds}s`
            : error instanceof ManagementError
              ? error.message
              : "频道连接失败，请检查账号权限"
        )
      }
    }
    for (const item of this.raw.channels) {
      const id = this.resolved.get(reference(item))
      if (id !== undefined) channels.set(id, item.series)
    }
    this.db.configure(
      this.raw,
      channels,
      !allResolved || this.resolved.size !== this.raw.channels.length
    )
    this.db.holdSelection()
    for (const source of this.sources.values()) source.register()
    if (this.sources.size && !this.recovered) {
      await this.downloader.recover()
      this.recovered = true
    }
    for (const task of this.db.tasks())
      if (
        ["pending", "retry_wait"].includes(task.status) &&
        !channels.get(task.channel_id)?.includes(task.series_name)
      )
        this.db.update(task, {
          status: "cancelled",
          last_error: "当前频道或作品已移出白名单",
        })
    this.changed = false
    this.nextRound = 0
    this.nextRebuild = now() + 60
  }
  private scheduleScans() {
    const requested = [...this.sources.values()].some((s) => s.requested)
    if (
      requested ||
      (!this.pending.size && !this.scanning.size && now() >= this.nextRound)
    ) {
      this.db.holdSelection()
      this.pending = new Map([...this.db.channels.keys()].map((id) => [id, 0]))
      for (const s of this.sources.values()) {
        s.generation++
        s.requested = false
      }
      this.nextRound = Number.POSITIVE_INFINITY
    }
    for (const [account, source] of this.sources) {
      if (
        this.scanning.has(account) ||
        !source.client.connected ||
        source.notBefore > now()
      )
        continue
      const due = [...this.pending]
        .filter(([id, time]) => source.entities.has(id) && time <= now())
        .sort((a, b) => a[1] - b[1])[0]
      if (!due) continue
      const channel = due[0],
        ref = [...this.resolved].find(([, id]) => id === channel)![0],
        state = this.scans.get(ref)!,
        generation = source.generation
      state.status = "scanning"
      state.started_at = now()
      state.finished_at = null
      state.last_error = null
      const work = source
        .scan(channel)
        .then((result) => {
          if (!source.active || source.generation !== generation) return
          if (source.authorizationError) {
            this.accounts.errors.set(account, "需要重新登录")
            this.changed = true
            this.db.blocked = true
          }
          if (result.completed) this.pending.delete(channel)
          else this.pending.set(channel, now() + result.delay)
          state.status = result.completed ? "completed" : "waiting"
          state.last_error = result.completed ? null : "检查未完成，等待重试"
          state.finished_at = now()
        })
        .finally(() => {
          this.scanning.delete(account)
          if (!this.pending.size && !this.scanning.size)
            this.nextRound = now() + this.raw.scan_interval_seconds
        })
      this.scanning.set(account, work)
    }
  }
  async applyConfig(data: Config, expected: string) {
    checkConfig(data)
    if (expected !== this.version)
      throw new ManagementError("配置已被修改，请刷新后重新编辑", 409)
    if (this.active.size || this.backfillTask)
      throw new ManagementError("请等待在途下载或补扫结束后应用配置", 409)
    const next = structuredClone(data)
    if (next.emby_api_key === undefined)
      next.emby_api_key = this.raw.emby_api_key
    const records = this.db.records(),
      fallback = records.find((r) => r.id === "legacy")?.id || records[0]?.id
    const identities = new Set<number>()
    for (const item of next.channels) {
      const id = item.account_id || fallback,
        client = id ? this.accounts.clients.get(id) : undefined
      if (!client || !id || this.accounts.errors.has(id) || !client.connected)
        throw new ManagementError("频道必须指定可用的已登录账号")
      const entity = await client.entity(reference(item))
      if (
        identities.has(entity.id) ||
        (item.id !== undefined && entity.id !== item.id)
      )
        throw new ManagementError("频道重复或 ID 不符")
      identities.add(entity.id)
      item.account_id = id
    }
    const connectionChanged =
      (next.emby_base_url ?? this.settings.embyUrl).replace(/\/+$/, "") !==
        this.embyUrl() ||
      (next.emby_api_key ?? this.settings.embyKey) !== this.embyKey()
    if (existsSync(this.settings.config))
      atomicWrite(
        this.settings.config.replace(/\.json$/, "") + ".previous.json",
        JSON.stringify(this.raw, null, 2) + "\n"
      )
    atomicWrite(this.settings.config, JSON.stringify(next, null, 2) + "\n")
    this.raw = next
    this.version = version(next)
    if (connectionChanged)
      this.db.sql
        .prepare(
          "UPDATE emby_refresh_state SET requested_generation=requested_generation+1,dirty_since=COALESCE(dirty_since,?),last_completed_at=?,next_retry_at=0,attempts=0,last_error=NULL WHERE id=1 AND requested_generation>0"
        )
        .run(now(), now())
    this.changed = true
    await this.rebuild()
    return { ok: true as const, version: this.version }
  }
  async backfill(since: string, until: string, channel?: number) {
    if (this.backfillTask) throw new ManagementError("已有补扫正在运行", 409)
    if (this.db.blocked || this.changed)
      throw new ManagementError("请先恢复全部负责账号与频道连接", 409)
    if (channel !== undefined && !this.db.channels.has(channel))
      throw new ManagementError("补扫频道必须已配置")
    for (const source of this.sources.values()) source.generation++
    await Promise.allSettled(this.scanning.values())
    this.db.holdSelection()
    this.backfillTask = Promise.all(
      [...this.sources].map(async ([, source]) => {
        for (const id of source.entities.keys()) {
          if (channel !== undefined && id !== channel) continue
          const ref = [...this.resolved].find(([, value]) => value === id)![0],
            state = this.scans.get(ref)!
          state.status = "backfill"
          state.started_at = now()
          state.last_error = null
          while (!this.stopped && source.active) {
            try {
              await source.traverse(
                id,
                0,
                Date.parse(since) / 1000,
                Date.parse(until) / 1000
              )
              state.status = "completed"
              state.finished_at = now()
              break
            } catch (error) {
              const seconds = floodSeconds(error)
              if (seconds === undefined) {
                state.status = "error"
                state.last_error = "补扫失败，请检查连接"
                state.finished_at = now()
                break
              }
              source.flood(seconds)
              state.status = "waiting"
              state.last_error = "Telegram 限流，补扫等待重试"
              while (!this.stopped && source.notBefore > now())
                await new Promise((resolve) => setTimeout(resolve, 1000))
            }
          }
        }
      })
    )
      .then(() => {})
      .finally(() => {
        this.backfillTask = undefined
        this.pending.clear()
        this.nextRound = 0
      })
    return { ok: true as const }
  }
  state(): State {
    const time = now(),
      records = this.db.records()
    const accounts: State["accounts"] = records.map((row) => {
      const client = this.accounts.clients.get(row.id),
        error = this.accounts.errors.get(row.id) || null
      const wait = Math.max(
        this.sources.get(row.id)?.notBefore || 0,
        this.accounts.waits.get("account:" + row.id) || 0
      )
      return {
        id: row.id,
        name: row.name,
        username: row.username,
        phone: row.phone,
        user_id: row.user_id,
        status: this.restoring
          ? "connecting"
          : error === "需要重新登录"
            ? "login_required"
            : wait > time
              ? "waiting"
              : error || !client?.connected
                ? "offline"
                : "online",
        wait_until: wait,
        last_error: error,
        channel_count: [...this.bindings.values()].filter((id) => id === row.id)
          .length,
      }
    })
    const channels = this.raw.channels.map((item) => {
      const ref = reference(item),
        id = this.resolved.get(ref) ?? null,
        account = this.bindings.get(ref) ?? null,
        checkpoint = id === null ? undefined : this.db.getCheckpoint(id),
        scan = this.scans.get(ref)
      return {
        reference: ref,
        id,
        account_id: account,
        series: item.series,
        last_scanned_message_id: checkpoint?.last_scanned_message_id || 0,
        last_success_at: checkpoint?.last_success_at ?? null,
        first_scan_complete: !!checkpoint?.first_scan_complete,
        status: scan?.status || "waiting",
        error:
          (account ? this.accounts.errors.get(account) : null) ||
          scan?.last_error ||
          null,
      }
    })
    const counts = Object.fromEntries(
      this.db.sql
        .prepare(
          "SELECT status,COUNT(*) AS count FROM downloads GROUP BY status"
        )
        .all()
        .map((r) => [r.status, Number(r.count)])
    )
    return {
      now: time,
      counts,
      accounts,
      channels,
      scans: [...this.scans.values()].map((s) => ({ ...s })),
      config: this.publicConfig(),
      version: this.version,
      concurrency: this.raw.download_concurrency,
      selection_ready: this.db.selectionReady(),
      emby: { configured: !!this.embyKey(), ...this.db.refreshState() },
    }
  }
  downloads(input: Filters): Downloads {
    const filters = validateFilters(input),
      channel = filters.channel ? Number(filters.channel) : null
    if (channel !== null && !Number.isSafeInteger(channel))
      throw new ManagementError("频道筛选无效")
    const params = [
      filters.status,
      filters.status,
      filters.status,
      "%" + filters.q + "%",
      "%" + filters.q + "%",
      "%" + filters.q + "%",
      filters.series,
      filters.series,
      channel,
      channel,
    ]
    const where = `WHERE (?='all' OR (?='active' AND status NOT IN ('completed','cancelled')) OR status=?)
      AND (series_name LIKE ? OR CAST(channel_id AS TEXT) LIKE ? OR ('S'||printf('%02d',season)||'E'||printf('%03d',episode)) LIKE ?)
      AND (?='' OR series_name=?) AND (? IS NULL OR channel_id=?)`
    const total = Number(
      this.db.sql
        .prepare("SELECT COUNT(*) AS count FROM downloads " + where)
        .get(...params)!.count
    )
    const rows = this.db.sql
      .prepare(
        "SELECT " +
          DOWNLOAD_COLUMNS +
          " FROM downloads " +
          where +
          " ORDER BY created_at DESC,channel_id,message_id DESC LIMIT 50 OFFSET ?"
      )
      .all(...params, (filters.page - 1) * 50)
    const names = new Map(this.db.records().map((r) => [r.id, r.name]))
    const items = rows.map((row) => {
      const task = row as unknown as ReturnType<Database["tasks"]>[number],
        account = this.owner(task.channel_id)
      let downloaded = task.status === "completed" ? task.expected_size : 0
      if (task.status === "downloading") {
        try {
          downloaded = Math.min(
            task.expected_size,
            lstatSync(this.downloader.tempPath(task)).size
          )
        } catch {
          /* Download may not have created the file yet. */
        }
      }
      return {
        ...task,
        downloaded_bytes: downloaded,
        account_id: account,
        account_name: account ? names.get(account) || null : null,
      }
    })
    return { items, total, page: filters.page, page_size: 50 }
  }
  async write(input: Write): Promise<WriteResult> {
    const data = validateWrite(input)
    return this.exclusive(async () => {
      if (this.restoring)
        throw new ManagementError("正在恢复账号会话，请稍后重试", 409)
      switch (data.action) {
        case "login":
          return this.accounts.begin(data.name, data.phone, data.account_id)
        case "code":
          return this.accounts.step(data.id, "code", data.code)
        case "password":
          return this.accounts.step(data.id, "password", data.password)
        case "resend":
          return this.accounts.step(data.id, "resend")
        case "cancel":
          await this.accounts.cancel(data.id)
          return { ok: true }
        case "logout":
          if ([...this.bindings.values()].includes(data.id))
            throw new ManagementError(
              "请先迁移该账号的负责频道，并等待在途下载结束",
              409
            )
          await this.accounts.logout(data.id)
          return { ok: true }
        case "config":
          return this.applyConfig(data.config, data.version)
        case "scan":
          return this.backfill(data.since, data.until, data.channel)
        case "retry":
          if (!this.db.channels.has(data.channel))
            throw new ManagementError("任务所属频道已移出配置，不能重试", 409)
          return { ok: true, count: this.db.retry(data.channel, data.message) }
      }
    })
  }
  async close() {
    this.stopped = true
    clearInterval(this.timer)
    for (const source of this.sources.values()) source.stop()
    await Promise.allSettled([
      this.restoreTask,
      this.serial,
      ...this.active,
      ...this.scanning.values(),
      ...(this.backfillTask ? [this.backfillTask] : []),
      ...(this.refreshTask ? [this.refreshTask] : []),
    ])
    await this.accounts.close()
    this.db.close()
    this.instanceLock.close()
  }
}
// Nitro plugins and Start handlers can bundle this module separately; share one process runtime.
const processState = globalThis as typeof globalThis & {
  __relayRuntime?: Promise<ManagementRuntime>
}
export function getRuntime() {
  processState.__relayRuntime ??= (async () => {
    const runtime = new ManagementRuntime(settingsFromEnv())
    try {
      await runtime.start()
      return runtime
    } catch (error) {
      await runtime.close()
      throw error
    }
  })().catch((error) => {
    processState.__relayRuntime = undefined
    throw error
  })
  return processState.__relayRuntime
}
export async function closeRuntime() {
  if (processState.__relayRuntime)
    await (await processState.__relayRuntime).close()
  processState.__relayRuntime = undefined
}
