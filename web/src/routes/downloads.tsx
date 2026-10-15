import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import {
  Heading,
  Panel,
  DataTable,
  Field,
  SelectInput,
  Status,
} from "@/components/common"
import {
  size,
  statusLabels,
  time,
  unwrap,
  useOperation,
  useWorkspace,
} from "@/components/workspace"
import { readDownloads } from "@/lib/api"
import type { Filters, Task } from "@/lib/types"

function TaskProgress({ task }: { task: Task }) {
  if (!["downloading", "completed"].includes(task.status))
    return <span className="muted">—</span>
  const downloaded =
    task.status === "completed" ? task.expected_size : task.downloaded_bytes
  const percent =
    task.expected_size > 0
      ? Math.min(100, Math.max(0, (downloaded / task.expected_size) * 100))
      : 0
  return (
    <div className="min-w-32 space-y-1">
      <div className="flex justify-between gap-2 text-xs tabular-nums">
        <span>{percent.toFixed(1)}%</span>
        <span className="muted">
          {size(downloaded)} / {size(task.expected_size)}
        </span>
      </div>
      <Progress
        value={percent}
        aria-label={`${task.series_name} 第${task.episode ?? "未知"}集下载进度`}
      />
    </div>
  )
}

export const Route = createFileRoute("/downloads")({ component: DownloadsPage })
function DownloadsPage() {
  const w = useWorkspace(),
    operation = useOperation(),
    client = useQueryClient()
  const [filters, setFilters] = useState<Filters>({
    page: 1,
    status: "active",
    q: "",
    series: "",
    channel: "",
  })
  const [input, setInput] = useState(filters),
    [detail, setDetail] = useState<Task | null>(null),
    [confirm, setConfirm] = useState(false)
  const query = useQuery({
    queryKey: ["downloads", filters],
    queryFn: async () => unwrap(await readDownloads({ data: filters })),
    refetchInterval: 3000,
    retry: false,
  })
  const current =
    query.data?.items.find(
      (t) =>
        t.channel_id === detail?.channel_id &&
        t.message_id === detail.message_id
    ) ?? detail
  const retryFailedTask = async () => {
    if (!current) return
    if (
      await operation.run(
        {
          action: "retry",
          channel: current.channel_id,
          message: current.message_id,
        },
        "已提交重试；仍遵守白名单与最新集数选择。"
      )
    ) {
      setConfirm(false)
      await client.invalidateQueries({ queryKey: ["downloads"] })
    }
  }
  return (
    <>
      <Heading
        title="下载任务"
        description="查询作品、来源与任务状态；时间均为 Asia/Shanghai。"
        action={
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => query.refetch()}
          >
            刷新任务
          </Button>
        }
      />
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          setFilters({ ...input, page: 1 })
        }}
      >
        <Field label="搜索">
          <Input
            value={input.q}
            placeholder="作品、季集或来源…"
            onChange={(e) => setInput({ ...input, q: e.target.value })}
            maxLength={500}
          />
        </Field>
        <Field label="状态">
          <SelectInput
            value={input.status}
            onValueChange={(status) => setInput({ ...input, status })}
            options={[
              "active",
              "all",
              "downloading",
              "pending",
              "retry_wait",
              "failed",
              "completed",
              "cancelled",
            ].map((value) => ({
              value,
              label:
                value === "active"
                  ? "下载任务（未完成）"
                  : value === "all"
                    ? "全部记录"
                    : statusLabels[value],
            }))}
          />
        </Field>
        <Field label="作品">
          <SelectInput
            value={input.series}
            onValueChange={(series) => setInput({ ...input, series })}
            placeholder="全部作品"
            options={[
              { value: "", label: "全部作品" },
              ...(w.data?.config.series.map((s) => ({
                value: s.name,
                label: s.name,
              })) ?? []),
            ]}
          />
        </Field>
        <Field label="频道">
          <SelectInput
            value={input.channel}
            onValueChange={(channel) => setInput({ ...input, channel })}
            placeholder="全部频道"
            options={[
              { value: "", label: "全部频道" },
              ...(w.data?.channels
                .filter((c) => c.id !== null)
                .map((c) => ({ value: String(c.id), label: c.reference })) ??
                []),
            ]}
          />
        </Field>
        <Button type="submit" disabled={query.isFetching}>
          查询
        </Button>
      </form>
      {filters.status === "cancelled" && (
        <p className="notice">
          此状态包含未选中的候选和配置取消，既有记录无法准确区分原因；不计入失败。
        </p>
      )}
      {query.error && (
        <p role="alert" className="error notice">
          {query.error.message}
          {query.data && " · 保留数据可能已过期。"}
        </p>
      )}
      <Panel
        title="任务列表"
        action={
          <small className="muted">
            {query.isFetching
              ? "正在更新…"
              : query.data
                ? `共 ${query.data.total} 条`
                : "尚未读取"}
          </small>
        }
      >
        <DataTable
          headers={[
            "作品 / 季集",
            "频道 / 负责账号",
            "下载进度",
            "状态",
            "重试时间",
            "操作",
          ]}
          rows={(query.data?.items ?? []).map((t) => ({
            key: `${t.channel_id}/${t.message_id}`,
            cells: [
              <div>
                <strong>{t.series_name}</strong>
                <p className="muted">
                  S{String(t.season).padStart(2, "0")}E
                  {t.episode === null
                    ? "?"
                    : String(t.episode).padStart(3, "0")}
                </p>
              </div>,
              <div>
                {t.channel_id}
                <p className="muted">{t.account_name ?? "未绑定账号"}</p>
              </div>,
              <TaskProgress task={t} />,
              <Status value={t.status} />,
              time(t.next_retry_at),
              <Button
                variant="ghost"
                onClick={() => {
                  operation.reset()
                  setDetail(t)
                  setConfirm(false)
                }}
              >
                详情
              </Button>,
            ],
          }))}
          empty={
            query.isPending
              ? "正在加载任务…"
              : query.error
                ? "无法读取任务，请刷新重试。"
                : "没有符合筛选条件的任务。"
          }
        />
        <div className="pagination">
          <span>
            第 {filters.page} 页 · 每页 {query.data?.page_size ?? 50} 条
          </span>
          <div className="actions">
            <Button
              variant="outline"
              disabled={filters.page <= 1 || query.isFetching}
              onClick={() => setFilters({ ...filters, page: filters.page - 1 })}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              disabled={
                !query.data ||
                filters.page * query.data.page_size >= query.data.total ||
                query.isFetching
              }
              onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
            >
              下一页
            </Button>
          </div>
        </div>
      </Panel>
      <Dialog
        open={!!detail}
        onOpenChange={(next) => {
          if (!next && !operation.isPending) setDetail(null)
        }}
      >
        <DialogContent className="modal" showCloseButton={!operation.isPending}>
          <DialogTitle>任务明细 · {current?.series_name}</DialogTitle>
          <DialogDescription>
            显示本页最近读取的任务数据；文件已完成表示发布成功，不能据此判断
            Emby 已匹配。下载进度每 3 秒更新，100%
            后仍需等待文件发布；失败重试会从头下载。
          </DialogDescription>
          {current && (
            <dl className="details">
              <dt>状态</dt>
              <dd>
                <Status value={current.status} />
              </dd>
              <dt>季 / 集</dt>
              <dd>
                {current.season} / {current.episode ?? "无法识别"}
              </dd>
              <dt>来源频道</dt>
              <dd>{current.channel_id}</dd>
              <dt>消息 ID</dt>
              <dd>{current.message_id}</dd>
              <dt>负责账号</dt>
              <dd>{current.account_name ?? current.account_id ?? "未绑定"}</dd>
              <dt>下载进度</dt>
              <dd>
                <TaskProgress task={current} />
              </dd>
              <dt>声明大小</dt>
              <dd>{size(current.expected_size)}</dd>
              <dt>尝试次数</dt>
              <dd>{current.attempts}</dd>
              <dt>重试时间</dt>
              <dd>{time(current.next_retry_at)}</dd>
              <dt>最近错误</dt>
              <dd>{current.last_error ?? "无"}</dd>
              <dt>目标路径</dt>
              <dd>{current.final_path ?? "尚未发布"}</dd>
              <dt>创建 / 更新</dt>
              <dd>
                {time(current.created_at)} / {time(current.updated_at)}
              </dd>
            </dl>
          )}
          {operation.error && (
            <p role="alert" className="error">
              {operation.error.message}
            </p>
          )}
          {current?.status === "failed" && (
            <>
              {confirm && (
                <p className="notice">
                  确认重试 {current.series_name} 的消息 {current.message_id}
                  ？重试仍执行当前白名单与最新集数规则。
                </p>
              )}
              <Button
                disabled={operation.isPending || !!query.error || !!w.error}
                onClick={() =>
                  confirm ? void retryFailedTask() : setConfirm(true)
                }
              >
                {operation.isPending
                  ? "正在提交…"
                  : confirm
                    ? "确认重试该任务"
                    : "重试失败任务"}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
