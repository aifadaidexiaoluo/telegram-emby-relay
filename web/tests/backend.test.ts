import assert from "node:assert/strict"
import { test } from "node:test"
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs"
import { symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Api, TelegramClient, helpers } from "teleproto"
import {
  defaults,
  checkConfig,
  finalPath,
  match,
  parseNumber,
} from "../src/server/config.ts"
import { Database } from "../src/server/database.ts"
import { ManagementRuntime } from "../src/server/runtime.ts"
import { AccountManager } from "../src/server/accounts.ts"
import {
  Downloader,
  publish,
  PermanentDownloadError,
} from "../src/server/download.ts"
import { Source } from "../src/server/source.ts"
import { refreshEmby, retryAfter } from "../src/server/emby.ts"
import { loadSession, createTransport } from "../src/server/telegram.ts"
import {
  fakeFactory,
  FakeTransport,
  PRIMARY,
  SECONDARY,
  mediaMessage,
} from "./fake-telegram.ts"
import type { Config } from "../src/lib/types.ts"
import type { Settings } from "../src/server/config.ts"

function setup(t: { after: (fn: () => unknown) => void }) {
  const root = mkdtempSync(join(tmpdir(), "relay-unit-"))
  const settings: Settings = {
    apiId: 1,
    apiHash: "fake",
    database: join(root, "downloads.sqlite3"),
    session: join(root, "telegram.session"),
    config: join(root, "config/config.json"),
    media: join(root, "media"),
    temp: join(root, "temp"),
    embyUrl: "http://fixture.invalid/emby",
    embyKey: "",
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, settings }
}
test("Telegram login reports API credential and phone RPC errors without masking them", (t) => {
  const { settings } = setup(t)
  const db = new Database(settings.database)
  t.after(() => db.close())
  const accounts = new AccountManager(db, settings, fakeFactory, () => {})
  const apiError = accounts.loginError(
    { errorMessage: "API_ID_INVALID" },
    "test-phone"
  )
  assert.match(apiError.message, /TG_API_ID 和 TG_API_HASH/)
  const phoneError = accounts.loginError(
    { errorMessage: "PHONE_NUMBER_INVALID" },
    "test-phone"
  )
  assert.match(phoneError.message, /手机号格式无效/)
})

const rules: Config = {
  ...defaults,
  channels: [
    { id: PRIMARY, series: ["吞噬星空"] },
    { id: SECONDARY, series: ["吞噬星空"] },
  ],
  series: [
    {
      name: "吞噬星空",
      latest_episodes: 1,
      exclude_keywords: ["预告", "PV"],
      episode_patterns: ["S(?P<season>\\d{1,2})E(?P<episode>\\d{1,4})"],
    },
  ],
}
function task(channel = PRIMARY, id = 1, episode = 157) {
  return {
    channel_id: channel,
    message_id: id,
    series_name: "吞噬星空",
    document_id: "922337203685470000" + id,
    expected_size: 4,
    season: 1,
    episode,
    extension: ".mp4",
    published_at: 1,
  }
}

test("matching preserves Chinese episodes, Python patterns, season mapping, album titles and exclusions", () => {
  checkConfig(rules)
  assert.equal(parseNumber("一百五十八"), 158)
  assert.equal(parseNumber("一五八"), 158)
  assert.equal(
    match(rules, PRIMARY, ["吞噬星空"], mediaMessage(1, "吞噬星空 第两百集"))
      ?.episode,
    200
  )
  assert.equal(
    match(rules, PRIMARY, ["吞噬星空"], mediaMessage(1, "吞噬星空 S04E14"))
      ?.season,
    4
  )
  assert.equal(
    match(rules, PRIMARY, ["吞噬星空"], mediaMessage(1, ""), "吞噬星空 第157集")
      ?.episode,
    157
  )
  assert.equal(
    match(
      rules,
      PRIMARY,
      ["吞噬星空"],
      mediaMessage(1, "吞噬星空 第157集"),
      "预告"
    ),
    null
  )
  assert.equal(
    match(rules, PRIMARY, ["吞噬星空"], mediaMessage(1, "吞噬星空 PV 第157集")),
    null
  )
  assert.equal(
    match(rules, PRIMARY, ["吞噬星空"], mediaMessage(1, "吞噬星空")),
    null
  )
  const mapped = {
    ...rules,
    series: [
      { ...rules.series[0], fixed_season: 1, season_aliases: { 完结季: 4 } },
    ],
  }
  assert.equal(
    match(
      mapped,
      PRIMARY,
      ["吞噬星空"],
      mediaMessage(1, "吞噬星空 完结季 S09E14")
    )?.season,
    1
  )
  assert.throws(
    () =>
      checkConfig({
        ...rules,
        channels: [],
        series: [{ name: "a/b" }, { name: "a\\b" }],
      }),
    /重复目录/
  )
  assert.throws(
    () =>
      checkConfig({
        ...rules,
        series: [{ name: "吞噬星空", episode_patterns: ["(\\d+)"] }],
      }),
    /命名组/
  )
})

