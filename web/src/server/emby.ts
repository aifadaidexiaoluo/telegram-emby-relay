import { now, safeName } from "./config.ts"
import { metadataCountry } from "./metadata.ts"
import type { Database } from "./database.ts"
import type { Series } from "../lib/types.ts"

type EmbyItem = {
  Id: string
  Path?: string
  Name?: string
  Genres?: string[]
  ProductionLocations?: string[]
  Tags?: string[]
  TagItems?: { Name: string }[]
  LockedFields?: string[]
  PreferredMetadataCountryCode?: string
  [key: string]: unknown
}
export async function syncEmbyMetadata(
  url: string,
  key: string,
  series: Series[],
  http: typeof fetch = fetch
) {
  const configured = series.filter(
    (s) => s.production_locations?.length || s.genres?.length || s.media_type
  )
  if (!configured.length) return
  const base = url.replace(/\/+$/, "")
  const headers = { "X-Emby-Token": key, "Content-Type": "application/json" }
  const get = async (path: string) => {
    const response = await http(base + path, {
      headers,
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    })
    if (!response.ok)
      throw new Error(`Emby 元数据查询失败 (${response.status})`)
    return response.json()
  }
  const catalog = (await get(
    "/Items?Recursive=true&IncludeItemTypes=Series,Movie&Fields=Path"
  )) as { Items: EmbyItem[] }
  const users = (await get("/Users")) as { Id: string }[]
  if (!users[0]?.Id) throw new Error("Emby 无可用用户")
  for (const rule of configured) {
    const suffix = `/${safeName(rule.category ?? "TV")}/${safeName(rule.name)}`
    const found = catalog.Items.filter((item) =>
      item.Path?.replace(/\/+$/, "").endsWith(suffix)
    )
    for (const match of found) {
      // Fetch the complete DTO so editing selected fields preserves identity, artwork and other metadata.
      const item = (await get(
        `/Users/${encodeURIComponent(users[0].Id)}/Items/${encodeURIComponent(match.Id)}`
      )) as EmbyItem
      if (item.Path !== match.Path)
        throw new Error("Emby 作品路径在同步期间改变")
      const tags = [
        ...new Set([
          ...(item.Tags ?? item.TagItems?.map((t) => t.Name) ?? []),
          ...(rule.production_locations ?? []),
          ...(rule.media_type === "animation"
            ? ["动漫", ...(metadataCountry(rule) === "CN" ? ["国产动漫"] : [])]
            : []),
        ]),
      ]
      const next = {
        ...item,
        ...(rule.production_locations?.length
          ? { ProductionLocations: rule.production_locations }
          : {}),
        ...(rule.genres?.length ? { Genres: rule.genres } : {}),
        ...(rule.genres?.length
          ? { GenreItems: rule.genres.map((Name) => ({ Name })) }
          : {}),
        ...(metadataCountry(rule)
          ? {
              PreferredMetadataCountryCode: metadataCountry(rule),
              PreferredMetadataLanguage: "zh-CN",
            }
          : {}),
        Tags: tags,
        TagItems: tags.map((Name) => ({ Name })),
        LockedFields: [
          ...new Set([
            ...(item.LockedFields ?? []),
            ...(rule.production_locations?.length
              ? ["ProductionLocations"]
              : []),
            ...(rule.genres?.length ? ["Genres"] : []),
            "Tags",
          ]),
        ],
      }
      if (
        [
          "ProductionLocations",
          "Genres",
          "PreferredMetadataCountryCode",
          "PreferredMetadataLanguage",
          "Tags",
          "LockedFields",
        ].every(
          (k) =>
            JSON.stringify(item[k]) ===
            JSON.stringify(next[k as keyof typeof next])
        )
      )
        continue
      const response = await http(
        base + `/Items/${encodeURIComponent(item.Id)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(next),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        }
      )
      await response.body?.cancel()
      if (!response.ok)
        throw new Error(`Emby 元数据更新失败 (${response.status})`)
    }
  }
}

export function retryAfter(value: string | null, time = now()) {
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Math.max(1, Number(value))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(1, date / 1000 - time) : undefined
}
export async function refreshEmby(
  db: Database,
  url: string,
  key: string,
  http: typeof fetch = fetch,
  time = now(),
  series: Series[] = []
) {
  if (!url || !key) return
  const state = db.refreshState()
  if (
    state.requested_generation <= state.acknowledged_generation ||
    state.next_retry_at > time ||
    time <
      Math.min(
        (state.last_completed_at || 0) + 10,
        (state.dirty_since || 0) + 60
      )
  )
    return
  const generation = state.requested_generation
  let delay = Math.min(1800, 30 * 2 ** Math.min(state.attempts, 6))
  try {
    const response = await http(url.replace(/\/+$/, "") + "/Library/Refresh", {
      method: "POST",
      headers: { "X-Emby-Token": key },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    })
    if (response.ok) {
      await syncEmbyMetadata(url, key, series, http)
      db.acknowledge(generation)
    } else {
      if (response.status === 429)
        delay = retryAfter(response.headers.get("retry-after"), time) || delay
      else if ([401, 403, 404].includes(response.status)) delay = 1800
      db.retryRefresh(delay, `HTTP ${response.status}`)
    }
    await response.body?.cancel()
  } catch {
    db.retryRefresh(delay, "Emby 连接失败，请检查接口地址与 Key")
  }
}
