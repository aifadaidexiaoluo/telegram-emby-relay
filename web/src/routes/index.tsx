import { createFileRoute, Link } from "@tanstack/react-router"
import { Heading, Panel, Empty, DataTable, Status } from "@/components/common"
import { time, useWorkspace } from "@/components/workspace"

export const Route = createFileRoute("/")({ component: Overview })
function Overview() {
  const { data: state } = useWorkspace()
  return (
    <>
      <Heading
        title="下载工作台"
        description="关注正在下载的剧集，以及需要处理的等待。"
        action={
          <Link to="/scans" className="button-link">
            补扫历史
          </Link>
        }
      />
      {state ? (
        <>
          <div className="stats">
            {[
              ["下载中", state.counts.downloading ?? 0],
              ["等待下载", state.counts.pending ?? 0],
              ["等待重试", state.counts.retry_wait ?? 0],
              ["下载失败", state.counts.failed ?? 0],
            ].map(([label, count]) => (
              <Panel key={label} title={String(label)}>
                <div className="stat-number">{count}</div>
                <p className="muted">当前任务状态 · 服务端统计</p>
              </Panel>
            ))}
          </div>
          <div className="two-columns">
            <Panel
              title="频道扫描"
              action={<Link to="/scans">查看本轮 →</Link>}
            >
              <p className="notice">
                {state.selection_ready
                  ? "本轮选择已就绪"
                  : "本轮选择尚未就绪；请检查频道与负责账号的等待原因。"}
              </p>
              <DataTable
                headers={["频道", "状态", "最近成功"]}
                rows={state.channels.map((c) => ({
                  key: c.reference,
                  cells: [
                    c.reference,
                    <Status scan value={c.status} />,
                    time(c.last_success_at),
                  ],
                }))}
                empty="还没有频道，请先添加账号与频道。"
              />
            </Panel>
            <Panel title="媒体库集成">
              <dl className="details">
                <dt>Emby</dt>
                <dd>{state.emby.configured ? "已配置" : "未配置"}</dd>
                <dt>待刷新代次</dt>
                <dd>{state.emby.requested_generation}</dd>
                <dt>已接受刷新代次</dt>
                <dd>{state.emby.acknowledged_generation}</dd>
                <dt>下一次重试</dt>
                <dd>{time(state.emby.next_retry_at)}</dd>
                <dt>最近错误</dt>
                <dd>{state.emby.last_error ?? "无"}</dd>
              </dl>
              <p className="muted">
                已完成表示文件发布；刷新被接受后，索引与匹配仍需等待。
              </p>
            </Panel>
          </div>
          <Panel title="作品订阅" action={<Link to="/series">管理规则 →</Link>}>
            <DataTable
              headers={["作品", "最新集数", "别名", "频道数"]}
              rows={state.config.series.map((s) => ({
                key: s.name,
                cells: [
                  s.name,
                  s.latest_episodes ? `最新 ${s.latest_episodes} 集` : "无限量",
                  s.aliases?.join("、") || "—",
                  state.config.channels.length,
                ],
              }))}
            />
          </Panel>
        </>
      ) : (
        <Empty>等待管理服务连接后显示实际统计。导航与设置页面仍可访问。</Empty>
      )}
    </>
  )
}