test("latest selection waits for every channel, selects one cross-channel episode and keeps completed files", (t) => {
  const { settings } = setup(t),
    db = new Database(settings.database)
  t.after(() => db.close())
  db.configure(
    rules,
    new Map([
      [PRIMARY, ["吞噬星空"]],
      [SECONDARY, ["吞噬星空"]],
    ]),
    false
  )
  db.checkpoint(PRIMARY, 0)
  db.checkpoint(SECONDARY, 0)
  db.enqueue([task(), task(SECONDARY, 2, 158), task(PRIMARY, 3, 158)])
  db.finishScan(PRIMARY)
  assert.equal(db.claim([PRIMARY, SECONDARY]), undefined)
  db.finishScan(SECONDARY)
  const chosen = db.claim([PRIMARY, SECONDARY])!
  assert.equal(chosen.episode, 158)
  assert.equal(chosen.document_id, "9223372036854700002")
  assert.equal(db.claim([PRIMARY, SECONDARY]), undefined)
  db.completed(chosen, "/retained.mp4")
  db.enqueue([task(PRIMARY, 4, 159)])
  assert.equal(db.claim([PRIMARY, SECONDARY])!.episode, 159)
  assert.equal(
    db
      .tasks()
      .find(
        (item) =>
          item.channel_id === chosen.channel_id &&
          item.message_id === chosen.message_id
      )?.status,
    "completed"
  )
  db.holdSelection()
  assert.equal(db.selectionReady(), false)
})

test("offline responsible account holds limited series while ordinary tasks can still be claimed", (t) => {
  const { settings } = setup(t),
    db = new Database(settings.database)
  t.after(() => db.close())
  const config = { ...rules, series: [...rules.series, { name: "普通作品" }] }
  db.configure(
    config,
    new Map([
      [PRIMARY, ["吞噬星空", "普通作品"]],
      [SECONDARY, ["吞噬星空"]],
    ]),
    true
  )
  db.checkpoint(PRIMARY, 0)
  db.checkpoint(SECONDARY, 0)
  db.finishScan(PRIMARY)
  db.finishScan(SECONDARY)
  db.enqueue([task(), { ...task(PRIMARY, 2), series_name: "普通作品" }])
  assert.equal(db.claim([PRIMARY])!.series_name, "普通作品")
  assert.equal(db.claim([PRIMARY]), undefined)
})

test("legacy database keeps 64-bit document IDs, history and checkpoints through schema upgrade", (t) => {
  const { settings } = setup(t)
  const old = new DatabaseSync(settings.database)
  old.exec(`CREATE TABLE downloads(channel_id INTEGER NOT NULL,message_id INTEGER NOT NULL,series_name TEXT NOT NULL,document_id INTEGER NOT NULL,expected_size INTEGER NOT NULL,season INTEGER NOT NULL,episode INTEGER,extension TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_retry_at REAL NOT NULL DEFAULT 0,final_path TEXT,last_error TEXT,created_at REAL NOT NULL,updated_at REAL NOT NULL,PRIMARY KEY(channel_id,message_id));
    CREATE TABLE channel_checkpoints(channel_id INTEGER PRIMARY KEY,initial_since REAL NOT NULL,last_scanned_message_id INTEGER NOT NULL DEFAULT 0,last_success_at REAL);`)
  old
    .prepare("INSERT INTO downloads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      PRIMARY,
      1,
      "吞噬星空",
      9223372036854700001n,
      4,
      1,
      157,
      ".mp4",
      "completed",
      0,
      0,
      "/old/file.mp4",
      null,
      1,
      1
    )
  old
    .prepare("INSERT INTO channel_checkpoints VALUES(?,?,?,?)")
    .run(PRIMARY, 0, 40, 1)
  old.close()
  const db = new Database(settings.database)
  t.after(() => db.close())
  assert.equal(db.tasks()[0].document_id, "9223372036854700001")
  assert.equal(db.tasks()[0].final_path, "/old/file.mp4")
  assert.equal(db.getCheckpoint(PRIMARY)!.last_scanned_message_id, 40)
  assert.equal(
    db.sql.prepare("SELECT matched FROM downloads").get()!.matched,
    1
  )
})

test("Telethon SQLite session converts auth key into private StringSession without modifying the original", async (t) => {
  const { settings } = setup(t),
    old = new DatabaseSync(settings.session)
  old.exec(
    "CREATE TABLE sessions(dc_id INTEGER,server_address TEXT,port INTEGER,auth_key BLOB)"
  )
  const key = Buffer.alloc(256, 7)
  old
    .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .run(2, "149.154.167.51", 443, key)
  old.close()
  const before = readFileSync(settings.session)
  const session = await loadSession(settings.session)
  assert.deepEqual(session.authKey?.getKey(), key)
  assert.equal(session.dcId, 2)
  assert.deepEqual(readFileSync(settings.session), before)
  assert.equal(statSync(settings.session + ".string").mode & 0o777, 0o600)
  const reloaded = await loadSession(settings.session)
  await reloaded.load()
  assert.deepEqual(reloaded.authKey?.getKey(), key)
})

