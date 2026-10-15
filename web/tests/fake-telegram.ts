import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { ManagementError } from "../src/server/config.ts"
import type { MediaMessage } from "../src/server/config.ts"
import type { Transport, TransportFactory } from "../src/server/telegram.ts"

export const PRIMARY = -1001234567890
export const SECONDARY = -1009876543210
export const mediaMessage = (
  id: number,
  text: string,
  date = Date.now() / 1000
): MediaMessage => ({
  id,
  text,
  date,
  document: {
    id: "922337203685470000" + id,
    size: 4,
    mime: "video/mp4",
    filename: "video.mp4",
    video: true,
  },
})
export class FakeTransport implements Transport {
  connected = false
  loggedIn = false
  userId = 0
  phone = ""
  requiresPassword = false
  private signedCode = false
  data = new Map<number, MediaMessage[]>([
    [PRIMARY, [mediaMessage(1, "吞噬星空 第157集")]],
    [SECONDARY, [mediaMessage(2, "吞噬星空 第158集")]],
  ])
  callback?: (
    channel: number,
    messages: MediaMessage[],
    edited: boolean
  ) => Promise<void>
  path: string
  constructor(path: string) {
    this.path = path
    if (existsSync(path + ".string")) {
      const saved = JSON.parse(readFileSync(path + ".string", "utf8"))
      this.userId = saved.userId
      this.phone = saved.phone
      this.loggedIn = true
    }
  }
  async connect() {
    this.connected = true
  }
  async authorized() {
    return this.loggedIn
  }
  async disconnect() {
    this.connected = false
  }
  async sendCode(phone: string) {
    this.phone = phone
    this.userId = phone.endsWith("123") ? 1 : 2
    this.requiresPassword = this.userId === 1
    return { hash: "test-hash", delivery: "Telegram 客户端", timeout: 30 }
  }
  async signIn(_phone: string, _hash: string, code: string) {
    if (code !== "55555") throw new Error("PHONE_CODE_INVALID")
    this.signedCode = true
    if (this.requiresPassword) throw new Error("SESSION_PASSWORD_NEEDED")
    this.loggedIn = true
  }
  async password(value: string) {
    if (!this.signedCode || value !== "correct")
      throw new Error("PASSWORD_HASH_INVALID")
    this.loggedIn = true
  }
  async me() {
    return {
      id: this.userId,
      username: "test" + this.userId,
      phone: this.phone,
      bot: false,
    }
  }
  async logout() {
    this.loggedIn = false
  }
  async save() {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(
      this.path + ".string",
      JSON.stringify({ userId: this.userId, phone: this.phone }),
      { mode: 0o600 }
    )
  }
  async dialogs() {}
  async entity(reference: string) {
    const id = reference === "@fixtureprimary" ? PRIMARY : Number(reference)
    if (!this.data.has(id)) throw new ManagementError("账号无法访问该频道")
    return { id }
  }
  async messages(entity: { id: number }, ids?: number[], limit = 1) {
    const data = this.data.get(entity.id) || []
    return ids
      ? data.filter((m) => ids.includes(m.id))
      : [...data].sort((a, b) => b.id - a.id).slice(0, limit)
  }
  async *history(entity: { id: number }, cursor: number, since?: number) {
    for (const value of this.data.get(entity.id) || [])
      if (value.id > cursor && (since === undefined || value.date >= since))
        yield value
  }
  async download(_entity: { id: number }, _id: number, path: string) {
    writeFileSync(path, "data")
  }
  subscribe(
    _entities: { id: number }[],
    callback: (
      channel: number,
      messages: MediaMessage[],
      edited: boolean
    ) => Promise<void>
  ) {
    this.callback = callback
    return () => {
      this.callback = undefined
    }
  }
}
export const fakeFactory: TransportFactory = async (path) =>
  new FakeTransport(path)
