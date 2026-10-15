import type { Config, Filters, Write } from "./types.ts"

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function object(value: unknown): asserts value is Record<string, unknown> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "请求格式不正确"
  )
}
function text(value: unknown, max = 500): asserts value is string {
  requireValue(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    "文本为空或过长"
  )
}
function integer(
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
): asserts value is number {
  requireValue(
    Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max,
    "整数超出允许范围"
  )
}
function strings(value: unknown) {
  requireValue(
    Array.isArray(value) &&
      value.every((v) => typeof v === "string" && v.length <= 2000),
    "列表格式不正确"
  )
}
export function validateConfig(value: unknown): asserts value is Config {
  object(value)
  integer(value.download_concurrency, 1, 16)
  integer(value.scan_interval_seconds, 30)
  integer(value.initial_history_days, 1, 36500)
  integer(value.edit_lookback_hours, 1, 8760)
  if (value.emby_base_url !== undefined) {
    text(value.emby_base_url, 2000)
    const url = new URL(value.emby_base_url)
    requireValue(
      ["http:", "https:"].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "Emby 接口地址必须是无凭据、无查询参数的 HTTP(S) 地址"
    )
  }
  if (value.emby_api_key !== undefined) {
    text(value.emby_api_key, 1024)
    requireValue(!/[\r\n\x00]/.test(value.emby_api_key), "Emby Key 格式无效")
  }
  requireValue(Array.isArray(value.series), "作品列表格式不正确")
  requireValue(
    Array.isArray(value.channels) &&
      (value.channels.length === 0 || value.series.length > 0),
    "配置频道时至少保留一部作品"
  )
  const names = new Set<string>()
  for (const rule of value.series) {
    object(rule)
    text(rule.name, 100)
    requireValue(!names.has(rule.name), "作品名称不能重复")
    names.add(rule.name)
    for (const key of ["aliases", "exclude_keywords", "episode_patterns"])
      if (rule[key] !== undefined) strings(rule[key])
    for (const key of ["default_season", "fixed_season"])
      if (rule[key] !== undefined) integer(rule[key], 0, 99)
    if (rule.latest_episodes !== undefined)
      integer(rule.latest_episodes, 1, 1000)
    for (const key of ["aliases", "exclude_keywords", "episode_patterns"]) {
      if (Array.isArray(rule[key]))
        requireValue(
          (rule[key] as string[]).every((v) => !!v.trim()),
          "规则列表不能包含空字符串"
        )
    }
    if (rule.aliases !== undefined)
      requireValue((rule.aliases as string[]).length > 0, "别名列表不能为空")
    if (rule.season_aliases !== undefined) {
      object(rule.season_aliases)
      for (const [key, season] of Object.entries(rule.season_aliases)) {
        text(key)
        integer(season, 0, 99)
      }
    }
  }
  requireValue(Array.isArray(value.channels), "频道列表格式不正确")
  const channels = new Set<string>()
  for (const channel of value.channels) {
    object(channel)
    requireValue(
      (channel.id !== undefined) !== (channel.url !== undefined),
      "频道 ID 和 URL 必须且只能选一个"
    )
    if (channel.id !== undefined) {
      integer(channel.id, Number.MIN_SAFE_INTEGER)
      requireValue(channel.id !== 0, "频道 ID 不能为零")
    }
    if (channel.url !== undefined) {
      text(channel.url)
      requireValue(
        /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}\/?$/.test(channel.url),
        "请输入公开 t.me 频道 URL"
      )
    }
    if (channel.account_id !== undefined) text(channel.account_id)
    strings(channel.series)
    requireValue(
      (channel.series as string[]).length > 0,
      "频道至少选择一部作品"
    )
    requireValue(
      (channel.series as string[]).every((name) => names.has(name)),
      "频道引用了不存在的作品"
    )
    const reference = String(
      channel.id ?? (channel.url as string).replace(/\/$/, "").toLowerCase()
    )
    requireValue(!channels.has(reference), "频道不能重复")
    channels.add(reference)
  }
}
export function validateFilters(value: unknown): Filters {
  object(value)
  integer(value.page, 1, 100000)
  requireValue(
    [
      "active",
      "all",
      "pending",
      "downloading",
      "retry_wait",
      "failed",
      "completed",
      "cancelled",
    ].includes(String(value.status)),
    "任务状态不正确"
  )
  for (const key of ["q", "series", "channel"])
    requireValue(
      typeof value[key] === "string" && value[key].length <= 500,
      "筛选条件格式不正确"
    )
  return value as Filters
}
export function validateWrite(value: unknown): Write {
  object(value)
  requireValue(
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024,
    "请求正文过大"
  )
  switch (value.action) {
    case "login":
      text(value.name, 80)
      text(value.phone, 16)
      requireValue(
        /^\+[1-9][0-9]{6,14}$/.test(value.phone),
        "手机号必须包含国家码"
      )
      if (value.account_id !== undefined) text(value.account_id)
      break
    case "code":
      text(value.id)
      text(value.code, 8)
      requireValue(/^\d{4,8}$/.test(value.code), "验证码须为 4–8 位数字")
      break
    case "password":
      text(value.id)
      text(value.password, 1024)
      break
    case "resend":
    case "cancel":
    case "logout":
      text(value.id)
      break
    case "retry":
      integer(value.channel, Number.MIN_SAFE_INTEGER)
      integer(value.message)
      break
    case "scan":
      if (value.channel !== undefined)
        integer(value.channel, Number.MIN_SAFE_INTEGER)
      text(value.since)
      text(value.until)
      requireValue(
        [value.since, value.until].every(
          (v) =>
            /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))
        ),
        "时间必须包含时区"
      )
      requireValue(
        Date.parse(value.until) > Date.parse(value.since),
        "结束时间必须晚于开始时间"
      )
      break
    case "config":
      text(value.version)
      validateConfig(value.config)
      break
    default:
      throw new Error("不支持的操作")
  }
  return value as Write
}
export function assertTrustedWrite(request: Request, webOrigin?: string) {
  const url = new URL(request.url),
    origin = request.headers.get("origin")
  const expected = webOrigin ? new URL(webOrigin).origin : url.origin
  requireValue(
    webOrigin || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "非本机入口必须配置 WEB_ORIGIN"
  )
  requireValue(origin === expected && origin !== "null", "请求来源不受信任")
  requireValue(
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ===
      "application/json",
    "仅接受 JSON 请求"
  )
}
export function shanghaiISO(value: string) {
  requireValue(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value),
    "请填写完整日期与时间"
  )
  const iso = `${value}:00+08:00`
  requireValue(Number.isFinite(Date.parse(iso)), "日期无效")
  return iso
}
export function configImpacts(before: Config, after: Config): string[] {
  const impacts: string[] = []
  const removed = before.series
    .filter((s) => !after.series.some((t) => t.name === s.name))
    .map((s) => s.name)
  if (removed.length)
    impacts.push(
      `停止使用作品：${removed.join("、")}；对应未完成任务可能被取消。`
    )
  const key = (c: Config["channels"][number]) => String(c.id ?? c.url)
  for (const channel of before.channels) {
    const next = after.channels.find((c) => key(c) === key(channel))
    if (!next)
      impacts.push(
        `移除频道 ${key(channel)}：停止监听，未完成任务可能被取消；已完成媒体保留。`
      )
    else if (
      next.account_id !== channel.account_id ||
      JSON.stringify(next.series) !== JSON.stringify(channel.series)
    )
      impacts.push(
        `调整频道 ${key(channel)} 的账号或白名单：重新选择候选，未完成任务可能被取消；新增作品需补扫历史。`
      )
  }
  if (
    after.channels.some((c) => !before.channels.some((t) => key(c) === key(t)))
  )
    impacts.push("新增频道：请确认账号有访问权限，旧历史可能需要手动补扫。")
  if (JSON.stringify(before.series) !== JSON.stringify(after.series))
    impacts.push(
      "作品规则改变：重新选择最新剧集，未完成任务可能被取消；已完成文件保留。"
    )
  if (
    before.emby_base_url !== after.emby_base_url ||
    after.emby_api_key !== undefined
  )
    impacts.push("更新 Emby 连接：后续媒体刷新使用新的接口地址与 Key。")
  return impacts
}