test("Telegram subscriptions resolve channel IDs without entity lookup or network", async (t) => {
  const { settings } = setup(t)
  const added = t.mock.method(
    TelegramClient.prototype,
    "addEventHandler",
    () => {}
  )
  const transport = await createTransport(settings.session, settings)
  t.after(() => transport.disconnect())
  transport.subscribe([{ id: PRIMARY }, { id: SECONDARY }], async () => {})
  assert.equal(added.mock.callCount(), 3)
  for (const call of added.mock.calls) {
    const builder = call.arguments[1]!
    await builder.resolve({
      getInputEntity: () => {
        throw new Error("unexpected entity lookup")
      },
    } as unknown as TelegramClient)
    assert.deepEqual(builder.chats, [String(PRIMARY), String(SECONDARY)])
  }
})

test("Telegram downloads do not impose a whole-file deadline and reject replaced media", async (t) => {
  const { settings } = setup(t)
  const document = new Api.Document({
    id: helpers.returnBigInt(123),
    accessHash: helpers.returnBigInt(1),
    fileReference: Buffer.alloc(0),
    date: 1,
    mimeType: "video/mp4",
    size: helpers.returnBigInt(4),
    dcId: 2,
    attributes: [],
  })
  const source = new Api.Message({
    id: 1,
    media: new Api.MessageMediaDocument({ document }),
  })
  t.mock.method(TelegramClient.prototype, "getMessages", async () => [source])
  const download = t.mock.method(
    TelegramClient.prototype,
    "downloadMedia",
    async () => settings.temp
  )
  const transport = await createTransport(settings.session, settings)
  t.after(() => transport.disconnect())
  await transport.download({ id: PRIMARY }, 1, settings.temp, {
    id: "123",
    size: 4,
  })
  assert.equal(download.mock.callCount(), 1)
  const options = download.mock.calls[0].arguments[1]
  assert.ok(options && typeof options !== "string")
  assert.equal(options.outputFile, settings.temp)
  assert.equal(options.requestTimeout, undefined)
  await assert.rejects(
    transport.download({ id: PRIMARY }, 1, settings.temp, {
      id: "124",
      size: 4,
    }),
    /MEDIA_REPLACED/
  )
  assert.equal(download.mock.callCount(), 1)
})

test("Emby failures retry independently; acknowledging an older generation keeps new completions pending", async (t) => {
  const { settings } = setup(t),
    db = new Database(settings.database)
  t.after(() => db.close())
  db.enqueue([task()])
  db.completed(task(), "/video.mp4")
  const initial = db.refreshState()
  const time = initial.last_completed_at! + 11
  await refreshEmby(
    db,
    "http://fixture.invalid/emby/",
    "secret",
    async (url, options) => {
      assert.equal(url, "http://fixture.invalid/emby/Library/Refresh")
      assert.equal(
        (options!.headers as Record<string, string>)["X-Emby-Token"],
        "secret"
      )
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "120" },
      })
    },
    time
  )
  assert.equal(db.refreshState().attempts, 1)
  assert.equal(db.tasks()[0].status, "completed")
  await refreshEmby(
    db,
    "http://fixture.invalid/emby",
    "secret",
    async () => {
      db.enqueue([task(PRIMARY, 2, 158)])
      db.completed(task(PRIMARY, 2, 158), "/second.mp4")
      return new Response(null, { status: 204 })
    },
    db.refreshState().next_retry_at + 1
  )
  assert.equal(db.refreshState().acknowledged_generation, 1)
  assert.equal(db.refreshState().requested_generation, 2)
  assert.ok(db.refreshState().dirty_since)
  assert.equal(retryAfter("Wed, 21 Oct 2015 07:28:00 GMT", 1445412470), 10)
})

test("publication checks sizes and rejects conflicting files and symlink directories", async (t) => {
  const { root, settings } = setup(t),
    incoming = join(root, "media/.incoming"),
    target = finalPath(settings.media, task()),
    temp = join(root, "one.part")
  mkdirSync(incoming, { recursive: true })
  mkdirSync(settings.media, { recursive: true })
  writeFileSync(temp, "data")
  await publish(temp, incoming, target, 4, settings.media)
  assert.equal(readFileSync(target, "utf8"), "data")
  writeFileSync(temp, "more")
  writeFileSync(target, "conflict")
  await assert.rejects(
    publish(temp, incoming, target, 4, settings.media),
    PermanentDownloadError
  )
  assert.equal(readFileSync(target, "utf8"), "conflict")
  const outside = join(root, "outside")
  mkdirSync(outside)
  await symlink(outside, join(settings.media, "escape"))
  await assert.rejects(
    publish(
      temp,
      incoming,
      join(settings.media, "escape/evil.mp4"),
      4,
      settings.media
    ),
    /越出/
  )
})

