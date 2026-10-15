import { now } from "./config.ts"
import type { Database } from "./database.ts"

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
  time = now()
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
    if (response.ok) db.acknowledge(generation)
    else {
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
