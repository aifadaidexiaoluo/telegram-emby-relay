import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Empty, Field, Heading, Panel } from "@/components/common"
import { useWorkspace } from "@/components/workspace"
import { validateConfig } from "@/lib/validation"

export const Route = createFileRoute("/settings")({ component: Settings })
const fields = [
  {
    key: "download_concurrency",
    label: "全局下载并发",
    min: 1,
    max: 16,
    help: "所有账号共用，1–16。",
  },
  {
    key: "scan_interval_seconds",
    label: "扫描间隔（秒）",
    min: 30,
    max: Number.MAX_SAFE_INTEGER,
    help: "周期补漏，至少 30 秒。",
  },
  {
    key: "edit_lookback_hours",
    label: "编辑回看（小时）",
    min: 1,
    max: 8760,
    help: "补查近期消息标题与相册变化。",
  },
  {
    key: "initial_history_days",
    label: "首次历史（天）",
    min: 1,
    max: 36500,
    help: "普通无限量作品的初始回扫范围。",
  },
] as const
function Settings() {
  const w = useWorkspace(),
    [error, setError] = useState("")
  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!w.config) return
    const form = new FormData(event.currentTarget),
      next = structuredClone(w.config)
    for (const field of fields) next[field.key] = Number(form.get(field.key))
    next.emby_base_url = String(form.get("emby_base_url") || "")
      .trim()
      .replace(/\/+$/, "")
    const key = String(form.get("emby_api_key") || "").trim()
    if (key) next.emby_api_key = key
    else delete next.emby_api_key
    next.categories = String(form.get("categories") || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
    const aiUrl = String(form.get("ai_base_url") || "")
      .trim()
      .replace(/\/+$/, "")
    const aiModel = String(form.get("ai_model") || "").trim()
    if (aiUrl || aiModel || form.get("ai_enabled")) {
      next.ai = {
        enabled: form.get("ai_enabled") === "on",
        base_url: aiUrl,
        model: aiModel,
      }
      const aiKey = String(form.get("ai_api_key") || "").trim()
      if (aiKey) next.ai.api_key = aiKey
    } else delete next.ai
    try {
      validateConfig(next)
      w.edit(() => next)
      setError("")
      w.setOverride(false)
      w.setConfirm(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "设置格式不正确。")
    }
  }
  return (
    <>
      <Heading
        title="设置"
        description="管理全局下载与扫描策略，查看服务端集成状态。"
      />
      <div className="two-columns">
        <Panel title="下载与扫描">
          {w.config ? (
            <form
              key={w.draft?.version ?? w.data?.version}
              onFocus={() => {
                if (!w.draft) w.edit((config) => config)
              }}
              onSubmit={save}
              className="form-stack"
            >
              <fieldset disabled={w.save.isPending}>
                <div className="form-grid">
                  {fields.map((field) => (
                    <Field
                      key={field.key}
                      label={field.label}
                      help={field.help}
                    >
                      <Input
                        name={field.key}
                        type="number"
                        required
                        min={field.min}
                        max={field.max}
                        step={1}
                        defaultValue={w.config?.[field.key]}
                      />
                    </Field>
                  ))}
                  <Field
                    label="Emby 接口地址"
                    help="填写 API 基地址，如 http://emby:8096/emby；完成下载后自动请求媒体库刷新。"
                  >
                    <Input
                      name="emby_base_url"
                      type="url"
                      required
                      defaultValue={
                        w.config.emby_base_url || "http://emby:8096/emby"
                      }
                      placeholder="http://emby:8096/emby"
                    />
                  </Field>
                  <Field
                    label="Emby API Key"
                    help={
                      w.data?.emby.configured
                        ? "已配置。留空保留现有 Key；填写新 Key 后替换。"
                        : "在 Emby 控制台创建 API Key 后填写。"
                    }
                  >
                    <Input
                      key={w.config.emby_api_key || "saved-key"}
                      name="emby_api_key"
                      type="password"
                      autoComplete="new-password"
                      maxLength={1024}
                      defaultValue={w.config.emby_api_key || ""}
                      placeholder="填写 API Key"
                    />
                  </Field>
                </div>
                <Field
                  label="文件分类（每行一个）"
                  help="例如电影、动漫。作品选择分类后保存到媒体根目录下的同名目录；未分类仍使用 TV。删除前需先调整使用该分类的作品。"
                >
                  <Textarea
                    name="categories"
                    rows={4}
                    defaultValue={w.config.categories?.join("\n") ?? ""}
                    placeholder={"电影\n动漫"}
                  />
                </Field>
                <Field
                  label="AI 剧名与集数识别"
                  help="先按作品名称、别名和排除词筛选；命中后仍无法确定作品或集数时调用 AI。消息文字、相册文字与文件名会发送给你配置的接口；不会上传视频。"
                >
                  <label>
                    <input
                      type="checkbox"
                      name="ai_enabled"
                      defaultChecked={w.config.ai?.enabled ?? false}
                    />{" "}
                    启用 AI 识别
                  </label>
                </Field>
                <div className="form-grid">
                  <Field
                    label="AI 接口地址"
                    help="兼容 OpenAI 的 API 基地址，例如 https://api.openai.com/v1。"
                  >
                    <Input
                      name="ai_base_url"
                      type="url"
                      defaultValue={w.config.ai?.base_url ?? ""}
                      placeholder="https://api.openai.com/v1"
                    />
                  </Field>
                  <Field label="AI 模型">
                    <Input
                      name="ai_model"
                      defaultValue={w.config.ai?.model ?? ""}
                      placeholder="模型名称"
                    />
                  </Field>
                  <Field
                    label="AI API Key"
                    help="留空保留已保存的 Key；本地无鉴权接口可以不填。保存后不回显。"
                  >
                    <Input
                      name="ai_api_key"
                      type="password"
                      autoComplete="new-password"
                      maxLength={1024}
                      defaultValue={w.config.ai?.api_key ?? ""}
                    />
                  </Field>
                </div>
              </fieldset>
              <p className="notice">
                配置实时应用。存在在途下载或补扫时服务端拒绝保存，请等待结束后重试；失败保留草稿。
              </p>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={w.save.isPending || !!w.error}>
                保存设置并检查影响
              </Button>
            </form>
          ) : (
            <Empty>等待后端连接后读取设置。</Empty>
          )}
        </Panel>
        <div className="stack">
          <Panel title="连接与账号">
            <dl className="details">
              <dt>Telegram 账号</dt>
              <dd>
                {w.data?.accounts.length ?? "—"}{" "}
                <Link to="/accounts">管理账号 →</Link>
              </dd>
              <dt>Emby 配置</dt>
              <dd>
                {w.data
                  ? w.data.emby.configured
                    ? "已配置"
                    : "未配置"
                  : "尚未读取"}
              </dd>
              <dt>最近刷新错误</dt>
              <dd>{w.data?.emby.last_error ?? "无已读取错误"}</dd>
              <dt>配置版本</dt>
              <dd className="mono">{w.data?.version ?? "尚未读取"}</dd>
            </dl>
            <p className="muted">
              Telegram 应用凭据由服务端配置；Emby 地址与 Key
              可在左侧填写，保存后不回显 Key。
            </p>
          </Panel>
          <Panel title="界面主题">
            <p>通过右上角月亮按钮切换明暗主题。仅主题偏好保存在浏览器。</p>
            <p className="muted">
              shadcn/ui · base-luma · b6tOz2I0x
              <br />
              Geist / Hugeicons · 桌面工作台
            </p>
          </Panel>
        </div>
      </div>
    </>
  )
}
