import { Api, TelegramClient, utils, password, events } from "teleproto"
import { StringSession } from "teleproto/sessions"
import { AuthKey } from "teleproto/crypto/AuthKey.js"
import { LogLevel } from "teleproto/extensions/Logger.js"
import { DatabaseSync } from "node:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { atomicWrite, ManagementError } from "./config.ts"
import type { MediaMessage, Settings } from "./config.ts"

export type TelegramUser = {
  id: number
  username: string | null
  phone: string
  bot: boolean
}
export type TelegramEntity = { id: number; native?: Api.Channel }
export type SentCode = { hash: string; delivery: string; timeout: number }
export interface Transport {
  connected: boolean
  connect: () => Promise<void>
  authorized: () => Promise<boolean>
  disconnect: () => Promise<void>
  sendCode: (phone: string, hash?: string) => Promise<SentCode>
  signIn: (phone: string, hash: string, code: string) => Promise<void>
  password: (value: string) => Promise<void>
  me: () => Promise<TelegramUser>
  logout: () => Promise<void>
  save: () => Promise<void>
  dialogs: () => Promise<void>
  entity: (reference: string) => Promise<TelegramEntity>
  messages: (
    entity: TelegramEntity,
    ids?: number[],
    limit?: number
  ) => Promise<MediaMessage[]>
  history: (
    entity: TelegramEntity,
    cursor: number,
    since?: number
  ) => AsyncIterable<MediaMessage>
  download: (
    entity: TelegramEntity,
    id: number,
    path: string,
    expected: { id: string; size: number }
  ) => Promise<void>
  subscribe: (
    entities: TelegramEntity[],
    callback: (
      channel: number,
      messages: MediaMessage[],
      edited: boolean
    ) => Promise<void>
  ) => () => void
}
export type TransportFactory = (
  path: string,
  settings: Settings
) => Promise<Transport>
export async function loadSession(path: string) {
  if (existsSync(path + ".string"))
    return new StringSession(readFileSync(path + ".string", "utf8").trim())
  const session = new StringSession("")
  if (!existsSync(path)) return session
  // Read the original Telethon SQLite session without changing its schema or auth key.
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db
      .prepare(
        "SELECT dc_id,server_address,port,auth_key FROM sessions WHERE auth_key IS NOT NULL LIMIT 1"
      )
      .get()
    if (!row) return session
    session.setDC(
      Number(row.dc_id),
      String(row.server_address),
      Number(row.port)
    )
    const key = new AuthKey()
    await key.setKey(Buffer.from(row.auth_key as Uint8Array))
    session.authKey = key
    atomicWrite(path + ".string", session.save())
    return session
  } finally {
    db.close()
  }
}
function message(value: Api.Message): MediaMessage {
  const doc = value.document
  const document = doc instanceof Api.Document ? doc : undefined
  const filename = document?.attributes.find(
    (a) => a instanceof Api.DocumentAttributeFilename
  )
  return {
    id: value.id,
    text: value.message || "",
    date: value.date,
    groupedId: value.groupedId?.toString(),
    document: document
      ? {
          id: document.id.toString(),
          size: Number(document.size.toString()),
          mime: document.mimeType,
          filename:
            filename instanceof Api.DocumentAttributeFilename
              ? filename.fileName
              : "",
          video: document.attributes.some(
            (a) => a instanceof Api.DocumentAttributeVideo
          ),
        }
      : undefined,
  }
}
export const createTransport: TransportFactory = async (path, settings) => {
  if (
    !Number.isSafeInteger(settings.apiId) ||
    settings.apiId <= 0 ||
    !settings.apiHash
  )
    throw new ManagementError("请在服务端配置 TG_API_ID 和 TG_API_HASH", 503)
  const session = await loadSession(path)
  const client = new TelegramClient(session, settings.apiId, settings.apiHash, {
    floodSleepThreshold: 0,
    connectionRetries: 3,
    // Allow teleproto to retry auth requests after PHONE_MIGRATE DC switching.
    requestRetries: 3,
    autoReconnect: true,
    timeout: 15,
  })
  const invoke = <TRequest extends Api.AnyRequest>(request: TRequest) =>
    client.invoke(request, undefined, { timeout: 30000 })
  client.setLogLevel(LogLevel.WARN)
  return {
    get connected() {
      return !!client.connected
    },
    async connect() {
      await client.connect()
    },
    authorized: () => client.checkAuthorization(),
    async disconnect() {
      await client.destroy()
    },
    async sendCode(phone, hash) {
      const sent = hash
        ? await invoke(
            new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash: hash })
          )
        : await invoke(
            new Api.auth.SendCode({
              phoneNumber: phone,
              apiId: settings.apiId,
              apiHash: settings.apiHash,
              settings: new Api.CodeSettings({}),
            })
          )
      if (!(sent instanceof Api.auth.SentCode))
        throw new ManagementError("Telegram 未返回可用验证码，请重新发起登录")
      if (
        sent.type instanceof Api.auth.SentCodeTypeSetUpEmailRequired ||
        sent.type instanceof Api.auth.SentCodeTypeEmailCode
      )
        throw new ManagementError(
          "Telegram 要求邮箱验证，请先在官方客户端完成邮箱设置"
        )
      return {
        hash: sent.phoneCodeHash,
        delivery:
          sent.type instanceof Api.auth.SentCodeTypeApp
            ? "Telegram 客户端"
            : "Telegram 指定的投递方式",
        timeout: sent.timeout || 60,
      }
    },
    async signIn(phone, hash, code) {
      await invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: hash,
          phoneCode: code,
        })
      )
    },
    async password(value) {
      const params = await invoke(new Api.account.GetPassword())
      await invoke(
        new Api.auth.CheckPassword({
          password: await password.computeCheck(params, value),
        })
      )
    },
    async me() {
      const user = await client.getMe()
      return {
        id: Number(user.id.toString()),
        username: user.username || null,
        phone: user.phone || "",
        bot: !!user.bot,
      }
    },
    async logout() {
      await invoke(new Api.auth.LogOut())
    },
    async save() {
      atomicWrite(path + ".string", session.save())
    },
    async dialogs() {
      await client.getDialogs({})
    },
    async entity(ref) {
      const entity = await client.getEntity(
        ref.startsWith("@") ? ref : Number(ref)
      )
      if (!(entity instanceof Api.Channel))
        throw new ManagementError("账号无法访问该频道")
      return { id: Number(utils.getPeerId(entity)), native: entity }
    },
    async messages(entity, ids, limit = 1) {
      const values = await client.getMessages(
        entity.native,
        ids ? { ids } : { limit }
      )
      return values.filter((v) => v instanceof Api.Message).map(message)
    },
    async *history(entity, cursor, since) {
      for await (const value of client.iterMessages(entity.native, {
        minId: cursor,
        reverse: true,
        offsetDate: since && !cursor ? Math.floor(since) : undefined,
        waitTime: 2,
      }))
        if (value instanceof Api.Message) yield message(value)
    },
    async download(entity, id, filePath, expected) {
      const values = await client.getMessages(entity.native, { ids: [id] })
      const source = values[0]
      if (
        !(source instanceof Api.Message) ||
        !(source.document instanceof Api.Document)
      )
        throw new Error("MEDIA_DELETED")
      if (
        source.document.id.toString() !== expected.id ||
        Number(source.document.size.toString()) !== expected.size
      )
        throw new Error("MEDIA_REPLACED")
      await client.downloadMedia(source, { outputFile: filePath })
    },
    subscribe(entities, callback) {
      const chats = entities.map((e) => e.id)
      const fresh = new events.NewMessage({ chats }),
        album = new events.Album({ chats }),
        edited = new events.EditedMessage({ chats })
      const onNew = (e: events.NewMessageEvent) => {
        if (!e.message.groupedId)
          void callback(
            Number(e.chatId?.toString()),
            [message(e.message)],
            false
          )
      }
      const onAlbum = (e: events.AlbumEvent) => {
        void callback(
          Number(e.chatId?.toString()),
          e.messages.map(message),
          false
        )
      }
      const onEdit = (e: events.EditedMessageEvent) => {
        void callback(Number(e.chatId?.toString()), [message(e.message)], true)
      }
      client.addEventHandler(onNew, fresh)
      client.addEventHandler(onAlbum, album)
      client.addEventHandler(onEdit, edited)
      return () => {
        client.removeEventHandler(onNew, fresh)
        client.removeEventHandler(onAlbum, album)
        client.removeEventHandler(onEdit, edited)
      }
    },
  }
}
export function floodSeconds(error: unknown): number | undefined {
  if (
    error &&
    typeof error === "object" &&
    "seconds" in error &&
    (/Flood.*Wait/i.test(error.constructor.name) ||
      ("name" in error && /Flood.*Wait/i.test(String(error.name))))
  )
    return Number(error.seconds)
  const text = error instanceof Error ? error.message : ""
  const found = text.match(/FLOOD(?:_PREMIUM)?_WAIT_(\d+)/)
  return found ? Number(found[1]) : undefined
}
export function rpcName(error: unknown) {
  return error && typeof error === "object" && "errorMessage" in error
    ? String(error.errorMessage)
    : error instanceof Error
      ? error.message
      : ""
}
