import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { existsSync, unlinkSync } from "node:fs"
import { ManagementError, now } from "./config.ts"
import { floodSeconds, rpcName } from "./telegram.ts"
import type { Settings } from "./config.ts"
import type { Database } from "./database.ts"
import type { Transport, TransportFactory, SentCode } from "./telegram.ts"
import type { Login } from "../lib/types.ts"

type Flow = Login & {
  name: string
  phone: string
  hash: string
  path: string
  client: Transport
}
export class AccountManager {
  clients = new Map<string, Transport>()
  errors = new Map<string, string>()
  flows = new Map<string, Flow>()
  waits = new Map<string, number>()
  private db: Database
  private settings: Settings
  private factory: TransportFactory
  private changed: () => void
  constructor(
    db: Database,
    settings: Settings,
    factory: TransportFactory,
    changed: () => void
  ) {
    this.db = db
    this.settings = settings
    this.factory = factory
    this.changed = changed
  }
  publicFlow(f: Flow): Login {
    return {
      id: f.id,
      state: f.state,
      delivery: f.delivery,
      resend_at: f.resend_at,
      expires_at: f.expires_at,
      ...(f.account_id ? { account_id: f.account_id } : {}),
    }
  }
  async restore() {
    for (const record of this.db.records()) {
      try {
        const client = await this.factory(record.session_path, this.settings)
        this.clients.set(record.id, client)
        await client.connect()
        if (!(await client.authorized()))
          this.errors.set(record.id, "需要重新登录")
      } catch {
        this.errors.set(record.id, "会话不可用，请检查连接或重新登录")
      }
    }
    if (
      !this.db.records().length &&
      (existsSync(this.settings.session) ||
        existsSync(this.settings.session + ".string"))
    ) {
      let client: Transport | undefined
      try {
        client = await this.factory(this.settings.session, this.settings)
        await client.connect()
        if (await client.authorized()) {
          await this.saveAccount(
            "legacy",
            "原有账号",
            client,
            this.settings.session
          )
          this.clients.set("legacy", client)
          client = undefined
        }
      } catch {
        /* Retain the original session for an explicit relogin. */
      } finally {
        await client?.disconnect()
      }
    }
    this.changed()
  }
  async saveAccount(id: string, name: string, client: Transport, path: string) {
    const user = await client.me()
    if (user.bot || !Number.isSafeInteger(user.id))
      throw new ManagementError("必须登录 Telegram 用户账号")
    const old = this.db.records().find((r) => r.id === id),
      previous = this.db.records().find((r) => r.user_id === user.id)
    if (old && old.user_id !== user.id)
      throw new ManagementError("重新登录必须使用原 Telegram 账号", 409)
    if (previous && previous.id !== id)
      throw new ManagementError("该 Telegram 账号已经添加", 409)
    await client.save()
    const masked = user.phone
      ? "+" +
        user.phone.replace(/^\+/, "").slice(0, 2) +
        " *** " +
        user.phone.slice(-4)
      : "未提供"
    this.db.sql
      .prepare(
        `INSERT INTO telegram_accounts(id,user_id,name,username,phone,session_path) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,name=excluded.name,username=excluded.username,phone=excluded.phone,session_path=excluded.session_path`
      )
      .run(id, user.id, name, user.username, masked, path)
  }
  async begin(name: string, phone: string, accountId?: string) {
    await this.expire()
    if (accountId) {
      if (!this.db.records().some((r) => r.id === accountId))
        throw new ManagementError("账号不存在", 404)
      if (this.clients.get(accountId)?.connected && !this.errors.has(accountId))
        throw new ManagementError("账号已有会话，无需重新登录", 409)
    }
    if ((this.waits.get(phone) || 0) > now())
      throw new ManagementError(
        "Telegram 要求等待后再登录",
        429,
        this.waits.get(phone)
      )
    if (
      this.flows.size >= 5 ||
      [...this.flows.values()].some(
        (f) => f.phone === phone || (accountId && f.account_id === accountId)
      )
    )
      throw new ManagementError("已有登录流程或同时登录流程过多", 409)
    const id = randomBytes(24).toString("base64url"),
      path = join(
        dirname(this.settings.session),
        "accounts",
        randomBytes(16).toString("hex"),
        "telegram.session"
      )
    const client = await this.factory(path, this.settings)
    const flow: Flow = {
      id,
      state: "code",
      delivery: "Telegram",
      resend_at: 0,
      expires_at: now() + 300,
      account_id: accountId,
      name: name.trim(),
      phone,
      hash: "",
      path,
      client,
    }
    this.flows.set(id, flow)
    try {
      await client.connect()
      return this.sent(flow, await client.sendCode(phone))
    } catch (error) {
      await this.cancel(id)
      throw this.loginError(error, phone)
    }
  }
  sent(flow: Flow, sent: SentCode) {
    flow.hash = sent.hash
    flow.delivery = sent.delivery
    flow.resend_at = now() + Math.max(30, sent.timeout)
    flow.expires_at = now() + 300
    flow.state = "code"
    return this.publicFlow(flow)
  }
  async step(
    id: string,
    action: "code" | "password" | "resend",
    value?: string
  ) {
    const flow = this.flows.get(id)
    if (!flow)
      throw new ManagementError("登录流程已结束或不存在，请重新发起", 404)
    if (flow.expires_at <= now())
      throw new ManagementError("登录流程已过期，请重新发起", 409)
    if ((this.waits.get(flow.phone) || 0) > now())
      throw new ManagementError(
        "Telegram 限流，请等待后重试",
        429,
        this.waits.get(flow.phone)
      )
    if (action !== "resend" && action !== flow.state)
      throw new ManagementError("登录步骤不符", 409)
    try {
      if (action === "resend") {
        if (flow.state !== "code" || flow.resend_at > now())
          throw new ManagementError("尚不能重发验证码", 429, flow.resend_at)
        return this.sent(
          flow,
          await flow.client.sendCode(flow.phone, flow.hash)
        )
      }
      if (action === "code")
        await flow.client.signIn(flow.phone, flow.hash, value!)
      else await flow.client.password(value!)
      const accountId = flow.account_id || randomBytes(16).toString("hex")
      await this.saveAccount(accountId, flow.name, flow.client, flow.path)
      await this.clients.get(accountId)?.disconnect()
      this.clients.set(accountId, flow.client)
      this.errors.delete(accountId)
      flow.state = "completed"
      flow.account_id = accountId
      this.flows.delete(id)
      this.changed()
      return this.publicFlow(flow)
    } catch (error) {
      if (rpcName(error).includes("SESSION_PASSWORD_NEEDED")) {
        flow.state = "password"
        return this.publicFlow(flow)
      }
      if (rpcName(error).includes("PHONE_CODE_EXPIRED")) flow.resend_at = 0
      throw this.loginError(error, flow.phone)
    }
  }
  loginError(error: unknown, phone: string) {
    if (error instanceof ManagementError) return error
    const seconds = floodSeconds(error)
    if (seconds !== undefined) {
      const until = now() + seconds + 1
      this.waits.set(phone, until)
      return new ManagementError("Telegram 限流，请等待后重试", 429, until)
    }
    if (/PHONE_CODE_INVALID|PASSWORD_HASH_INVALID/.test(rpcName(error)))
      return new ManagementError("验证码或两步验证密码错误")
    if (/PHONE_CODE_EXPIRED/.test(rpcName(error)))
      return new ManagementError("验证码已过期，请重发")
    return new ManagementError("Telegram 登录失败，请核对输入或稍后重试", 503)
  }
  removeSession(path: string) {
    for (const suffix of [".string", "", "-journal", "-wal", "-shm"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix)
  }
  async cancel(id: string) {
    const flow = this.flows.get(id)
    if (!flow) return
    await flow.client.disconnect()
    this.flows.delete(id)
    this.removeSession(flow.path)
  }
  async expire() {
    for (const flow of [...this.flows.values()])
      if (flow.expires_at <= now()) await this.cancel(flow.id)
    for (const [phone, until] of this.waits)
      if (until <= now()) this.waits.delete(phone)
  }
  async logout(id: string) {
    const record = this.db.records().find((r) => r.id === id)
    if (!record) throw new ManagementError("账号不存在", 404)
    const client = this.clients.get(id)
    if (client) {
      try {
        if (this.errors.get(id) !== "需要重新登录") await client.logout()
      } catch (error) {
        if (!/AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED/.test(rpcName(error)))
          throw new ManagementError("退出 Telegram 会话失败，请稍后重试", 503)
      }
      await client.disconnect()
    }
    this.db.sql.prepare("DELETE FROM telegram_accounts WHERE id=?").run(id)
    this.clients.delete(id)
    this.errors.delete(id)
    this.removeSession(record.session_path)
    this.changed()
  }
  async close() {
    for (const id of [...this.flows.keys()]) await this.cancel(id)
    await Promise.allSettled(
      [...this.clients.values()].map((c) => c.disconnect())
    )
    this.clients.clear()
  }
}
