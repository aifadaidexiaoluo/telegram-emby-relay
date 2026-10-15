import { match, now } from "./config.ts"
import { floodSeconds, rpcName } from "./telegram.ts"
import type { Config } from "../lib/types.ts"
import type { MediaMessage } from "./config.ts"
import type { Database } from "./database.ts"
import type { Transport, TelegramEntity } from "./telegram.ts"

export class Source {
  active = true
  notBefore = 0
  generation = 0
  requested = false
  authorizationError = false
  unsubscribe = () => {}
  client: Transport
  entities: Map<number, TelegramEntity>
  private config: Config
  private db: Database
  constructor(
    client: Transport,
    entities: Map<number, TelegramEntity>,
    config: Config,
    db: Database
  ) {
    this.client = client
    this.entities = entities
    this.config = config
    this.db = db
  }
  flood(seconds: number) {
    this.notBefore = Math.max(this.notBefore, now() + seconds + 1)
  }
  check() {
    if (!this.active) throw new Error("扫描已停止")
    if (this.notBefore > now())
      throw Object.assign(new Error("FLOOD_WAIT"), {
        seconds: Math.ceil(this.notBefore - now()),
        name: "FloodWaitError",
      })
  }
  ingest(channel: number, messages: MediaMessage[], cursor?: number) {
    if (!this.active) return
    const album = messages.some((m) => m.groupedId)
      ? messages.map((m) => m.text).join(" ")
      : ""
    this.db.enqueue(
      messages
        .map((m) =>
          match(
            this.config,
            channel,
            this.db.channels.get(channel) || [],
            m,
            album
          )
        )
        .filter((t) => t !== null),
      channel,
      cursor
    )
  }
  async groupContext(channel: number, value: MediaMessage) {
    if (!value.groupedId) return [value]
    this.check()
    // shortcut: 相册只补取前后 20 个消息 ID，非连续特殊相册需扩大窗口。
    const siblings = await this.client.messages(
      this.entities.get(channel)!,
      Array.from({ length: 41 }, (_, i) => value.id - 20 + i).filter(
        (id) => id > 0
      )
    )
    return [
      ...new Map(
        [...siblings.filter((m) => m.groupedId === value.groupedId), value].map(
          (m) => [m.id, m]
        )
      ).values(),
    ].sort((a, b) => a.id - b.id)
  }
  register() {
    this.unsubscribe = this.client.subscribe(
      [...this.entities.values()],
      async (channel, messages, edited) => {
        if (!this.active || !this.entities.has(channel)) return
        try {
          this.ingest(
            channel,
            edited ? await this.groupContext(channel, messages[0]) : messages
          )
        } catch (error) {
          const seconds = floodSeconds(error)
          if (seconds !== undefined) this.flood(seconds)
          this.requested = true
        }
      }
    )
  }
  stop() {
    this.active = false
    this.unsubscribe()
  }
  async traverse(
    channel: number,
    cursor = 0,
    since?: number,
    until?: number,
    checkpoint = false
  ) {
    this.check()
    const entity = this.entities.get(channel)!,
      latest = await this.client.messages(entity)
    const upper = latest[0]?.id || cursor
    let pending: MediaMessage[] = [],
      first = true,
      last = cursor
    const flush = async () => {
      if (!pending.length) return
      let group = pending
      if (group[0].groupedId && first && (cursor || since))
        group = [
          ...new Map(
            [...(await this.groupContext(channel, group[0])), ...group].map(
              (m) => [m.id, m]
            )
          ).values(),
        ]
      first = false
      group = group.filter(
        (m) =>
          (since === undefined || m.date >= since) &&
          (until === undefined || m.date < until)
      )
      this.check()
      this.ingest(
        channel,
        group,
        checkpoint ? Math.max(...pending.map((m) => m.id)) : undefined
      )
      pending = []
    }
    for await (const value of this.client.history(entity, cursor, since)) {
      this.check()
      if (value.id > upper || (until !== undefined && value.date >= until))
        break
      if (
        pending.length &&
        (!value.groupedId || pending[0].groupedId !== value.groupedId)
      )
        await flush()
      pending.push(value)
      last = value.id
      if (!value.groupedId) await flush()
    }
    await flush()
    this.check()
    if (checkpoint) this.db.enqueue([], channel, Math.max(last, upper))
  }
  async scan(channel: number) {
    const generation = this.generation
    try {
      this.db.holdSelection(channel)
      const checkpoint = this.db.checkpoint(
        channel,
        this.db.limits.size
          ? 0
          : now() - this.config.initial_history_days * 86400
      )
      await this.traverse(
        channel,
        checkpoint.last_scanned_message_id,
        checkpoint.initial_since,
        undefined,
        true
      )
      await this.traverse(
        channel,
        0,
        now() - this.config.edit_lookback_hours * 3600
      )
      if (this.active && generation === this.generation && !this.requested) {
        this.db.finishScan(channel)
        return { completed: true, delay: this.config.scan_interval_seconds }
      }
      return { completed: false, delay: 0 }
    } catch (error) {
      const seconds = floodSeconds(error)
      if (seconds !== undefined) {
        this.flood(seconds)
        return { completed: false, delay: seconds + 1 }
      }
      if (
        /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(
          rpcName(error)
        )
      )
        this.authorizationError = true
      return { completed: false, delay: 60 }
    }
  }
}