test("download validates source document identity and recovers an atomically published file", async (t) => {
  const { settings } = setup(t),
    db = new Database(settings.database)
  t.after(() => db.close())
  const queue = new Downloader(db, settings),
    client = new FakeTransport(settings.session)
  db.configure(
    { ...rules, series: [{ name: "吞噬星空" }] },
    new Map([[PRIMARY, ["吞噬星空"]]]),
    false
  )
  await queue.prepare()
  db.enqueue([task()])
  const claimed = db.claim([PRIMARY])!
  client.data.set(PRIMARY, [
    {
      ...mediaMessage(1, "吞噬星空 第157集"),
      document: { ...mediaMessage(1, "").document!, id: "different" },
    },
  ])
  await queue.process(
    claimed,
    client,
    { id: PRIMARY },
    () => {},
    () => {}
  )
  assert.equal(db.tasks()[0].status, "failed")
  client.data.set(PRIMARY, [mediaMessage(1, "吞噬星空 第157集")])
  db.retry(PRIMARY, 1)
  await queue.process(
    db.claim([PRIMARY])!,
    client,
    { id: PRIMARY },
    () => {},
    () => {}
  )
  assert.equal(db.tasks()[0].status, "completed")
  assert.equal(readFileSync(finalPath(settings.media, task()), "utf8"), "data")
  db.update(task(), { status: "downloading" })
  await queue.recover()
  assert.equal(db.tasks()[0].status, "completed")
  assert.equal(db.refreshState().requested_generation, 2)
})

test("scan ingests full album context at a cursor boundary and ignores stale scan completion", async (t) => {
  const { settings } = setup(t),
    db = new Database(settings.database)
  t.after(() => db.close())
  db.configure(rules, new Map([[PRIMARY, ["吞噬星空"]]]), false)
  db.checkpoint(PRIMARY, 0)
  const client = new FakeTransport(settings.session)
  client.data.set(PRIMARY, [
    { id: 1, text: "吞噬星空 第158集", date: 1, groupedId: "album" },
    { ...mediaMessage(2, "", 1), groupedId: "album" },
  ])
  const source = new Source(
    client,
    new Map([[PRIMARY, { id: PRIMARY }]]),
    rules,
    db
  )
  await source.traverse(PRIMARY, 1, 0, undefined, true)
  assert.equal(db.tasks()[0].episode, 158)
  assert.equal(db.getCheckpoint(PRIMARY)!.last_scanned_message_id, 2)
  source.requested = true
  const result = await source.scan(PRIMARY)
  assert.equal(result.completed, false)
  assert.equal(db.getCheckpoint(PRIMARY)!.first_scan_complete, 0)
})

test("time-bounded album scans retain caption context without enqueuing outside videos", async (t) => {
  const { settings } = setup(t)
  const db = new Database(settings.database)
  t.after(() => db.close())
  db.configure(rules, new Map([[PRIMARY, ["吞噬星空"]]]), false)
  const client = new FakeTransport(settings.session)
  client.data.set(PRIMARY, [
    { id: 1, text: "吞噬星空 第158集", date: 100, groupedId: "album" },
    { ...mediaMessage(2, "", 100), groupedId: "album" },
    { ...mediaMessage(3, "", 101), groupedId: "album" },
  ])
  const source = new Source(
    client,
    new Map([[PRIMARY, { id: PRIMARY }]]),
    rules,
    db
  )
  await source.traverse(PRIMARY, 0, 101, 102)
  assert.deepEqual(
    db.tasks().map((item) => [item.message_id, item.episode]),
    [[3, 158]]
  )
})

test("keyword context stays within each album", async (t) => {
  const { settings } = setup(t)
  const db = new Database(settings.database)
  t.after(() => db.close())
  db.configure(rules, new Map([[PRIMARY, ["吞噬星空"]]]), false)
  const client = new FakeTransport(settings.session)
  const source = new Source(
    client,
    new Map([[PRIMARY, { id: PRIMARY }]]),
    rules,
    db
  )
  await source.ingest(PRIMARY, [
    { id: 1, text: "吞噬星空 第158集", date: 1, groupedId: "a" },
    { ...mediaMessage(2, "", 1), groupedId: "a" },
    { ...mediaMessage(3, "", 1), groupedId: "b" },
    mediaMessage(4, "", 1),
  ])
  assert.deepEqual(
    db.tasks().map((item) => item.message_id),
    [2]
  )
})

