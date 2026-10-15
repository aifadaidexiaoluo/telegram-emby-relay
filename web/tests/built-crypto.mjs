// Exercise Telegram packet encryption from the published bundle without opening a socket.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  require_teleproto,
  require_AuthKey,
} from "../.output/server/_libs/teleproto.mjs"

const { TelegramClient, sessions } = require_teleproto()
const session = new sessions.StringSession("")
session.setDC(2, "127.0.0.1", 18766)
const key = Buffer.alloc(256, 7)
session.authKey = new (require_AuthKey().AuthKey)()
await session.authKey.setKey(key)
const client = new TelegramClient(session, 1, "offline-test", {})
client.setLogLevel("error")
const stop = new Error("offline encryption complete")
let packet
client._connectSender = async (sender) => {
  packet = await sender._state.encryptMessageData(Buffer.alloc(16, 3))
  throw stop
}
try {
  await assert.rejects(client.connect(), (error) => error === stop)
  assert.equal(packet.length, 72)
  assert.deepEqual(
    packet.subarray(0, 8),
    createHash("sha1").update(key).digest().subarray(12, 20)
  )
  console.log(
    "PASS: built Telegram MTProto encryption, no network or real session"
  )
} finally {
  await client.destroy()
}
