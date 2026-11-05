// Isolated integration fixture: production runtime/SQLite/download code, only Telegram is simulated.
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagementRuntime } from "../src/server/runtime.ts"
import { ManagementError } from "../src/server/config.ts"
import { fakeFactory } from "./fake-telegram.ts"
import type { Write } from "../src/lib/types.ts"

const root = mkdtempSync(join(tmpdir(), "relay-node-integration-"))
const runtime = new ManagementRuntime(
  {
    apiId: 1,
    apiHash: "fake-api-hash",
    database: join(root, "downloads.sqlite3"),
    session: join(root, "legacy.session"),
    config: join(root, "configuration/config.json"),
    media: join(root, "media"),
    temp: join(root, "temp"),
    embyUrl: "http://127.0.0.1:18766/emby",
    embyKey: "",
  },
  fakeFactory
)
await runtime.start()
const token = "isolated-node-integration-token"
const server = createServer(async (req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    res.end(JSON.stringify(body))
  }
  if (req.headers.authorization !== "Bearer " + token || req.headers.origin)
    return json(403, { error: "仅限隔离测试服务" })
  try {
    const url = new URL(req.url!, "http://127.0.0.1:18766"),
      path = url.pathname
    if (path === "/internal/state" && req.method === "GET")
      return json(200, runtime.state())
    if (path === "/internal/downloads" && req.method === "GET")
      return json(
        200,
        runtime.downloads({
          page: Number(url.searchParams.get("page") || 1),
          status: url.searchParams.get("status") || "active",
          q: url.searchParams.get("q") || "",
          series: url.searchParams.get("series") || "",
          channel: url.searchParams.get("channel") || "",
        })
      )
    let raw = ""
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 256 * 1024) throw new ManagementError("请求过大", 413)
    }
    const body = raw ? JSON.parse(raw) : {}
    let action: Write | undefined
    if (path === "/internal/account-logins" && req.method === "POST")
      action = { ...body, action: "login" }
    const login = path.match(
      /^\/internal\/account-logins\/([^/]+)(?:\/(code|password|resend))?$/
    )
    if (login)
      action = {
        ...body,
        action: req.method === "DELETE" ? "cancel" : login[2],
        id: login[1],
      }
    const logout = path.match(/^\/internal\/accounts\/([^/]+)\/logout$/)
    if (logout) action = { action: "logout", id: logout[1] }
    const retry = path.match(/^\/internal\/downloads\/(-?\d+)\/(\d+)\/retry$/)
    if (retry)
      action = {
        action: "retry",
        channel: Number(retry[1]),
        message: Number(retry[2]),
      }
    if (path === "/internal/config" && req.method === "PUT")
      action = { ...body, action: "config" }
    if (path === "/internal/scans" && req.method === "POST")
      action = { ...body, action: "scan" }
    if (!action) return json(404, { error: "接口不存在" })
    return json(200, await runtime.write(action))
  } catch (error) {
    json(error instanceof ManagementError ? error.status : 400, {
      error: error instanceof ManagementError ? error.message : "请求格式无效",
    })
  }
})
server.listen(18766, "127.0.0.1")
async function close() {
  server.close()
  await runtime.close()
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGTERM", () => {
  void close()
})
process.once("SIGINT", () => {
  void close()
})
