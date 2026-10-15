import { createContext, useContext, useRef, useState } from "react"
import type { ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { readState, writeManagement } from "@/lib/api"
import type { ApiResult, Config, State, Write } from "@/lib/types"
import { configImpacts } from "@/lib/validation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok)
    throw new Error(
      `${result.error}${result.retry_at ? `（可重试时间：${time(result.retry_at)}）` : ""}${result.status === 409 ? "（冲突：请等待任务结束或核对最新配置，草稿已保留）" : ""}`
    )
  return result.data
}
export function time(seconds?: number | null) {
  return seconds
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        dateStyle: "short",
        timeStyle: "medium",
      }).format(new Date(seconds * 1000))
    : "—"
}
export function size(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
export const statusLabels: Record<string, string> = {
  online: "在线",
  offline: "离线",
  waiting: "限流等待",
  login_required: "需要重新登录",
  connecting: "连接中",
  downloading: "下载中",
  pending: "等待下载",
  retry_wait: "等待重试",
  completed: "文件已完成",
  failed: "下载失败",
  cancelled: "未放行 / 已取消",
  scanning: "扫描中",
  backfill: "历史补扫中",
  error: "扫描失败",
}
type Draft = { config: Config; version: string; base: Config }
function useWorkspaceValue(initial: ApiResult<State>) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ["state"],
    queryFn: async () => unwrap(await readState()),
    initialData: initial.ok ? initial.data : undefined,
    initialDataUpdatedAt: initial.ok ? initial.data.now * 1000 : undefined,
    refetchInterval: 10000,
    retry: false,
  })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [override, setOverride] = useState(false)
  const save = useMutation({
    mutationFn: async (data: Write) => {
      try {
        return unwrap(await writeManagement({ data }))
      } finally {
        if (data.action === "config") delete data.config.emby_api_key
      }
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["state"] }),
  })
  const edit = (update: (config: Config) => Config) => {
    const state = query.data
    if (!state) return
    setDraft((current) => ({
      config: update(structuredClone(current?.config ?? state.config)),
      version: current?.version ?? state.version,
      base: current?.base ?? structuredClone(state.config),
    }))
  }
  const apply = async () => {
    if (!draft || !query.data) return
    try {
      const result = await save.mutateAsync({
        action: "config",
        version: override ? query.data.version : draft.version,
        config: structuredClone(draft.config),
      })
      const { emby_api_key: _key, ...savedConfig } = draft.config
      if ("version" in result && result.version)
        client.setQueryData<State>(["state"], (old) =>
          old ? { ...old, config: savedConfig, version: result.version! } : old
        )
      setDraft(null)
      setConfirm(false)
      setOverride(false)
      setNotice("配置已应用。")
    } catch {
      /* mutation error is rendered; the entire draft remains intact */
    }
  }
  return {
    ...query,
    error:
      query.error ??
      (!initial.ok && !query.data ? new Error(initial.error) : null),
    draft,
    config: draft?.config ?? query.data?.config,
    edit,
    discard: () => setDraft(null),
    notice,
    setNotice,
    confirm,
    setConfirm,
    override,
    setOverride,
    save,
    apply,
  }
}
type Workspace = ReturnType<typeof useWorkspaceValue>
const Context = createContext<Workspace | null>(null)
export function useWorkspace() {
  const value = useContext(Context)
  if (!value) throw new Error("工作空间未初始化")
  return value
}
export function WorkspaceProvider({
  initial,
  children,
}: {
  initial: ApiResult<State>
  children: ReactNode
}) {
  const value = useWorkspaceValue(initial)
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function ConfigBar() {
  const w = useWorkspace()
  if (!w.draft) return null
  const conflict = w.data && w.data.version !== w.draft.version
  return (
    <>
      <div className="draft-bar">
        <div>
          <strong>配置草稿 · 尚未应用</strong>
          <p>作品、频道与设置一起保存。失败时保留草稿。</p>
          {conflict && (
            <p role="alert">
              服务端版本已改变。可放弃草稿读取新版本，或明确确认覆盖最新配置。
            </p>
          )}
          {w.save.error && (
            <p role="alert" className="error">
              {w.save.error.message}
            </p>
          )}
        </div>
        <div className="actions">
          <Button
            variant="outline"
            disabled={w.save.isPending}
            onClick={w.discard}
          >
            放弃草稿
          </Button>
          <Button
            disabled={w.save.isPending || !!w.error}
            onClick={() => {
              w.setOverride(false)
              w.setConfirm(true)
            }}
          >
            检查并应用
          </Button>
          {conflict && (
            <Button
              variant="destructive"
              disabled={w.save.isPending || !!w.error}
              onClick={() => {
                w.setOverride(true)
                w.setConfirm(true)
              }}
            >
              确认覆盖新版本
            </Button>
          )}
        </div>
      </div>
      <Dialog
        open={w.confirm}
        onOpenChange={(open) => {
          if (!w.save.isPending) w.setConfirm(open)
        }}
      >
        <DialogContent showCloseButton={!w.save.isPending} className="modal">
          <DialogTitle>
            {w.override ? "覆盖最新配置并应用草稿" : "确认配置影响"}
          </DialogTitle>
          <DialogDescription>
            完整配置将原子保存并实时重载；在途下载或补扫未结束时后端会拒绝。已完成的媒体与历史保留。
          </DialogDescription>
          <ul className="impact-list">
            {configImpacts(
              w.override && w.data ? w.data.config : w.draft.base,
              w.draft.config
            ).map((impact, i) => (
              <li key={i}>{impact}</li>
            ))}
          </ul>
          {w.override && (
            <p className="error">
              其他访问者的新配置将被本草稿覆盖，请先核对作品、频道及设置。
            </p>
          )}
          {w.save.error && (
            <p role="alert" className="error">
              {w.save.error.message}
            </p>
          )}
          <div className="actions">
            <Button
              variant="outline"
              disabled={w.save.isPending}
              onClick={() => w.setConfirm(false)}
            >
              继续编辑
            </Button>
            <Button disabled={w.save.isPending} onClick={w.apply}>
              {w.save.isPending ? "正在应用…" : "确认应用"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
export function useOperation() {
  const w = useWorkspace(),
    client = useQueryClient()
  const busy = useRef(false),
    [isPending, setPending] = useState(false),
    [error, setError] = useState<Error | null>(null)
  // Login credentials must not become retained TanStack mutation-cache variables.
  const run = async (data: Write, success?: string) => {
    if (busy.current) return undefined
    busy.current = true
    setPending(true)
    setError(null)
    try {
      const result = unwrap(await writeManagement({ data }))
      await client.invalidateQueries({ queryKey: ["state"] })
      if (success) w.setNotice(success)
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("请求失败，请重试。"))
      return undefined
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { isPending, error, reset: () => setError(null), run }
}
