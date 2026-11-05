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
import { DataTable, Field, Heading, Panel, Status } from "@/components/common"
import { time, useWorkspace } from "@/components/workspace"
import { validateConfig } from "@/lib/validation"
import type { ConfigChannel } from "@/lib/types"

export const Route = createFileRoute("/channels")({ component: Channels })
function Channels() {
  const w = useWorkspace(),
    [editing, setEditing] = useState<number | null>(null),
    [remove, setRemove] = useState<number | null>(null)
  const [reference, setReference] = useState(""),
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
    setError("")
    setEditing(index)
  }
  const save = (event: React.FormEvent) => {
    event.preventDefault()
    if (editing === null || !w.config) return
    try {
      const value = reference.trim()
      const {
        id: _id,
        url: _url,
        account_id: _account,
        series: _series,
        ...rest
      } = editing >= 0 ? w.config.channels[editing] : {}
      const channel: ConfigChannel = {
        ...rest,
        ...(/^-?\d+$/.test(value) ? { id: Number(value) } : { url: value }),
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
        description="填写频道地址即可，系统自动选择账号并在全部频道中搜索已添加作品。"
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
            "匹配作品",
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
                `全部作品（${w.config?.series.length ?? 0}）`,
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
            填写频道地址即可。系统自动选择有读取权限的已登录账号，匹配所有已添加作品。
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
              <Button type="submit" disabled={w.save.isPending}>
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
