import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
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
  Empty,
  Field,
  Heading,
  Panel,
  Status,
} from "@/components/common"
import { time, useOperation, useWorkspace } from "@/components/workspace"
import type { Account, Login, Write } from "@/lib/types"

export const Route = createFileRoute("/accounts")({ component: Accounts })
function Accounts() {
  const w = useWorkspace(),
    operation = useOperation()
  const [open, setOpen] = useState(false),
    [account, setAccount] = useState<Account | null>(null),
    [logout, setLogout] = useState<Account | null>(null)
  const [flow, setFlow] = useState<Login | null>(null),
    [name, setName] = useState(""),
    [secret, setSecret] = useState(""),
    [now, setNow] = useState(Date.now() / 1000)
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [open])
  const start = (target: Account | null = null) => {
    operation.reset()
    setAccount(target)
    setName(target?.name ?? "")
    setSecret("")
    setFlow(null)
    setOpen(true)
  }
  const close = async () => {
    if (operation.isPending) return
    setSecret("")
    setName("")
    if (flow && flow.state !== "completed") {
      const result = await operation.run({ action: "cancel", id: flow.id })
      if (!result) return
    }
    setFlow(null)
    setAccount(null)
    setOpen(false)
    operation.reset()
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const data: Write = !flow
      ? {
          action: "login",
          name,
          phone: secret,
          ...(account ? { account_id: account.id } : {}),
        }
      : flow.state === "code"
        ? { action: "code", id: flow.id, code: secret }
        : { action: "password", id: flow.id, password: secret }
    setSecret("")
    const result = await operation.run(data)
    if (result && "state" in result) {
      setFlow(result)
      if (result.state === "completed") {
        setName("")
        w.setNotice("Telegram 账号登录完成。请在频道页面指定负责账号。")
      }
    }
  }
  const resend = async () => {
    if (!flow) return
    setSecret("")
    const result = await operation.run({ action: "resend", id: flow.id })
    if (result && "state" in result) setFlow(result)
  }
  const expired = flow && flow.state !== "completed" && now >= flow.expires_at
  const bound = (a: Account) =>
    Math.max(
      a.channel_count,
      w.data?.config.channels.filter((c) => c.account_id === a.id).length ?? 0
    )
  return (
    <>
      <Heading
        title="Telegram 账号"
        description="独立登录多个账号，每个频道指定一个负责账号。"
        action={
          <Button onClick={() => start()} disabled={!!w.error || !w.data}>
            添加账号
          </Button>
        }
      />
      <Panel title="账号列表">
        <DataTable
          headers={[
            "账号",
            "手机号",
            "连接状态",
            "负责频道",
            "等待与错误",
            "操作",
          ]}
          rows={(w.data?.accounts ?? []).map((a) => ({
            key: a.id,
            cells: [
              <div>
                <strong>{a.name}</strong>
                <p className="muted">{a.username ? `@${a.username}` : "—"}</p>
              </div>,
              a.phone,
              <Status value={a.status} />,
              `${bound(a)} 个`,
              <div>
                {time(a.wait_until)}
                <p className="error">{a.last_error}</p>
              </div>,
              <div className="actions">
                <Button
                  variant="outline"
                  disabled={!!w.error}
                  onClick={() => start(a)}
                >
                  重新登录
                </Button>
                <Button
                  variant="ghost"
                  disabled={!!w.error}
                  onClick={() => {
                    operation.reset()
                    setLogout(a)
                  }}
                >
                  退出账号
                </Button>
              </div>,
            ],
          }))}
          empty={
            w.data
              ? "尚未添加账号。点击“添加账号”开始 Telegram 授权。"
              : "等待后端连接。"
          }
        />
      </Panel>
      <p className="notice">
        添加账号 → Telegram 授权 → 为频道指定账号。重新登录由后端校验原 Telegram
        身份，保留现有频道绑定。
      </p>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void close()
        }}
      >
        <DialogContent className="modal" showCloseButton={!operation.isPending}>
          <DialogTitle>
            {account ? `重新登录 ${account.name}` : "添加 Telegram 账号"}
          </DialogTitle>
          <DialogDescription>
            验证码可能投递到 Telegram 客户端。只有启用两步验证时才需要密码。
          </DialogDescription>
          {flow && (
            <div className="notice">
              {flow.state === "completed" ? (
                "授权完成，账号已加入工作空间。"
              ) : (
                <>
                  投递方式：{flow.delivery}
                  <br />
                  到期：{time(flow.expires_at)}
                  {expired && (
                    <p className="error">流程已过期，请关闭并重新发起登录。</p>
                  )}
                </>
              )}
            </div>
          )}
          {flow?.state !== "completed" && (
            <form onSubmit={submit} className="form-stack">
              <fieldset disabled={operation.isPending || !!expired}>
                {!flow && (
                  <Field label="账号备注">
                    <Input
                      required
                      maxLength={80}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="off"
                    />
                  </Field>
                )}
                <Field
                  label={
                    !flow
                      ? "手机号（含国家码）"
                      : flow.state === "code"
                        ? "Telegram 验证码"
                        : "两步验证密码"
                  }
                >
                  <Input
                    key={flow?.state ?? "phone"}
                    required
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    type={
                      !flow
                        ? "tel"
                        : flow.state === "password"
                          ? "password"
                          : "text"
                    }
                    inputMode={flow?.state === "code" ? "numeric" : undefined}
                    pattern={
                      !flow
                        ? "[+][1-9][0-9]{6,14}"
                        : flow.state === "code"
                          ? "[0-9]{4,8}"
                          : undefined
                    }
                    autoComplete="off"
                    maxLength={
                      flow?.state === "password"
                        ? 1024
                        : flow?.state === "code"
                          ? 8
                          : 16
                    }
                  />
                </Field>
              </fieldset>
              <div className="actions">
                <Button
                  type="submit"
                  disabled={operation.isPending || !!expired}
                >
                  {operation.isPending
                    ? "正在提交…"
                    : !flow
                      ? "发送验证码"
                      : "验证并继续"}
                </Button>
                {flow?.state === "code" && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      operation.isPending || now < flow.resend_at || !!expired
                    }
                    onClick={resend}
                  >
                    {now < flow.resend_at
                      ? `${Math.ceil(flow.resend_at - now)} 秒后可重发`
                      : "重发验证码"}
                  </Button>
                )}
              </div>
            </form>
          )}
          {operation.error && (
            <p className="error" role="alert">
              {operation.error.message}
            </p>
          )}
          <Button
            variant="outline"
            disabled={operation.isPending}
            onClick={close}
          >
            {flow?.state === "completed" ? "完成" : "取消并关闭"}
          </Button>
          <small className="muted">
            手机号、验证码与密码在提交后清空，不存入浏览器存储。
          </small>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!logout}
        onOpenChange={(next) => {
          if (!next && !operation.isPending) setLogout(null)
        }}
      >
        <DialogContent showCloseButton={!operation.isPending}>
          <DialogTitle>退出 {logout?.name}</DialogTitle>
          <DialogDescription>
            保留历史任务与媒体文件。退出要求迁移或移除所有绑定频道，并等待该账号的在途任务结束。
          </DialogDescription>
          {logout && (
            <p>
              当前绑定 {bound(logout)}{" "}
              个频道。在途任务由服务端再次检查；有绑定或在途任务时返回冲突。
            </p>
          )}
          {logout && bound(logout) > 0 && (
            <Empty>请先在频道页面迁移绑定并应用配置，再退出。</Empty>
          )}
          {operation.error && (
            <p className="error" role="alert">
              {operation.error.message}
            </p>
          )}
          <div className="actions">
            <Button
              variant="outline"
              disabled={operation.isPending}
              onClick={() => setLogout(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={!logout || bound(logout) > 0 || operation.isPending}
              onClick={async () => {
                if (
                  logout &&
                  (await operation.run(
                    { action: "logout", id: logout.id },
                    "账号已退出，历史与媒体保留。"
                  ))
                )
                  setLogout(null)
              }}
            >
              确认退出账号
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