test("rescanning cancels rejected candidates and corrects old identities before latest selection", async (t) => {
  const { settings } = setup(t)
  const db = new Database(settings.database)
  t.after(() => db.close())
  const config: Config = {
    ...rules,
    series: [...rules.series, { name: "完美世界", latest_episodes: 1 }],
  }
  db.configure(config, new Map([[PRIMARY, ["吞噬星空", "完美世界"]]]), false)
  db.checkpoint(PRIMARY, 0)
  db.enqueue([
    task(PRIMARY, 1, 999),
    { ...task(PRIMARY, 2, 998), document_id: "100" },
  ])
  db.update(task(PRIMARY, 2), {
    status: "failed",
    attempts: 8,
    last_error: "old error",
  })
  const client = new FakeTransport(settings.session)
  const source = new Source(
    client,
    new Map([[PRIMARY, { id: PRIMARY }]]),
    config,
    db
  )
  await source.ingest(PRIMARY, [
    mediaMessage(1, "吞噬星空 预告 第999集", 1),
    mediaMessage(2, "完美世界 第10集", 1),
    mediaMessage(3, "吞噬星空 第158集", 1),
  ])
  db.finishScan(PRIMARY)
  const rejected = db.tasks().find((item) => item.message_id === 1)!
  assert.equal(rejected.status, "cancelled")
  assert.equal(rejected.last_error, "不符合当前关键词或排除规则")
  const corrected = db.tasks().find((item) => item.message_id === 2)!
  assert.equal(corrected.series_name, "完美世界")
  assert.equal(corrected.document_id, task(PRIMARY, 2).document_id)
  assert.equal(corrected.episode, 10)
  assert.equal(corrected.attempts, 0)
  assert.equal(corrected.last_error, null)
  assert.deepEqual(
    [db.claim([PRIMARY])!.message_id, db.claim([PRIMARY])!.message_id].sort(),
    [2, 3]
  )
  assert.equal(db.claim([PRIMARY]), undefined)
  await source.ingest(PRIMARY, [mediaMessage(1, "吞噬星空 第159集", 1)])
  assert.equal(db.claim([PRIMARY])!.message_id, 1)
})

test("rescanning preserves completed and active downloads", async (t) => {
  const { settings } = setup(t)
  const db = new Database(settings.database)
  t.after(() => db.close())
  db.configure(rules, new Map([[PRIMARY, ["吞噬星空"]]]), false)
  db.enqueue([task(), task(PRIMARY, 2)])
  db.completed(task(), "/retained.mp4")
  db.update(task(PRIMARY, 2), { status: "downloading" })
  const client = new FakeTransport(settings.session)
  const source = new Source(
    client,
    new Map([[PRIMARY, { id: PRIMARY }]]),
    rules,
    db
  )
  await source.ingest(PRIMARY, [
    mediaMessage(1, "吞噬星空 预告", 1),
    mediaMessage(2, "吞噬星空 预告", 1),
  ])
  assert.deepEqual(
    db.tasks().map((item) => item.status),
    ["completed", "downloading"]
  )
  assert.equal(db.tasks()[0].final_path, "/retained.mp4")
})

test("runtime preserves accounts/config/key/version after restart and never returns saved key", async (t) => {
  const { settings } = setup(t),
    runtime = new ManagementRuntime(settings, fakeFactory)
  await runtime.downloader.prepare()
  runtime.restoring = false
  const flow = await runtime.write({
    action: "login",
    name: "测试账号",
    phone: "+12025550123",
  })
  assert.ok("state" in flow)
  await runtime.write({ action: "code", id: flow.id, code: "55555" })
  await assert.rejects(
    runtime.write({ action: "password", id: flow.id, password: "wrong" }),
    /错误/
  )
  const finished = await runtime.write({
    action: "password",
    id: flow.id,
    password: "correct",
  })
  assert.ok("state" in finished)
  await runtime.rebuild()
  const config = {
    ...defaults,
    emby_base_url: "http://emby.test:8096/emby",
    emby_api_key: "private-test-key",
  }
  await runtime.write({ action: "config", version: runtime.version, config })
  assert.equal(runtime.state().config.emby_api_key, undefined)
  assert.equal(runtime.state().emby.configured, true)
  assert.equal(statSync(settings.config).mode & 0o777, 0o600)
  const savedVersion = runtime.version
  await assert.rejects(
    runtime.write({ action: "config", version: "stale", config: defaults }),
    /已被修改/
  )
  await runtime.write({
    action: "config",
    version: runtime.version,
    config: runtime.publicConfig(),
  })
  assert.equal(runtime.embyKey(), "private-test-key")
  assert.equal(runtime.version, savedVersion)
  await runtime.close()
  const restarted = new ManagementRuntime(settings, fakeFactory)
  t.after(() => restarted.close())
  await restarted.accounts.restore()
  restarted.restoring = false
  await restarted.rebuild()
  assert.equal(restarted.state().accounts[0].status, "online")
  assert.equal(restarted.state().config.emby_base_url, config.emby_base_url)
  assert.equal(restarted.embyKey(), "private-test-key")
  assert.equal(restarted.version, savedVersion)
  assert.equal(
    JSON.stringify(restarted.state()).includes("private-test-key"),
    false
  )
})

