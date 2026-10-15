import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  DashboardSquare01Icon,
  Download04Icon,
  Film01Icon,
  UserMultipleIcon,
  SatelliteIcon,
  Clock01Icon,
  Settings01Icon,
  Moon02Icon,
  Layers01Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { readState } from "@/lib/api"
import {
  ConfigBar,
  time,
  useWorkspace,
  WorkspaceProvider,
} from "@/components/workspace"
import appCss from "../styles.css?url"

const pages = [
  { path: "/", title: "总览", icon: DashboardSquare01Icon },
  { path: "/downloads", title: "下载任务", icon: Download04Icon },
  { path: "/series", title: "作品规则", icon: Film01Icon },
  { path: "/accounts", title: "Telegram 账号", icon: UserMultipleIcon },
  { path: "/channels", title: "频道", icon: SatelliteIcon },
  { path: "/scans", title: "扫描记录", icon: Clock01Icon },
  { path: "/settings", title: "设置", icon: Settings01Icon },
] as const
export const Route = createRootRoute({
  loader: () => readState(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Relay · 媒体工作空间" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: Root,
  notFoundComponent: () => (
    <div className="empty">
      <h1>页面不存在</h1>
      <Link to="/">返回工作台</Link>
    </div>
  ),
  shellComponent: ({ children }: { children: ReactNode }) => (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
function Root() {
  const initial = Route.useLoaderData()
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5000, retry: false } },
      })
  )
  return (
    <QueryClientProvider client={client}>
      <WorkspaceProvider initial={initial}>
        <Shell />
      </WorkspaceProvider>
    </QueryClientProvider>
  )
}
function Shell() {
  const w = useWorkspace(),
    path = useRouterState({ select: (state) => state.location.pathname })
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const saved = localStorage.getItem("relay-theme")
    setDark(
      saved === "dark" ||
        (!saved && matchMedia("(prefers-color-scheme: dark)").matches)
    )
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])
  const title = pages.find((page) => page.path === path)?.title ?? "Relay"
  return (
    <>
      <a className="skip" href="#main">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <HugeiconsIcon icon={Layers01Icon} size={30} />
          <div>
            <strong>
              relay<span>.</span>
            </strong>
            <small>MEDIA WORKSPACE</small>
          </div>
        </div>
        <p className="nav-label">工作空间</p>
        <nav aria-label="主导航">
          {pages.map((page) => (
            <Link
              key={page.path}
              to={page.path}
              activeOptions={{ exact: page.path === "/" }}
              activeProps={{ className: "active", "aria-current": "page" }}
            >
              <HugeiconsIcon icon={page.icon} size={19} />
              {page.title}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <p>
            下载服务{" "}
            <Badge variant={w.error || !w.data ? "destructive" : "secondary"}>
              {w.error || !w.data ? "连接中断" : "已连接"}
            </Badge>
          </p>
          <p>Telegram → 本地媒体 → Emby</p>
          <p>{w.data ? `全局并发 ${w.data.concurrency}` : "等待后端连接"}</p>
          <hr />
          <p>本地工作空间</p>
          <small>打开即用 · 无网站登录</small>
        </div>
      </aside>
      <div className="shell">
        <header className="topbar">
          <span className="muted">
            工作空间 / <strong>{title}</strong>
          </span>
          <div className="actions">
            <small className="muted">
              {w.data
                ? `最近读取 ${time(w.dataUpdatedAt / 1000)}`
                : "尚无服务数据"}
              {w.isFetching && " · 正在更新"}
            </small>
            <Button
              variant="ghost"
              size="icon"
              aria-label="切换明暗主题"
              aria-pressed={dark}
              onClick={() => {
                setDark(!dark)
                localStorage.setItem("relay-theme", dark ? "light" : "dark")
              }}
            >
              <HugeiconsIcon icon={Moon02Icon} />
            </Button>
            <Badge variant="outline">PC 工作台</Badge>
            <Button
              variant="outline"
              disabled={w.isFetching}
              onClick={() => w.refetch()}
            >
              刷新
            </Button>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {w.error && (
            <Alert variant="destructive" className="mb-6">
              <AlertTitle>管理服务不可用 · 连接中断</AlertTitle>
              <AlertDescription>
                {w.error.message}
                {w.data && <span>保留最后一次数据，可能已过期。</span>}
                <Button
                  variant="outline"
                  disabled={w.isFetching}
                  onClick={() => w.refetch()}
                >
                  重新连接
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {w.isPending && (
            <div className="loading" role="status">
              正在读取管理服务…
            </div>
          )}
          <div
            aria-live="polite"
            role="status"
            className={w.notice ? "notice" : "sr-only"}
          >
            {w.notice}
          </div>
          <ConfigBar />
          <Outlet />
          <footer>
            Relay · Telegram 媒体管理{" "}
            <span>Asia/Shanghai · TanStack Start + shadcn/ui</span>
          </footer>
        </main>
      </div>
    </>
  )
}
