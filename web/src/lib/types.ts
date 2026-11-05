export type Series = {
  name: string
  category?: string
  aliases?: string[]
  exclude_keywords?: string[]
  episode_patterns?: string[]
  default_season?: number
  fixed_season?: number
  season_aliases?: Record<string, number>
  latest_episodes?: number
}
export type ConfigChannel = {
  id?: number
  url?: string
  account_id?: string
  series?: string[]
}
export type Config = {
  channels: ConfigChannel[]
  series: Series[]
  categories?: string[]
  ai?: {
    enabled: boolean
    base_url: string
    model: string
    api_key?: string
  }
  download_concurrency: number
  scan_interval_seconds: number
  initial_history_days: number
  edit_lookback_hours: number
  emby_base_url?: string
  // Write-only: the server never includes the saved key in state responses.
  emby_api_key?: string
}
export type Account = {
  id: string
  name: string
  username: string | null
  phone: string
  user_id: number | null
  status: "online" | "offline" | "waiting" | "login_required" | "connecting"
  wait_until: number
  last_error: string | null
  channel_count: number
}
export type Channel = {
  reference: string
  id: number | null
  account_id: string | null
  series: string[]
  last_scanned_message_id: number
  last_success_at: number | null
  first_scan_complete: boolean
  status: string
  error: string | null
}
export type Scan = {
  channel: string
  account_id: string | null
  status: string
  last_error: string | null
  started_at: number | null
  finished_at: number | null
}
export type State = {
  now: number
  counts: Partial<Record<string, number>>
  accounts: Account[]
  channels: Channel[]
  scans: Scan[]
  config: Config
  version: string
  emby: {
    configured: boolean
    requested_generation: number
    acknowledged_generation: number
    last_error: string | null
    next_retry_at: number
  }
  concurrency: number
  selection_ready: boolean
}
export type Task = {
  channel_id: number
  message_id: number
  series_name: string
  document_id: string | number
  expected_size: number
  downloaded_bytes: number
  season: number
  episode: number | null
  extension: string
  status: string
  attempts: number
  next_retry_at: number
  final_path: string | null
  last_error: string | null
  created_at: number
  updated_at: number
  account_id: string | null
  account_name: string | null
}
export type Downloads = {
  items: Task[]
  total: number
  page: number
  page_size: number
}
export type Login = {
  id: string
  state: "code" | "password" | "completed"
  delivery: string
  resend_at: number
  expires_at: number
  account_id?: string
}
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number; retry_at?: number }
export type Filters = {
  page: number
  status: string
  q: string
  series: string
  channel: string
}
export type Write =
  | { action: "login"; name: string; phone: string; account_id?: string }
  | { action: "code"; id: string; code: string }
  | { action: "password"; id: string; password: string }
  | { action: "resend" | "cancel" | "logout"; id: string }
  | { action: "retry"; channel: number; message: number }
  | { action: "scan"; channel?: number; since: string; until: string }
  | { action: "config"; version: string; config: Config }
export type WriteResult = Login | { ok: true; version?: string; count?: number }
