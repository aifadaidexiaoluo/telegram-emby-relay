import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DataTable,
  Field,
  Heading,
  Panel,
  SelectInput,
  Status,
} from "@/components/common"
import { time, statusLabels, useWorkspace } from "@/components/workspace"
import { validateConfig } from "@/lib/validation"
import type { ConfigChannel } from "@/lib/types"

export const Route = createFileRoute("/channels")({ component: Channels })
function Channels() {
  const w = useWorkspace(),
    [editing, setEditing] = useState<number | null>(null),
    [remove, setRemove] = useState<number | null>(null)
  const [reference, setReference] = useState(""),
    [account, setAccount] = useState(""),
    [series, setSeries] = useState<string[]>([]),
    [error, setError] = useState("")
  const runtimeOf = (c: ConfigChannel) =>
    w.data?.channels.find(
      (channel) =>
        (c.id !== undefined && channel.id === c.id) ||
        (c.url !== undefined &&
          (channel.reference === c.url ||
            channel.reference ===
              c.url
                .replace("https://t.me/", "@")
                .replace(/\/$/, "")
                .toLowerCase()))
    )
  const start = (index: number) => {
    w.edit((config) => config)
    const channel = w.config?.channels[index]
    setReference(String(channel?.url ?? channel?.id ?? ""))
    setAccount(
      channel?.account_id ??
        (channel ? runtimeOf(channel)?.account_id : undefined) ??
        ""
    )
    setSeries(channel?.series ?? [])
    setError("")
    setEditing(index)
  }
  const eligible =
    w.data?.accounts.filter(
      (a) => a.user_id !== null && a.status !== "login_required"
    ) ?? []
  const save = (event: React.FormEvent) => {
    event.preventDefault()
    if (editing === null || !w.config) return
    try {
      if (!eligible.some((a) => a.id === account))
        throw new Error("请选择已登录的负责账号。")
      const value = reference.trim(),
        previous = editing >= 0 ? w.config.channels[editing] : undefined
      const { id: _id, url: _url, ...rest } = previous ?? {}
      const channel: ConfigChannel = {
        ...rest,
        ...(/^-?\d+$/.test(value) ? { id: Number(value) } : { url: value }),
        account_id: account,
        series,
      }
      const next = structuredClone(w.config)
      if (editing < 0) next.channels.push(channel)
      else next.channels[editing] = channel
      validateConfig(next)
      w.edit(() => next)
      setEditing(null)
      w.setNotice("频道已加入草稿。请检查影响并应用配置。")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "频道格式不正确。")
    }
  }
  return (
    <>
      <Heading
        title="频道"
        description="维护频道白名单、负责账号与允许作品，保留每个频道的扫描游标。"
        action={
          <Button
            disabled={!w.config || w.save.isPending}
            onClick={() => start(-1)}
          >
            添加频道
          </Button>
        }
      />
      <Panel title="已配置频道">
        <DataTable
          headers={[
            "频道",
            "负责账号",
            "允许作品",
            "游标",
            "最近成功 / 状态",
            "操作",
          ]}
          rows={(w.config?.channels ?? []).map((c, i) => {
            const runtime = runtimeOf(c)
            return {
              key: `${c.id ?? c.url}/${i}`,
              cells: [
                c.url ?? c.id,
                w.data?.accounts.find(
                  (a) => a.id === (c.account_id ?? runtime?.account_id)
                )?.name ??
                  c.account_id ??
                  "未绑定",
                c.series.join("、") || "无白名单作品",
                runtime?.last_scanned_message_id ?? "尚未读取",
                <div>
                  {time(runtime?.last_success_at)}
                  <p>
                    {runtime ? (
                      <Status scan value={runtime.status} />
                    ) : (
                      "等待应用或解析"
                    )}
                  </p>
                  <p className="error">{runtime?.error}</p>
                </div>,
                <div className="actions">
                  <Button
                    variant="outline"
                    disabled={w.save.isPending}
                    onClick={() => start(i)}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={w.save.isPending}
                    onClick={() => {
                      w.edit((config) => config)
                      setRemove(i)
                    }}
                  >
                    移除
                  </Button>
                </div>,
              ],
            }
          })}
          empty={
            w.config
              ? "暂无频道。先添加作品与账号，再配置频道白名单。"
              : "等待后端连接后读取频道配置。"
          }
        />
      </Panel>
      <p className="notice">
        新增白名单后，旧历史可能需要手动补扫。切换负责账号保留媒体与游标，但新账号的历史可见范围可能不同。
      </p>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent className="modal">
          <DialogTitle>{editing === -1 ? "添加频道" : "编辑频道"}</DialogTitle>
          <DialogDescription>
            一个频道指定一个已登录账号。服务端验证该账号是否有频道读取权限。
          </DialogDescription>
          <form className="form-stack" onSubmit={save}>
            <Field label="公开 t.me URL 或数值频道 ID">
              <Input
                required
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="https://t.me/channel"
              />
            </Field>
            <Field label="负责账号">
              <SelectInput
                required
                value={account}
                onValueChange={setAccount}
                placeholder="请选择已登录账号"
                options={eligible.map((a) => ({
                  value: a.id,
                  label: `${a.name} · ${statusLabels[a.status] ?? a.status}`,
                }))}
              />
            </Field>
            {!eligible.length && (
              <p className="error">尚无已登录账号，请先在账号页面完成授权。</p>
            )}
            <fieldset className="checkbox-list">
              <legend>允许作品</legend>
              {w.config?.series.map((rule) => (
                <label key={rule.name}>
                  <input
                    type="checkbox"
                    checked={series.includes(rule.name)}
                    onChange={(e) =>
                      setSeries(
                        e.target.checked
                          ? [...series, rule.name]
                          : series.filter((name) => name !== rule.name)
                      )
                    }
                  />
                  {rule.name}
                </label>
              ))}
              {!w.config?.series.length && (
                <p className="error">请先添加作品规则。</p>
              )}
            </fieldset>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="actions">
              <Button
                variant="outline"
                type="button"
                onClick={() => setEditing(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  w.save.isPending ||
                  !eligible.length ||
                  !w.config?.series.length
                }
              >
                保存到草稿
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={remove !== null}
        onOpenChange={(open) => {
          if (!open) setRemove(null)
        }}
      >
        <DialogContent>
          <DialogTitle>
            移除频道{" "}
            {remove !== null &&
              (w.config?.channels[remove]?.url ??
                w.config?.channels[remove]?.id)}
          </DialogTitle>
          <DialogDescription>
            应用后停止监听该频道，并可能取消其未完成任务。已完成媒体、历史任务与游标保留。
          </DialogDescription>
          <div className="actions">
            <Button variant="outline" onClick={() => setRemove(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={w.save.isPending}
              onClick={() => {
                if (remove === null) return
                w.edit((config) => ({
                  ...config,
                  channels: config.channels.filter(
                    (_, index) => index !== remove
                  ),
                }))
                setRemove(null)
                w.setNotice("频道已从草稿移除。请检查影响并应用。")
              }}
            >
              从草稿移除频道
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