test("configuration rejects invalid Emby addresses and header injection", () => {
  for (const url of [
    "file:///tmp/secret",
    "http://user:pass@emby/emby",
    "http://emby/emby?token=x",
    "http://emby/#x",
  ])
    assert.throws(() => checkConfig({ ...defaults, emby_base_url: url }))
  assert.throws(() =>
    checkConfig({ ...defaults, emby_api_key: "key\r\nInjected: true" })
  )
})

test("single instance lock prevents concurrent state use and releases on close", async (t) => {
  const { settings } = setup(t),
    runtime = new ManagementRuntime(settings, fakeFactory)
  assert.throws(
    () => new ManagementRuntime(settings, fakeFactory),
    /另一个后台/
  )
  await runtime.close()
  const next = new ManagementRuntime(settings, fakeFactory)
  await next.close()
})

test("Telegram flood and storage errors preserve attempts; ordinary failures stop at eight", async (t) => {
  const { settings } = setup(t),
    db = new Database(settings.database)
  t.after(() => db.close())
  db.configure(
    { ...rules, series: [{ name: "吞噬星空" }] },
    new Map([[PRIMARY, ["吞噬星空"]]]),
    false
  )
  const queue = new Downloader(db, settings),
    client = new FakeTransport(settings.session)
  await queue.prepare()
  db.enqueue([task()])
  class FloodWaitError extends Error {
    seconds = 10
  }
  client.download = async () => {
    throw new FloodWaitError()
  }
  let flooded = 0
  await queue.process(
    db.claim([PRIMARY])!,
    client,
    { id: PRIMARY },
    (seconds) => {
      flooded = seconds
    },
    () => {}
  )
  assert.equal(flooded, 10)
  assert.equal(db.tasks()[0].attempts, 0)
  db.update(task(), { next_retry_at: 0 })
  client.download = async () => {
    throw Object.assign(new Error("full"), { code: "ENOSPC" })
  }
  await queue.process(
    db.claim([PRIMARY])!,
    client,
    { id: PRIMARY },
    () => {},
    () => {}
  )
  assert.equal(db.tasks()[0].attempts, 0)
  assert.ok(queue.pauseUntil > Date.now() / 1000)
  db.update(task(), { attempts: 7, next_retry_at: 0 })
  client.download = async () => {
    throw new Error("network failure")
  }
  await queue.process(
    db.claim([PRIMARY])!,
    client,
    { id: PRIMARY },
    () => {},
    () => {}
  )
  assert.equal(db.tasks()[0].status, "failed")
  assert.equal(db.tasks()[0].attempts, 8)
})

test("changing Emby connection clears old retry delay and keeps an old refresh acknowledgment from dropping work", async (t) => {
  const { settings } = setup(t),
    runtime = new ManagementRuntime(settings, fakeFactory)
  t.after(() => runtime.close())
  runtime.restoring = false
  runtime.db.enqueue([task()])
  runtime.db.completed(task(), "/retained.mp4")
  runtime.db.retryRefresh(1800, "HTTP 401")
  const previous = runtime.db.refreshState().requested_generation
  await runtime.write({
    action: "config",
    version: runtime.version,
    config: {
      ...defaults,
      emby_base_url: "http://fixture.invalid/emby",
      emby_api_key: "replacement-key",
    },
  })
  assert.equal(runtime.db.refreshState().next_retry_at, 0)
  assert.equal(runtime.db.refreshState().requested_generation, previous + 1)
  runtime.db.acknowledge(previous)
  assert.ok(
    runtime.db.refreshState().requested_generation >
      runtime.db.refreshState().acknowledged_generation
  )
})

test("manual backfill leaves normal cursor intact and requires a subsequent selection scan", async (t) => {
  const { settings } = setup(t),
    runtime = new ManagementRuntime(settings, fakeFactory)
  await runtime.downloader.prepare()
  runtime.restoring = false
  const client = new FakeTransport(settings.session)
  client.loggedIn = true
  client.userId = 2
  client.phone = "+12025550124"
  await client.connect()
  await runtime.accounts.saveAccount("a", "补扫账号", client, settings.session)
  runtime.accounts.clients.set("a", client)
  runtime.raw = {
    ...rules,
    channels: [{ id: PRIMARY, account_id: "a", series: ["吞噬星空"] }],
  }
  await runtime.rebuild()
  runtime.db.checkpoint(PRIMARY, 0)
  runtime.db.sql
    .prepare(
      "UPDATE channel_checkpoints SET last_scanned_message_id=50,first_scan_complete=1 WHERE channel_id=?"
    )
    .run(PRIMARY)
  await runtime.write({
    action: "scan",
    since: "2000-01-01T00:00:00Z",
    until: "2099-01-01T00:00:00Z",
    channel: PRIMARY,
  })
  await runtime.backfillTask
  assert.equal(runtime.db.getCheckpoint(PRIMARY)!.last_scanned_message_id, 50)
  assert.equal(runtime.db.selectionReady(), false)
  assert.equal(runtime.db.tasks()[0].episode, 157)
  assert.equal(runtime.db.tasks()[0].status, "cancelled")
  await runtime.close()
})

