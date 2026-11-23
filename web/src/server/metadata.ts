import { readFile, realpath, lstat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { atomicWrite, safeName } from "./config.ts"
import type { Candidate } from "./config.ts"
import type { Series } from "../lib/types.ts"

const xml = (value: string | number) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!
  )
const references = new Map<
  string,
  { expires: number; result: Promise<string> }
>()
const publicSources = new Set([
  "animexin.dev",
  "thetvdb.com",
  "www.thetvdb.com",
  "www.themoviedb.org",
  "api.tvmaze.com",
  "www.tvmaze.com",
  "v.qq.com",
  "wetv.vip",
  "www.iqiyi.com",
  "www.iq.com",
  "v.youku.com",
])

// Only known public metadata hosts are fetched. Redirects cannot escape the allowlist.
export async function referenceContext(
  series: Series,
  request: typeof fetch = fetch
) {
  return Promise.all(
    (series.metadata_sources ?? []).slice(0, 3).map(async (source) => {
      let url: URL
      try {
        url = new URL(source)
      } catch {
        return null
      }
      if (
        url.protocol !== "https:" ||
        !publicSources.has(url.hostname) ||
        url.port ||
        url.username ||
        url.password
      )
        return null
      let cached = references.get(source)
      if (!cached || cached.expires < Date.now()) {
        const result = (async () => {
          const response = await request(url, {
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          })
          if (!response.ok) throw new Error("资料查询失败")
          const reader = response.body?.getReader()
          if (!reader) throw new Error("资料响应为空")
          const chunks: Uint8Array[] = []
          let size = 0
          try {
            while (size < 512 * 1024) {
              const part = await reader.read()
              if (part.done) break
              size += part.value.length
              if (size > 512 * 1024) break
              chunks.push(part.value)
            }
          } finally {
            await reader.cancel()
          }
          return Buffer.concat(chunks)
            .toString("utf8")
            .replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .slice(0, 24000)
        })()
        const entry = { expires: Date.now() + 6 * 3600 * 1000, result }
        cached = entry
        references.set(source, entry)
        void result.catch(() => {
          if (references.get(source) === entry)
            entry.expires = Date.now() + 60000
        })
      }
      return {
        source,
        text: await cached.result.catch(
          () => "资料暂时不可用；不得据此编造分季"
        ),
      }
    })
  )
}

export function metadataCountry(series: Series) {
  return series.production_locations?.some((v) =>
    ["中国大陆", "中国", "China", "CN"].includes(v)
  )
    ? "CN"
    : undefined
}

function replaceElements(
  document: string,
  tag: string,
  values: (string | number)[],
  root: string
) {
  const cleaned = document.replace(
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>\\s*|<${tag}\\s*\\/>\\s*`,
      "gi"
    ),
    ""
  )
  return cleaned.replace(
    `</${root}>`,
    values.map((v) => `  <${tag}>${xml(v)}</${tag}>\n`).join("") + `</${root}>`
  )
}

async function writeNfo(
  media: string,
  path: string,
  root: string,
  fields: Record<string, (string | number)[]>
) {
  const parent = await realpath(dirname(path)),
    base = await realpath(media),
    rel = relative(base, parent)
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("元数据路径越出媒体目录")
  let document = `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n</${root}>\n`
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
      throw new Error("元数据文件冲突")
    document = await readFile(path, "utf8")
    if (!document.includes(`</${root}>`))
      throw new Error("现有元数据格式无效，保留文件")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const previous = document
  for (const [tag, values] of Object.entries(fields))
    document = replaceElements(document, tag, values, root)
  if (previous !== document) atomicWrite(path, document)
}

export async function writeMediaMetadata(
  media: string,
  task: Candidate,
  path: string,
  series?: Series
) {
  if (
    !series ||
    (!series.production_locations?.length &&
      !series.genres?.length &&
      !series.episode_mappings?.length &&
      !series.media_type)
  )
    return
  const folder = join(
    media,
    safeName(series.category ?? "TV"),
    safeName(series.name)
  )
  const fields: Record<string, (string | number)[]> = { title: [series.name] }
  if (series.production_locations?.length)
    fields.country = series.production_locations
  if (series.genres?.length) fields.genre = series.genres
  const country = metadataCountry(series)
  if (country) fields.countrycode = [country]
  if (series.media_type)
    fields.tag = [
      series.media_type === "animation"
        ? "动漫"
        : series.media_type === "movie"
          ? "电影"
          : "电视剧",
      ...(series.production_locations ?? []),
    ]
  await writeNfo(
    media,
    join(folder, series.media_type === "movie" ? "movie.nfo" : "tvshow.nfo"),
    series.media_type === "movie" ? "movie" : "tvshow",
    fields
  )
  if (
    task.episode !== null &&
    (!task.content_type || task.content_type === "episode")
  ) {
    await writeNfo(media, path.replace(/\.[^.]+$/, ".nfo"), "episodedetails", {
      title: [
        `${series.name} 第${task.episode}集${task.absolute_episode ? `（累计${task.absolute_episode}集）` : ""}`,
      ],
      season: [task.season],
      episode: [task.episode],
      ...(task.absolute_episode ? { displayepisode: [task.episode] } : {}),
    })
  }
}
