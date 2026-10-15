// Exercise the built downloader with two bind mounts on the same host filesystem.
import assert from "node:assert/strict"
import {
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"

assert.equal(process.env.RELAY_MOUNT_TEST, "1")
await import("../.output/server/index.mjs")
const runtime = await globalThis.__relayRuntime
try {
  runtime.stopped = true
  const channel = -1001234567890
  const config = {
    ...runtime.raw,
    channels: [{ id: channel, series: ["隔离测试"] }],
    series: [{ name: "隔离测试" }],
  }
  runtime.db.configure(config, new Map([[channel, ["隔离测试"]]]), false)
  const task = {
    channel_id: channel,
    message_id: 1,
    series_name: "隔离测试",
    document_id: "123",
    expected_size: 4,
    season: 1,
    episode: 1,
    extension: ".mp4",
    published_at: 1,
  }
  runtime.db.enqueue([task])
  assert.equal(
    lstatSync(runtime.settings.temp).dev,
    lstatSync(runtime.downloader.incoming).dev
  )
  const probe = join(runtime.settings.temp, "mount-probe.part")
  writeFileSync(probe, "data")
  assert.throws(
    () =>
      renameSync(probe, join(runtime.downloader.incoming, "mount-probe.ready")),
    (error) => error.code === "EXDEV"
  )
  unlinkSync(probe)
  await runtime.downloader.process(
    runtime.db.claim([channel]),
    {
      messages: async () => [{ document: { id: "123", size: 4 } }],
      download: async (_entity, _id, path) => writeFileSync(path, "data"),
    },
    { id: channel },
    () => {},
    () => {}
  )
  const result = runtime.db.tasks()[0]
  assert.equal(result.status, "completed", result.last_error)
  assert.equal(readFileSync(result.final_path, "utf8"), "data")
  console.log("PASS: built downloader publishes across same-device bind mounts")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  process.kill(process.pid, "SIGTERM")
}