test("address-only channels select an accessible account and new works rescan old messages into categories", async (t) => {
  const { settings } = setup(t)
  const runtime = new ManagementRuntime(settings, fakeFactory)
  t.after(() => runtime.close())
  await runtime.downloader.prepare()
  runtime.restoring = false
  for (const id of ["a", "b"]) {
    const client = new FakeTransport(settings.session + id)
    client.loggedIn = true
    client.userId = id === "a" ? 1 : 2
    if (id === "a") client.data.clear()
    else client.data.set(PRIMARY, [mediaMessage(1, "吞噬星空 第157集", 1)])
    await client.connect()
    await runtime.accounts.saveAccount(id, id, client, settings.session + id)
    runtime.accounts.clients.set(id, client)
  }
  await runtime.applyConfig(
    { ...defaults, channels: [{ url: "https://t.me/fixtureprimary" }] },
    runtime.version
  )
  assert.equal(runtime.raw.channels[0].account_id, "b")
  assert.equal(runtime.raw.channels[0].series, undefined)
  runtime.db.sql
    .prepare(
      "UPDATE channel_checkpoints SET last_scanned_message_id=100,first_scan_complete=1 WHERE channel_id=?"
    )
    .run(PRIMARY)
  const config: Config = {
    ...runtime.publicConfig(),
    categories: ["动漫"],
    series: [{ name: "吞噬星空", category: "动漫" }],
    ai: {
      enabled: false,
      base_url: "https://ai.test/v1",
      model: "test-model",
      api_key: "private-ai-key",
    },
  }
  await runtime.applyConfig(config, runtime.version)
  assert.equal(runtime.db.getCheckpoint(PRIMARY)!.last_scanned_message_id, 0)
  assert.equal(runtime.db.getCheckpoint(PRIMARY)!.initial_since, 0)
  assert.deepEqual(runtime.db.channels.get(PRIMARY), ["吞噬星空"])
  assert.equal(runtime.db.categories.get("吞噬星空"), "动漫")
  assert.equal(runtime.state().config.ai?.api_key, undefined)
  await runtime.applyConfig(runtime.publicConfig(), runtime.version)
  assert.equal(runtime.raw.ai?.api_key, "private-ai-key")
  const source = runtime.sources.get("b")!
  assert.equal((await source.scan(PRIMARY)).completed, true)
  const candidate = runtime.db.tasks()[0]
  assert.equal(candidate.episode, 157)
  await runtime.downloader.process(
    candidate,
    source.client,
    source.entities.get(PRIMARY)!,
    () => {},
    () => {}
  )
  const completed = runtime.db.tasks()[0]
  assert.equal(completed.status, "completed")
  assert.ok(completed.final_path?.startsWith(join(settings.media, "动漫")))
  assert.equal(readFileSync(completed.final_path!, "utf8"), "data")
})

test("keyword filtering skips unrelated and excluded videos without blocking scan selection", async (t) => {
  const { settings } = setup(t)
  const db = new Database(settings.database)
  t.after(() => db.close())
  const config: Config = {
    ...rules,
    ai: { enabled: true, base_url: "https://ai.test/v1", model: "test" },
  }
  db.configure(config, new Map([[PRIMARY, ["吞噬星空"]]]), false)
  db.checkpoint(PRIMARY, 0)
  const client = new FakeTransport(settings.session)
  client.data.set(PRIMARY, [
    mediaMessage(1, "unrelated video", 1),
    mediaMessage(2, "吞噬星空 预告 第160集", 1),
    mediaMessage(3, "吞噬星空 第159集", 1),
  ])
  const source = new Source(
    client,
    new Map([[PRIMARY, { id: PRIMARY }]]),
    config,
    db
  )
  const provider = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("provider should not run")
  })
  assert.equal((await source.scan(PRIMARY)).completed, true)
  assert.equal(provider.mock.callCount(), 0)
  assert.equal(db.getCheckpoint(PRIMARY)!.last_scanned_message_id, 3)
  assert.equal(db.getCheckpoint(PRIMARY)!.first_scan_complete, 1)
  assert.equal(db.tasks().length, 1)
  assert.equal(db.tasks()[0].episode, 159)
  assert.equal(db.tasks()[0].status, "pending")
})

