// Test-only API fixture. Never started by the application or production container.
import { createServer } from "node:http"
const now = () => Date.now() / 1000
const emptyConfig = () => ({
  channels: [],
  series: [],
  download_concurrency: 2,
  scan_interval_seconds: 1800,
  initial_history_days: 7,
  edit_lookback_hours: 24,
})
let state,
  tasks,
  flows,
  calls,
  unavailable,
  blocked,
  twoFactor,
  generation,
  sequence,
  savedEmbyKey
function reset() {
  savedEmbyKey = ""
  generation = 1
  sequence = 0
  tasks = []
  flows = new Map()
  calls = []
  unavailable = false
  blocked = false
  twoFactor = true
  state = {
    now: now(),
    counts: {},
    accounts: [],
    channels: [],
    scans: [],
    config: emptyConfig(),
    version: "v1",
    emby: {
      configured: false,
      requested_generation: 0,
      acknowledged_generation: 0,
      last_error: null,
      next_retry_at: 0,
    },
    concurrency: 2,
    selection_ready: false,
  }
}
function seed() {
  state.accounts = [
    {
      id: "account-a",
      name: "测试账号",
      username: "fixture",
      phone: "+1 *** 1234",
      user_id: 1,
      status: "online",
      wait_until: 0,
      last_error: null,
      channel_count: 1,
    },
  ]
  state.config.series = [
    {
      name: "测试作品",
      aliases: ["别名"],
      latest_episodes: 2,
      default_season: 1,
      episode_patterns: ["(?P<episode>\\d+)"],
      extension_field: { preserved: true },
    },
  ]
  state.config.channels = [
    {
      id: -100123,
      account_id: "account-a",
      series: ["测试作品"],
      extension_field: "channel-kept",
    },
  ]
  tasks = Array.from({ length: 51 }, (_, index) => ({
    channel_id: -100123,
    message_id: index + 1,
    series_name: "测试作品",
    document_id: index + 1,
    expected_size: 1024 ** 3,
    downloaded_bytes: index === 1 ? 256 * 1024 ** 2 : 0,
    season: 1,
    episode: index + 1,
    extension: ".mp4",
    status: index === 0 ? "failed" : index === 1 ? "downloading" : "pending",
    attempts: index === 0 ? 2 : 0,
    next_retry_at: 0,
    final_path: null,
    last_error: index === 0 ? "测试下载错误" : null,
    created_at: now(),
    updated_at: now(),
    account_id: "account-a",
    account_name: "测试账号",
  }))
  sync()
}
function sync() {
  state.now = now()
  state.concurrency = state.config.download_concurrency
  state.channels = state.config.channels.map((c) => ({
    reference: c.url ?? String(c.id),
    id: c.id ?? -100123,
    account_id: c.account_id ?? null,
    series: state.config.series.map((rule) => rule.name),
    last_scanned_message_id: 12,
    last_success_at: now(),
    first_scan_complete: true,
    status: "completed",
    error: null,
  }))
  state.counts = tasks.reduce(
    (counts, t) => ({ ...counts, [t.status]: (counts[t.status] ?? 0) + 1 }),
    {}
  )
  state.accounts = state.accounts.map((a) => ({
    ...a,
    channel_count: state.config.channels.filter((c) => c.account_id === a.id)
      .length,
  }))
}
reset()
const json = (res, status, data) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(data))
}
const error = (res, status, message) => json(res, status, { error: message })
createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1"),
    path = url.pathname
  let raw = ""
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  if (path === "/test-control" && req.method === "POST") {
    if (body.reset) reset()
    if (body.seed) seed()
    if (body.downloadedBytes !== undefined)
      tasks[1].downloaded_bytes = body.downloadedBytes
    if (body.taskStatus !== undefined) tasks[1].status = body.taskStatus
    if (body.unavailable !== undefined) unavailable = body.unavailable
    if (body.blocked !== undefined) blocked = body.blocked
    if (body.twoFactor !== undefined) twoFactor = body.twoFactor
    if (body.bumpVersion) {
      state.version = `v${++generation}`
      state.config.scan_interval_seconds += 30
    }
    return json(res, 200, { ok: true })
  }
  if (path === "/test-requests") return json(res, 200, calls)
  if (path === "/test-state") return json(res, 200, state)
  if (req.headers.authorization !== "Bearer fixture-management-token")
    return error(res, 401, "missing test token")
  const safeBody = { ...body }
  for (const key of ["phone", "code", "password"])
    if (key in safeBody) safeBody[key] = "[redacted]"
  if (safeBody.config?.emby_api_key)
    safeBody.config = { ...safeBody.config, emby_api_key: "[redacted]" }
  calls.push({ path, method: req.method, body: safeBody })
  if (unavailable) return error(res, 503, "测试管理服务不可用")
  if (path === "/internal/state") {
    sync()
    return json(res, 200, state)
  }
  if (path === "/internal/downloads" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "",
      status = url.searchParams.get("status") ?? "active",
      page = Number(url.searchParams.get("page") ?? 1),
      series = url.searchParams.get("series"),
      channel = url.searchParams.get("channel")
    const found = tasks.filter(
      (t) =>
        (status === "active"
          ? !["completed", "cancelled"].includes(t.status)
          : status === "all" || t.status === status) &&
        (!q || t.series_name.includes(q)) &&
        (!series || t.series_name === series) &&
        (!channel || String(t.channel_id) === channel)
    )
    return json(res, 200, {
      items: found.slice((page - 1) * 50, page * 50),
      total: found.length,
      page,
      page_size: 50,
    })
  }
  if (path === "/internal/account-logins" && req.method === "POST") {
    if (
      body.account_id &&
      state.accounts.find((a) => a.id === body.account_id)?.status === "online"
    )
      return error(res, 409, "账号已授权，无需重复登录")
    const id = `flow-${++sequence}`,
      login = {
        id,
        state: "code",
        delivery: "Telegram 客户端",
        resend_at: now(),
        expires_at: now() + 300,
      }
    flows.set(id, { login, name: body.name, account_id: body.account_id })
    return json(res, 200, login)
  }
  const loginMatch = path.match(
    /^\/internal\/account-logins\/([^/]+)(?:\/(code|password|resend))?$/
  )
  if (loginMatch) {
    const [, id, action] = loginMatch,
      flow = flows.get(id)
    if (req.method === "DELETE") {
      flows.delete(id)
      return json(res, 200, { ok: true })
    }
    if (!flow) return error(res, 404, "登录流程不存在")
    if (action === "resend") {
      flow.login.resend_at = now() + 30
      return json(res, 200, flow.login)
    }
    if (action === "code" && body.code !== "24680")
      return error(res, 400, "验证码错误，请重试")
    if (action === "password" && body.password !== "test-password")
      return error(res, 400, "两步验证密码错误")
    if (action === "code" && twoFactor) {
      flow.login.state = "password"
      return json(res, 200, flow.login)
    }
    const accountId = flow.account_id ?? `account-${++sequence}`
    state.accounts.push({
      id: accountId,
      name: flow.name,
      username: null,
      phone: "+1 *** 0000",
      user_id: sequence + 10,
      status: "online",
      wait_until: 0,
      last_error: null,
      channel_count: 0,
    })
    flow.login.state = "completed"
    flow.login.account_id = accountId
    return json(res, 200, flow.login)
  }
  const logout = path.match(/^\/internal\/accounts\/([^/]+)\/logout$/)
  if (logout && req.method === "POST") {
    if (
      state.config.channels.some((c) => c.account_id === logout[1]) ||
      blocked
    )
      return error(res, 409, "仍有频道绑定或在途任务")
    state.accounts = state.accounts.filter((a) => a.id !== logout[1])
    return json(res, 200, { ok: true })
  }
  if (path === "/internal/config" && req.method === "PUT") {
    if (body.version !== state.version) return error(res, 409, "配置版本冲突")
    if (blocked) return error(res, 409, "仍有在途下载或补扫，请等待")
    const { emby_api_key, ...config } = body.config
    if (emby_api_key !== undefined) savedEmbyKey = emby_api_key
    if (config.ai) delete config.ai.api_key
    config.channels = config.channels.map(
      ({ series: _series, ...channel }) => ({
        ...channel,
        account_id: channel.account_id || "account-a",
      })
    )
    state.config = config
    state.emby.configured = !!savedEmbyKey
    state.version = `v${++generation}`
    sync()
    return json(res, 200, { ok: true, version: state.version })
  }
  if (path === "/internal/scans" && req.method === "POST") {
    state.scans = [
      {
        channel: String(body.channel ?? "全部频道"),
        account_id: "account-a",
        status: "waiting",
        last_error: null,
        started_at: now(),
        finished_at: null,
      },
    ]
    return json(res, 200, { ok: true })
  }
  const retry = path.match(/^\/internal\/downloads\/(-?\d+)\/(\d+)\/retry$/)
  if (retry && req.method === "POST") {
    const task = tasks.find(
      (t) =>
        t.channel_id === Number(retry[1]) && t.message_id === Number(retry[2])
    )
    if (!task || task.status !== "failed")
      return error(res, 409, "不是失败任务")
    task.status = "retry_wait"
    task.last_error = null
    return json(res, 200, { count: 1 })
  }
  return error(res, 404, "unknown mock endpoint")
}).listen(18765, "127.0.0.1")
