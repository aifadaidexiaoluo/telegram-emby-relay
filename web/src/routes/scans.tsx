import { createFileRoute } from "@tanstack/react-router"
import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DataTable,
  Empty,
  Field,
  Heading,
  Panel,
  SelectInput,
  Status,
} from "@/components/common"
import { time, useOperation, useWorkspace } from "@/components/workspace"
import { shanghaiISO } from "@/lib/validation"

export const Route = createFileRoute("/scans")({ component: Scans })
function Scans() {
  const w = useWorkspace(),
    operation = useOperation()
  const [open, setOpen] = useState(false),
    [scope, setScope] = useState("all"),
    [channel, setChannel] = useState(""),
    [since, setSince] = useState(""),
    [until, setUntil] = useState(""),
    [error, setError] = useState("")
  const scopeId = useId()
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError("")
    try {
      const start = shanghaiISO(since),
        end = shanghaiISO(until)
      if (Date.parse(end) <= Date.parse(start))
        throw new Error("结束时间必须晚于开始时间。")
      if (scope === "channel" && !channel) throw new Error("请选择补扫频道。")
      if (
        await operation.run(
          {
            action: "scan",
            since: start,
            until: end,
            ...(scope === "channel" ? { channel: Number(channel) } : {}),
          },
          "补扫请求已接受；请查看本轮扫描状态。"
        )
      )
        setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "时间格式不正确。")
    }
  }
  return (
    <>
      <Heading
        title="扫描记录"
        description="只显示当前轮次，不推断未经采集的历史与进度。"
        action={
          <Button
            disabled={!w.data || !!w.error || !w.data.channels.length}
            onClick={() => {
              operation.reset()
              setError("")
              setOpen(true)
            }}
          >
            补扫历史
          </Button>
        }
      />
      {w.data ? (
        <>
          <p className="notice">
            {w.data.selection_ready
              ? "本轮选择就绪。"
              : "本轮选择尚未就绪，请查看负责账号与频道的等待原因。"}
            正常扫描间隔 {w.data.config.scan_interval_seconds} 秒；编辑回看{" "}
            {w.data.config.edit_lookback_hours} 小时。
          </p>
          <Panel title="本轮频道检查">
            <DataTable
              headers={[
                "频道",
                "负责账号",
                "状态",
                "开始",
                "结束",
                "等待与错误",
              ]}
              rows={w.data.scans.map((scan, i) => ({
                key: `${scan.channel}/${i}`,
                cells: [
                  scan.channel,
                  w.data.accounts.find((a) => a.id === scan.account_id)?.name ??
                    scan.account_id ??
                    "未绑定",
                  <Status scan value={scan.status} />,
                  time(scan.started_at),
                  time(scan.finished_at),
                  scan.last_error ?? "—",
                ],
              }))}
              empty="当前没有扫描记录。配置账号与频道后由服务启动扫描。"
            />
          </Panel>
          <Panel title="频道检查点">
            <DataTable
              headers={["频道", "增量游标", "首次扫描", "最近成功", "当前错误"]}
              rows={w.data.channels.map((c) => ({
                key: c.reference,
                cells: [
                  c.reference,
                  c.last_scanned_message_id,
                  c.first_scan_complete ? "已完成" : "尚未完成",
                  time(c.last_success_at),
                  c.error ?? "—",
                ],
              }))}
            />
          </Panel>
        </>
      ) : (
        <Empty>等待后端连接后读取扫描状态。</Empty>
      )}
      <p className="notice">
        手动补扫按账号串行排队；结束时间不包含，不改变日常增量游标，也不绕过最新集数限制。
      </p>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!operation.isPending) setOpen(next)
        }}
      >
        <DialogContent className="modal" showCloseButton={!operation.isPending}>
          <DialogTitle>补扫历史</DialogTitle>
          <DialogDescription>
            按
            Asia/Shanghai（UTC+08:00）填写。频道无法解析时先检查账号权限；重复或冲突的请求会被拒绝。
          </DialogDescription>
          <form className="form-stack" onSubmit={submit}>
            <fieldset disabled={operation.isPending}>
              <div className="field">
                <span id={scopeId} className="field-label">
                  补扫范围
                </span>
                <RadioGroup
                  value={scope}
                  onValueChange={setScope}
                  aria-labelledby={scopeId}
                  disabled={operation.isPending}
                  className="flex gap-6"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${scopeId}-all`} value="all" />
                    <Label htmlFor={`${scopeId}-all`}>全部已配置频道</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${scopeId}-channel`} value="channel" />
                    <Label htmlFor={`${scopeId}-channel`}>指定频道</Label>
                  </div>
                </RadioGroup>
              </div>
              {scope === "channel" && (
                <Field label="频道">
                  <SelectInput
                    value={channel}
                    onValueChange={setChannel}
                    placeholder="请选择频道"
                    disabled={operation.isPending}
                    required
                    options={
                      w.data?.channels
                        .filter((c) => c.id !== null)
                        .map((c) => ({
                          value: String(c.id),
                          label: c.reference,
                        })) ?? []
                    }
                  />
                </Field>
              )}
              <div className="form-grid">
                <Field label="开始时间">
                  <Input
                    type="datetime-local"
                    required
                    value={since}
                    onChange={(e) => setSince(e.target.value)}
                  />
                </Field>
                <Field label="结束时间（不包含）">
                  <Input
                    type="datetime-local"
                    required
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </Field>
              </div>
            </fieldset>
            {(error || operation.error) && (
              <p role="alert" className="error">
                {error || operation.error?.message}
              </p>
            )}
            <div className="actions">
              <Button
                type="button"
                variant="outline"
                disabled={operation.isPending}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={operation.isPending}>
                {operation.isPending ? "正在提交…" : "提交补扫"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
