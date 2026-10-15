import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs"
import { dirname, join, resolve, extname } from "node:path"
import { validateConfig } from "../lib/validation.ts"
import type { Config, ConfigChannel } from "../lib/types.ts"

export class ManagementError extends Error {
  status: number
  retry_at?: number
  constructor(message: string, status = 400, retry_at?: number) {
    super(message)
    this.name = "ManagementError"
    this.status = status
    this.retry_at = retry_at
  }
}
export const now = () => Date.now() / 1000
export const reference = (item: ConfigChannel) =>
  item.id === undefined
    ? "@" + item.url!.replace(/\/$/, "").split("/").at(-1)!.toLowerCase()
    : String(item.id)
export const defaults: Config = {
  channels: [],
  series: [],
  download_concurrency: 2,
  scan_interval_seconds: 1800,
  initial_history_days: 7,
  edit_lookback_hours: 24,
}
export const version = (config: Config) =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex")
export function settingsFromEnv() {
  const state = resolve(process.env.STATE_ROOT || "../local-data/state")
  return {
    apiId: Number(process.env.TG_API_ID || 0),
    apiHash: process.env.TG_API_HASH || "",
    database: resolve(
      process.env.DATABASE_PATH || join(state, "downloads.sqlite3")
    ),
    session: resolve(
      process.env.TG_SESSION_PATH || join(state, "telegram.session")
    ),
    config: resolve(
      process.env.CONFIG_PATH || "../local-data/configuration/config.json"
    ),
    media: resolve(process.env.MEDIA_ROOT || "../local-data/media/TV"),
    temp: resolve(process.env.TEMP_ROOT || "../local-data/temp"),
    embyUrl: process.env.EMBY_BASE_URL || "http://emby:8096/emby",
    embyKey: process.env.EMBY_API_KEY || "",
  }
}
export type Settings = ReturnType<typeof settingsFromEnv>
export function atomicWrite(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), ".write-" + randomUUID())
  const fd = openSync(temp, "wx", 0o600)
  try {
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
    syncDirectory(dirname(path))
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}
export function syncDirectory(path: string) {
  const fd = openSync(path, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
export function normalize(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
}
export function safeName(text: string) {
  const name = text
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 100)
  if (!name) throw new ManagementError("作品名称不能生成有效目录")
  return name
}
export function episodePattern(pattern: string) {
  // Existing configs use Python named groups; the equivalent JS syntax keeps them importable.
  return new RegExp(
    pattern
      .replace(/\(\?P<([a-zA-Z_]\w*)>/g, "(?<$1>")
      .replace(/\(\?P=([a-zA-Z_]\w*)\)/g, "\\k<$1>"),
    "i"
  )
}
export function checkConfig(data: unknown): asserts data is Config {
  validateConfig(data)
  for (const channel of data.channels)
    if (channel.id !== undefined && channel.id >= -1000000000000)
      throw new ManagementError("频道 ID 必须是 Telegram -100… 数值频道 ID")
  const directories = new Set<string>()
  for (const rule of data.series) {
    const directory = safeName(rule.name).toLowerCase()
    if (directories.has(directory))
      throw new ManagementError("作品名称生成了重复目录")
    directories.add(directory)
    for (const pattern of rule.episode_patterns || []) {
      try {
        episodePattern(pattern)
      } catch {
        throw new ManagementError(
          "集数表达式无效，请使用 JavaScript 支持的正则语法"
        )
      }
      if (!/\(\?(?:P)?<episode>/.test(pattern))
        throw new ManagementError("集数表达式必须包含 episode 命名组")
    }
  }
}
export function parseNumber(text: string) {
  if (/^\d+$/.test(text)) return Number(text)
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
  if (![...text].some((c) => units[c]))
    return Number([...text].map((c) => digits[c]).join(""))
  let total = 0,
    value = 0
  for (const c of text) {
    if (units[c]) {
      total += (value || 1) * units[c]
      value = 0
    } else value = digits[c] ?? Number(c)
  }
  return total + value
}
export type MediaMessage = {
  id: number
  text: string
  date: number
  groupedId?: string
  document?: {
    id: string
    size: number
    mime: string
    filename: string
    video: boolean
  }
}
export type Candidate = {
  channel_id: number
  message_id: number
  series_name: string
  document_id: string
  expected_size: number
  season: number
  episode: number | null
  extension: string
  published_at: number
}
const videos = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".ts"])
export function match(
  config: Config,
  channel: number,
  names: string[],
  message: MediaMessage,
  album = ""
): Candidate | null {
  const doc = message.document
  if (!doc || !Number.isSafeInteger(doc.size) || doc.size <= 0) return null
  let extension = extname(doc.filename).toLowerCase()
  if (
    !doc.video &&
    !doc.mime.startsWith("video/") &&
    !(
      ["", "application/octet-stream"].includes(doc.mime) &&
      videos.has(extension)
    )
  )
    return null
  const own = normalize(message.text + " " + doc.filename)
  const hits = (text: string) =>
    config.series.filter((r) =>
      (r.aliases || [r.name]).some((a) => text.includes(normalize(a)))
    )
  const text = hits(own).length ? own : normalize(own + " " + album)
  const rules = hits(text)
  if (rules.length !== 1 || !names.includes(rules[0].name)) return null
  const rule = rules[0],
    exclusions = normalize(own + " " + album)
  if (
    (rule.exclude_keywords || []).some((k) => {
      const keyword = normalize(k)
      return /^[a-z0-9]+$/.test(keyword)
        ? new RegExp(`(?:^|[^a-z0-9])${keyword}(?:$|[^a-z0-9])`).test(
            exclusions
          )
        : exclusions.includes(keyword)
    })
  )
    return null
  let season = rule.default_season ?? 1,
    episode: number | null = null
  const chineseSeason = text.match(/第\s*([一二两三四五六七八九十0-9]+)\s*季/)
  if (chineseSeason) season = parseNumber(chineseSeason[1])
  for (const pattern of rule.episode_patterns || []) {
    const found = episodePattern(pattern).exec(text)
    if (found) {
      episode = Number(found.groups!.episode)
      if (found.groups!.season) season = Number(found.groups!.season)
      break
    }
  }
  if (episode === null) {
    const found = text.match(
      /第\s*([零〇一二两三四五六七八九十百千0-9]+)\s*[集话]/
    )
    if (found) episode = parseNumber(found[1])
  }
  const aliasSeasons = new Set(
    Object.entries(rule.season_aliases || {})
      .filter(([a]) => text.includes(normalize(a)))
      .map(([, s]) => s)
  )
  if (aliasSeasons.size > 1) return null
  if (aliasSeasons.size) season = [...aliasSeasons][0]
  season = rule.fixed_season ?? season
  if (
    !Number.isInteger(season) ||
    season < 0 ||
    season > 99 ||
    (episode !== null &&
      (!Number.isInteger(episode) || episode < 1 || episode > 9999)) ||
    (episode === null && rule.latest_episodes)
  )
    return null
  if (!videos.has(extension))
    extension =
      (
        {
          "video/x-matroska": ".mkv",
          "video/webm": ".webm",
          "video/quicktime": ".mov",
        } as Record<string, string>
      )[doc.mime] || ".mp4"
  return {
    channel_id: channel,
    message_id: message.id,
    series_name: rule.name,
    document_id: doc.id,
    expected_size: doc.size,
    season,
    episode,
    extension,
    published_at: message.date,
  }
}
export function finalPath(media: string, task: Candidate) {
  const title = safeName(task.series_name),
    identity = `ch${Math.abs(task.channel_id)}-m${task.message_id}`
  if (!videos.has(task.extension)) throw new ManagementError("媒体扩展名无效")
  const label = `S${String(task.season).padStart(2, "0")}E${String(task.episode).padStart(3, "0")}`
  return join(
    media,
    title,
    task.episode === null
      ? "未识别集数"
      : `Season ${String(task.season).padStart(2, "0")}`,
    `${title} - ${task.episode === null ? identity : label + " - " + identity}${task.extension}`
  )
}