test("invalid AI output cannot hold all channels or block later keyword tasks", async (parent) => {
  for (const content of [
    JSON.stringify({
      series_name: "unlisted-private-title",
      season: 1,
      episode: 159,
    }),
    JSON.stringify({ series_name: "吞噬星空", season: 100, episode: 159 }),
    JSON.stringify({ series_name: "吞噬星空", season: 1, episode: -1 }),
    "private-invalid-json",
  ]) {
    await parent.test(
      content.startsWith("{") ? "out of range" : "invalid JSON",
      async (t) => {
        const { settings } = setup(t)
        const db = new Database(settings.database)
        t.after(() => db.close())
        const config: Config = {
          ...rules,
          ai: { enabled: true, base_url: "https://ai.test/v1", model: "test" },
        }
        db.configure(
          config,
          new Map([
            [PRIMARY, ["吞噬星空"]],
            [SECONDARY, ["吞噬星空"]],
          ]),
          false
        )
        db.checkpoint(PRIMARY, 0)
        db.checkpoint(SECONDARY, 0)
        const client = new FakeTransport(settings.session)
        client.data.set(PRIMARY, [
          mediaMessage(1, "吞噬星空 集数待确认", 1),
          mediaMessage(2, "吞噬星空 第159集", 1),
        ])
        client.data.set(SECONDARY, [mediaMessage(3, "吞噬星空 第158集", 1)])
        const source = new Source(
          client,
          new Map([
            [PRIMARY, { id: PRIMARY }],
            [SECONDARY, { id: SECONDARY }],
          ]),
          config,
          db
        )
        const provider = t.mock.method(globalThis, "fetch", async () =>
          Response.json({ choices: [{ message: { content } }] })
        )
        const warnings = t.mock.method(console, "warn", () => {})
        assert.equal((await source.scan(PRIMARY)).completed, true)
        assert.equal(db.getCheckpoint(PRIMARY)!.last_scanned_message_id, 2)
        assert.equal(db.selectionReady(), false)
        assert.equal((await source.scan(SECONDARY)).completed, true)
        assert.equal(db.selectionReady(), true)
        assert.equal(source.lastError, null)
        assert.equal(provider.mock.callCount(), 1)
        assert.equal(warnings.mock.callCount(), 1)
        assert.equal(
          JSON.stringify(warnings.mock.calls).includes("private"),
          false
        )
        assert.equal(
          db.tasks().some((candidate) => candidate.message_id === 1),
          false
        )
        assert.equal(db.claim([PRIMARY, SECONDARY])!.episode, 159)
      }
    )
  }
})

test("invalid AI output preserves a valid local rule result", async (t) => {
  const { settings } = setup(t)
  const db = new Database(settings.database)
  t.after(() => db.close())
  const config: Config = {
    ...rules,
    series: [{ name: "吞噬星空" }],
    ai: { enabled: true, base_url: "https://ai.test/v1", model: "test" },
  }
  db.configure(config, new Map([[PRIMARY, ["吞噬星空"]]]), false)
  db.checkpoint(PRIMARY, 0)
  const client = new FakeTransport(settings.session)
  client.data.set(PRIMARY, [mediaMessage(1, "吞噬星空", 1)])
  const source = new Source(
    client,
    new Map([[PRIMARY, { id: PRIMARY }]]),
    config,
    db
  )
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ choices: [{ message: { content: "[]" } }] })
  )
  t.mock.method(console, "warn", () => {})
  assert.equal((await source.scan(PRIMARY)).completed, true)
  assert.equal(db.tasks()[0].series_name, "吞噬星空")
  assert.equal(db.tasks()[0].episode, null)
  assert.equal(db.tasks()[0].status, "pending")
})

test("AI failure keeps history cursor for retry and exposes a safe scan error", async (t) => {
  const { settings } = setup(t)
  const db = new Database(settings.database)
  t.after(() => db.close())
  const config: Config = {
    ...rules,
    ai: { enabled: true, base_url: "https://ai.test/v1", model: "test" },
  }
  db.configure(config, new Map([[PRIMARY, ["吞噬星空"]]]), false)
  db.checkpoint(PRIMARY, 0)
  const client = new FakeTransport(settings.session)
  client.data.set(PRIMARY, [mediaMessage(1, "吞噬星空 集数待确认", 1)])
  const source = new Source(
    client,
    new Map([[PRIMARY, { id: PRIMARY }]]),
    config,
    db
  )
  const provider = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("private-provider-detail", { status: 503 })
  )
  assert.equal((await source.scan(PRIMARY)).completed, false)
  assert.equal(db.getCheckpoint(PRIMARY)!.last_scanned_message_id, 0)
  assert.equal(db.tasks().length, 0)
  assert.match(source.lastError!, /AI 识别请求失败 \(503\)/)
  provider.mock.mockImplementation(async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              series_name: "吞噬星空",
              season: 1,
              episode: 159,
            }),
          },
        },
      ],
    })
  )
  assert.equal((await source.scan(PRIMARY)).completed, true)
  assert.equal(db.getCheckpoint(PRIMARY)!.last_scanned_message_id, 1)
  assert.equal(db.tasks()[0].episode, 159)
})
