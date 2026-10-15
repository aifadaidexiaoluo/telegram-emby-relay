import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, Field, Heading, Panel } from "@/components/common"
import { useWorkspace } from "@/components/workspace"
import { validateConfig } from "@/lib/validation"
import type { Series } from "@/lib/types"

export const Route = createFileRoute("/series")({ component: SeriesPage })
function SeriesPage() {
  const w = useWorkspace(),
    [editing, setEditing] = useState<number | null>(null),
    [remove, setRemove] = useState<number | null>(null)
  const [name, setName] = useState(""),
    [limit, setLimit] = useState(""),
    [aliases, setAliases] = useState(""),
    [excludes, setExcludes] = useState(""),
    [advanced, setAdvanced] = useState("{}"),
    [error, setError] = useState("")
  const list = (text: string) =>
    text
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean)
  const edit = (index: number) => {
    w.edit((config) => config)
    const rule = w.config?.series[index],
      json: Record<string, unknown> = { ...rule }
    for (const key of [
      "name",
      "aliases",
      "exclude_keywords",
      "latest_episodes",
    ])
      delete json[key]
    setName(rule?.name ?? "")
    setLimit(
      rule?.latest_episodes === undefined ? "" : String(rule.latest_episodes)
    )
    setAliases(rule?.aliases?.join("\n") ?? "")
    setExcludes(rule?.exclude_keywords?.join("\n") ?? "")
    setAdvanced(JSON.stringify(json, null, 2))
    setError("")
    setEditing(index)
  }
  const save = (event: React.FormEvent) => {
    event.preventDefault()
    if (!w.config || editing === null) return
    try {
      const json: unknown = JSON.parse(advanced)
      if (!json || typeof json !== "object" || Array.isArray(json))
        throw new Error("高级规则必须是 JSON 对象。")
      const old = editing >= 0 ? w.config.series[editing] : undefined
      const rule: Series = {
        ...old,
        default_season: undefined,
        fixed_season: undefined,
        season_aliases: undefined,
        episode_patterns: undefined,
        ...json,
        name: name.trim(),
        aliases: aliases.trim() ? list(aliases) : [name.trim()],
        exclude_keywords: list(excludes),
        latest_episodes: limit === "" ? undefined : Number(limit),
      }
      const next = structuredClone(w.config)
      if (editing < 0) next.series.push(rule)
      else next.series[editing] = rule
      if (old && old.name !== rule.name)
        next.channels = next.channels.map((c) => ({
          ...c,
          series: c.series.map((s) => (s === old.name ? rule.name : s)),
        }))
      validateConfig(next)
      w.edit(() => next)
      setEditing(null)
      w.setNotice("作品已加入草稿。请检查影响并应用配置。")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "规则格式不正确。")
    }
  }
  const removeRule = () => {
    if (!w.config || remove === null) return
    const next = structuredClone(w.config),
      removed = next.series[remove]
    next.series.splice(remove, 1)
    next.channels = next.channels.map((c) => ({
      ...c,
      series: c.series.filter((s) => s !== removed.name),
    }))
    try {
      validateConfig(next)
      w.edit(() => next)
      setRemove(null)
      w.setNotice("作品及频道引用已从草稿移除；应用前将再次确认影响。")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法移除作品。")
    }
  }
  return (
    <>
      <Heading
        title="作品规则"
        description="跨频道合并选择最新季集，以别名、排除词与季号规则控制下载范围。"
        action={
          <Button
            disabled={!w.config || w.save.isPending}
            onClick={() => edit(-1)}
          >
            添加作品
          </Button>
        }
      />
      {w.config && (
        <p className="notice">
          {w.config.series.length} 部作品 ·{" "}
          {w.config.series.some((s) => !s.latest_episodes)
            ? "包含无限量规则，没有固定全局上限。"
            : `限量目标上限 ${w.config.series.reduce((sum, s) => sum + (s.latest_episodes ?? 0), 0)} 集（不代表当前选中或已下载数量）。`}
        </p>
      )}
      <div className="series-grid">
        {w.config?.series.map((rule, index) => (
          <Panel key={rule.name} title={rule.name}>
            <div className="stat-number">
              {rule.latest_episodes ?? "无限量"}
              {rule.latest_episodes && <small> 集</small>}
            </div>
            <p className="muted">
              {rule.fixed_season !== undefined
                ? `固定第 ${rule.fixed_season} 季`
                : "按规则识别季集"}
            </p>
            <div className="chips">
              {rule.aliases?.map((alias, i) => (
                <span key={i}>{alias}</span>
              ))}
            </div>
            <p className="muted">
              排除：{rule.exclude_keywords?.join("、") || "未设置"}
            </p>
            <div className="actions">
              <Button
                variant="outline"
                disabled={w.save.isPending}
                onClick={() => edit(index)}
              >
                编辑规则
              </Button>
              <Button
                variant="ghost"
                disabled={w.save.isPending}
                onClick={() => {
                  setError("")
                  setRemove(index)
                }}
              >
                移除
              </Button>
            </div>
          </Panel>
        ))}
      </div>
      {!w.config?.series.length && (
        <Empty>
          {w.config
            ? "尚未配置作品。添加作品后可在频道中设置白名单。"
            : "等待后端连接后读取作品配置。"}
        </Empty>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent className="modal wide-modal">
          <DialogTitle>
            {editing === -1 ? "添加作品" : "编辑作品规则"}
          </DialogTitle>
          <DialogDescription>
            保存到当前工作空间草稿；作品重命名同步更新频道引用。后端将校验正则、目录冲突与完整配置。
          </DialogDescription>
          <form className="form-stack" onSubmit={save}>
            <div className="form-grid">
              <Field label="作品名称">
                <Input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field
                label="最新集数"
                help="留空表示无限量；限量模式跳过无法识别集数的视频。"
              >
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="作品别名（每行一个）">
                <Textarea
                  value={aliases}
                  onChange={(e) => setAliases(e.target.value)}
                />
              </Field>
              <Field label="排除关键词（每行一个）">
                <Textarea
                  value={excludes}
                  onChange={(e) => setExcludes(e.target.value)}
                />
              </Field>
            </div>
            <details>
              <summary>高级规则 · JSON</summary>
              <Field
                label="高级规则对象"
                help="支持 default_season、fixed_season、season_aliases、episode_patterns；保留现有扩展字段。"
              >
                <Textarea
                  className="code-input"
                  rows={9}
                  value={advanced}
                  onChange={(e) => setAdvanced(e.target.value)}
                  spellCheck={false}
                />
              </Field>
            </details>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="actions">
              <Button
                type="button"
                variant="outline"
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
            移除 {remove !== null && w.config?.series[remove]?.name}
          </DialogTitle>
          <DialogDescription>
            同时移除所有频道对此作品的引用。应用后可能取消未完成任务，历史记录和已完成媒体保留。
          </DialogDescription>
          <p>
            关联频道：
            {remove !== null
              ? w.config?.channels
                  .filter((c) =>
                    c.series.includes(w.config!.series[remove].name)
                  )
                  .map((c) => c.url ?? c.id)
                  .join("、") || "无"
              : "无"}
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="actions">
            <Button variant="outline" onClick={() => setRemove(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={w.save.isPending}
              onClick={removeRule}
            >
              从草稿移除作品和引用
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
