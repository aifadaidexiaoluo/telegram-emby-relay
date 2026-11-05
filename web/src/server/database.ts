import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { now } from "./config.ts"
import type { Candidate } from "./config.ts"
import type { Config } from "../lib/types.ts"

export const DOWNLOAD_COLUMNS =
  "channel_id,message_id,series_name,CAST(document_id AS TEXT) AS document_id,expected_size,season,episode,extension,status,attempts,next_retry_at,final_path,last_error,created_at,updated_at,published_at"
export type Download = Candidate & {
  status: string
  attempts: number
  next_retry_at: number
  final_path: string | null
  last_error: string | null
  created_at: number
  updated_at: number
}
export type AccountRecord = {
  id: string
  user_id: number
  name: string
  username: string | null
  phone: string
  session_path: string
}
export type Checkpoint = {
  channel_id: number
  initial_since: number
  last_scanned_message_id: number
  last_success_at: number | null
  first_scan_complete: number
}
export type RefreshState = {
  requested_generation: number
  acknowledged_generation: number
  dirty_since: number | null
  last_completed_at: number | null
  next_retry_at: number
  attempts: number
  last_error: string | null
}
export class Database {
  sql: DatabaseSync
  limits = new Map<string, number>()
  channels = new Map<number, string[]>()
  categories = new Map<string, string>()
  blocked = true
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.sql = new DatabaseSync(path)
    this.sql.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS downloads (
        channel_id INTEGER NOT NULL, message_id INTEGER NOT NULL, series_name TEXT NOT NULL,
        document_id INTEGER NOT NULL, expected_size INTEGER NOT NULL CHECK(expected_size>0),
        season INTEGER NOT NULL, episode INTEGER, extension TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','downloading','retry_wait','failed','completed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, next_retry_at REAL NOT NULL DEFAULT 0, final_path TEXT, last_error TEXT,
        created_at REAL NOT NULL, updated_at REAL NOT NULL, published_at REAL NOT NULL DEFAULT 0,
        matched INTEGER NOT NULL DEFAULT 1 CHECK(matched IN (0,1)),
        PRIMARY KEY(channel_id,message_id));
      CREATE INDEX IF NOT EXISTS downloads_ready ON downloads(status,next_retry_at,created_at);
      CREATE TABLE IF NOT EXISTS channel_checkpoints (channel_id INTEGER PRIMARY KEY, initial_since REAL NOT NULL,
        last_scanned_message_id INTEGER NOT NULL DEFAULT 0, last_success_at REAL, first_scan_complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS emby_refresh_state (id INTEGER PRIMARY KEY CHECK(id=1),
        requested_generation INTEGER NOT NULL DEFAULT 0, acknowledged_generation INTEGER NOT NULL DEFAULT 0,
        dirty_since REAL, last_completed_at REAL, next_retry_at REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
      INSERT OR IGNORE INTO emby_refresh_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS telegram_accounts (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL, username TEXT, phone TEXT NOT NULL, session_path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_channel_ids (reference TEXT PRIMARY KEY, channel_id INTEGER NOT NULL);
    `)
    for (const [table, name, definition] of [
      ["downloads", "published_at", "REAL NOT NULL DEFAULT 0"],
      [
        "downloads",
        "matched",
        "INTEGER NOT NULL DEFAULT 1 CHECK(matched IN (0,1))",
      ],
      [
        "channel_checkpoints",
        "first_scan_complete",
        "INTEGER NOT NULL DEFAULT 0",
      ],
    ]) {
      if (
        !this.sql
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((r) => r.name === name)
      )
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
    }
  }
  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE")
    try {
      const result = fn()
      this.sql.exec("COMMIT")
      return result
    } catch (error) {
      this.sql.exec("ROLLBACK")
      throw error
    }
  }
  records() {
    return this.sql
      .prepare("SELECT * FROM telegram_accounts ORDER BY rowid")
      .all() as AccountRecord[]
  }
  tasks() {
    return this.sql
      .prepare("SELECT " + DOWNLOAD_COLUMNS + " FROM downloads")
      .all() as Download[]
  }
  checkpoint(channel: number, since: number) {
    this.sql
      .prepare(
        "INSERT OR IGNORE INTO channel_checkpoints(channel_id,initial_since) VALUES(?,?)"
      )
      .run(channel, since)
    return this.getCheckpoint(channel)!
  }
  getCheckpoint(channel: number) {
    return this.sql
      .prepare("SELECT * FROM channel_checkpoints WHERE channel_id=?")
      .get(channel) as Checkpoint | undefined
  }
  configure(config: Config, channels: Map<number, string[]>, blocked: boolean) {
    this.categories = new Map(
      config.series.map((rule) => [rule.name, rule.category ?? "TV"])
    )
    this.limits = new Map(
      config.series
        .filter((r) => r.latest_episodes)
        .map((r) => [r.name, r.latest_episodes!])
    )
    this.channels = channels
    this.blocked = blocked
    this.transaction(() => {
      if (this.limits.size)
        this.sql
          .prepare(
            "UPDATE channel_checkpoints SET initial_since=0,last_scanned_message_id=0,first_scan_complete=0 WHERE initial_since>0 AND channel_id IN (SELECT value FROM json_each(?))"
          )
          .run(JSON.stringify([...channels.keys()]))
      this.selectLatest()
    })
  }
  selectionReady() {
    return (
      !this.blocked &&
      this.channels.size > 0 &&
      [...this.channels.keys()].every(
        (c) => this.getCheckpoint(c)?.first_scan_complete === 1
      )
    )
  }
  selectLatest() {
    const ready = this.selectionReady()
    for (const [name, limit] of this.limits) {
      const channels = [...this.channels]
        .filter(([, names]) => names.includes(name))
        .map(([id]) => id)
      const selected: [number, number][] = [],
        episodes = new Set<string>()
      if (ready && channels.length) {
        const rows = this.sql
          .prepare(
            `SELECT channel_id,message_id,season,episode FROM downloads WHERE series_name=? AND episode IS NOT NULL AND matched=1
          AND channel_id IN (SELECT value FROM json_each(?)) ORDER BY season DESC,episode DESC,
          CASE status WHEN 'completed' THEN 0 WHEN 'downloading' THEN 1 WHEN 'pending' THEN 2 WHEN 'retry_wait' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END,
          published_at DESC,channel_id,message_id DESC`
          )
          .all(name, JSON.stringify(channels))
        for (const row of rows) {
          const key = `${row.season}:${row.episode}`
          if (!episodes.has(key)) {
            episodes.add(key)
            selected.push([Number(row.channel_id), Number(row.message_id)])
            if (episodes.size === limit) break
          }
        }
      }
      this.sql
        .prepare(
          `UPDATE downloads SET status='cancelled',last_error='不在最新剧集选择中',updated_at=? WHERE series_name=?
        AND status IN ('pending','retry_wait') AND json_array(channel_id,message_id) NOT IN (SELECT json(value) FROM json_each(?))`
        )
        .run(now(), name, JSON.stringify(selected))
      for (const [channel, message] of selected)
        this.sql
          .prepare(
            "UPDATE downloads SET status='pending',last_error=NULL,updated_at=? WHERE channel_id=? AND message_id=? AND status='cancelled'"
          )
          .run(now(), channel, message)
    }
  }
  holdSelection(channel?: number) {
    if (!this.limits.size) return
    this.transaction(() => {
      this.sql
        .prepare(
          "UPDATE channel_checkpoints SET first_scan_complete=0 WHERE channel_id IN (SELECT value FROM json_each(?))"
        )
        .run(
          JSON.stringify(
            channel === undefined ? [...this.channels.keys()] : [channel]
          )
        )
      this.selectLatest()
    })
  }
  finishScan(channel: number) {
    this.transaction(() => {
      this.sql
        .prepare(
          "UPDATE channel_checkpoints SET first_scan_complete=1 WHERE channel_id=?"
        )
        .run(channel)
      this.selectLatest()
    })
  }
  enqueue(
    tasks: Candidate[],
    channel?: number,
    cursor?: number,
    rejected: number[] = []
  ) {
    return this.transaction(() => {
      if (rejected.length) {
        if (channel === undefined) throw new Error("撤销候选必须指定频道")
        this.sql
          .prepare(
            `UPDATE downloads SET matched=0,status='cancelled',last_error='不符合当前关键词或排除规则',updated_at=?
          WHERE channel_id=? AND message_id IN (SELECT value FROM json_each(?)) AND status NOT IN ('completed','downloading')`
          )
          .run(now(), channel, JSON.stringify(rejected))
      }
      let count = 0
      for (const t of tasks) {
        count += Number(
          this.sql
            .prepare(
              `INSERT INTO downloads(channel_id,message_id,series_name,document_id,expected_size,season,episode,extension,published_at,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,message_id) DO UPDATE SET
          series_name=excluded.series_name,document_id=excluded.document_id,expected_size=excluded.expected_size,
          status=excluded.status,attempts=0,next_retry_at=0,last_error=NULL,matched=1
          WHERE downloads.status NOT IN ('completed','downloading') AND
          (downloads.series_name!=excluded.series_name OR downloads.document_id!=excluded.document_id OR downloads.matched=0)`
            )
            .run(
              t.channel_id,
              t.message_id,
              t.series_name,
              BigInt(t.document_id),
              t.expected_size,
              t.season,
              t.episode,
              t.extension,
              t.published_at,
              this.limits.has(t.series_name) ? "cancelled" : "pending",
              now(),
              now()
            ).changes
        )
        this.sql
          .prepare(
            `UPDATE downloads SET season=?,episode=?,extension=?,expected_size=?,published_at=?,updated_at=? WHERE channel_id=? AND message_id=? AND document_id=? AND series_name=? AND status NOT IN ('completed','downloading')`
          )
          .run(
            t.season,
            t.episode,
            t.extension,
            t.expected_size,
            t.published_at,
            now(),
            t.channel_id,
            t.message_id,
            BigInt(t.document_id),
            t.series_name
          )
        if (!this.limits.has(t.series_name))
          this.sql
            .prepare(
              "UPDATE downloads SET status='pending',attempts=0,next_retry_at=0,last_error=NULL WHERE channel_id=? AND message_id=? AND document_id=? AND series_name=? AND status='cancelled'"
            )
            .run(
              t.channel_id,
              t.message_id,
              BigInt(t.document_id),
              t.series_name
            )
      }
      if (cursor !== undefined)
        this.sql
          .prepare(
            "UPDATE channel_checkpoints SET last_scanned_message_id=MAX(last_scanned_message_id,?),last_success_at=? WHERE channel_id=?"
          )
          .run(cursor, now(), channel!)
      if (tasks.length) this.selectLatest()
      return count
    })
  }
  claim(channels: number[]) {
    if (!channels.length) return undefined
    return this.transaction(() => {
      this.selectLatest()
      const task = this.sql
        .prepare(
          `SELECT ${DOWNLOAD_COLUMNS} FROM downloads WHERE matched=1 AND status IN ('pending','retry_wait') AND next_retry_at<=?
        AND channel_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,channel_id,message_id LIMIT 1`
        )
        .get(now(), JSON.stringify(channels)) as Download | undefined
      if (task) this.update(task, { status: "downloading" })
      return task
    })
  }
  update(
    task: Candidate,
    values: Partial<
      Pick<
        Download,
        "status" | "attempts" | "next_retry_at" | "final_path" | "last_error"
      >
    >
  ) {
    const entries = Object.entries(values)
    if (
      !entries.length ||
      entries.some(
        ([k]) =>
          ![
            "status",
            "attempts",
            "next_retry_at",
            "final_path",
            "last_error",
          ].includes(k)
      )
    )
      throw new Error("无效任务字段")
    this.sql
      .prepare(
        `UPDATE downloads SET ${entries.map(([k]) => `${k}=?`).join(",")},updated_at=? WHERE channel_id=? AND message_id=?`
      )
      .run(
        ...entries.map(([, v]) => v ?? null),
        now(),
        task.channel_id,
        task.message_id
      )
  }
  completed(task: Candidate, path: string) {
    this.transaction(() => {
      const result = this.sql
        .prepare(
          "UPDATE downloads SET status='completed',final_path=?,last_error=NULL,updated_at=? WHERE channel_id=? AND message_id=? AND status!='completed'"
        )
        .run(path, now(), task.channel_id, task.message_id)
      if (result.changes)
        this.sql
          .prepare(
            "UPDATE emby_refresh_state SET requested_generation=requested_generation+1,dirty_since=COALESCE(dirty_since,?),last_completed_at=? WHERE id=1"
          )
          .run(now(), now())
    })
  }
  refreshState() {
    return this.sql
      .prepare("SELECT * FROM emby_refresh_state WHERE id=1")
      .get() as RefreshState
  }
  acknowledge(generation: number) {
    this.sql
      .prepare(
        "UPDATE emby_refresh_state SET acknowledged_generation=MAX(acknowledged_generation,?),dirty_since=CASE WHEN requested_generation<=? THEN NULL ELSE dirty_since END,next_retry_at=0,attempts=0,last_error=NULL WHERE id=1"
      )
      .run(generation, generation)
  }
  retryRefresh(seconds: number, reason: string) {
    this.sql
      .prepare(
        "UPDATE emby_refresh_state SET next_retry_at=?,attempts=attempts+1,last_error=? WHERE id=1"
      )
      .run(now() + seconds, reason)
  }
  retry(channel: number, message: number) {
    return this.transaction(() => {
      const result = this.sql
        .prepare(
          "UPDATE downloads SET status='pending',attempts=0,next_retry_at=0,last_error=NULL WHERE channel_id=? AND message_id=? AND status='failed' AND matched=1"
        )
        .run(channel, message)
      this.selectLatest()
      return Number(result.changes)
    })
  }
  close() {
    this.sql.close()
  }
}
