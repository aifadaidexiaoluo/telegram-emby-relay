import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const api = "http://127.0.0.1:18765"
async function control(
  request: APIRequestContext,
  body: Record<string, unknown>
) {
  expect(
    (await request.post(`${api}/test-control`, { data: body })).ok()
  ).toBeTruthy()
}
test.beforeEach(async ({ request }) => control(request, { reset: true }))
test("empty workspace renders seven Chinese routes and desktop themes at target widths", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto("/")
    await expect(
      page.getByRole("heading", { name: "下载工作台" })
    ).toBeVisible()
    await expect(page.getByRole("navigation").getByRole("link")).toHaveCount(7)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBeTruthy()
  }
  for (const [path, name] of [
    ["/downloads", "下载任务"],
    ["/series", "作品规则"],
    ["/accounts", "Telegram 账号"],
    ["/channels", "频道"],
    ["/scans", "扫描记录"],
    ["/settings", "设置"],
  ]) {
    await page.goto(path)
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBeTruthy()
  }
  const theme = page.getByRole("button", { name: "切换明暗主题" })
  const wasDark = await page
    .locator("html")
    .evaluate((el) => el.classList.contains("dark"))
  await theme.click()
  await expect(theme).toHaveAttribute("aria-pressed", String(!wasDark))
  expect(errors).toEqual([])
})
test("backend unavailable keeps navigation and marks retained data stale", async ({
  page,
  request,
}) => {
  await page.goto("/")
  await control(request, { unavailable: true })
  await page.getByRole("button", { name: "刷新", exact: true }).click()
  await expect(page.getByText("管理服务不可用 · 连接中断")).toBeVisible()
  await expect(page.getByText("保留最后一次数据，可能已过期。")).toBeVisible()
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Telegram 账号" })
    .click()
  await expect(
    page.getByRole("heading", { name: "Telegram 账号", exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(page.getByRole("navigation").getByRole("link")).toHaveCount(7)
  await expect(page.getByText("管理服务不可用 · 连接中断")).toBeVisible()
})
test("phone/code/2FA uses real POSTs, clears credentials on errors and submission, and cancels", async ({
  page,
  request,
}) => {
  await page.goto("/accounts")
  await page.getByRole("button", { name: "添加账号", exact: true }).click()
  await page.getByLabel("账号备注", { exact: true }).fill("测试登录")
  await page.getByLabel("手机号（含国家码）").fill("+12025550123")
  await page.getByRole("button", { name: "发送验证码" }).click()
  await expect(
    page.getByLabel("Telegram 验证码", { exact: true })
  ).toBeVisible()
  await page.getByLabel("Telegram 验证码", { exact: true }).fill("00000")
  await page.getByRole("button", { name: "验证并继续" }).click()
  await expect(
    page.getByRole("alert").getByText("验证码错误，请重试", { exact: false })
  ).toBeVisible()
  await expect(page.getByLabel("Telegram 验证码", { exact: true })).toHaveValue(
    ""
  )
  await page.getByRole("button", { name: "重发验证码", exact: true }).click()
  await expect(page.getByRole("button", { name: /秒后可重发/ })).toBeDisabled()
  await page.getByLabel("Telegram 验证码", { exact: true }).fill("24680")
  await page.getByRole("button", { name: "验证并继续" }).click()
  await expect(page.getByLabel("两步验证密码", { exact: true })).toBeVisible()
  await page.getByLabel("两步验证密码", { exact: true }).fill("wrong")
  await page.getByRole("button", { name: "验证并继续" }).click()
  await expect(page.getByLabel("两步验证密码", { exact: true })).toHaveValue("")
  await page.getByLabel("两步验证密码", { exact: true }).fill("test-password")
  await page.getByRole("button", { name: "验证并继续" }).click()
  await expect(page.getByText("授权完成，账号已加入工作空间。")).toBeVisible()
  await page.getByRole("button", { name: "完成", exact: true }).click()
  await expect(
    page.getByRole("cell").getByText("测试登录", { exact: true })
  ).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "test-password"
  )
  await page.getByRole("button", { name: "添加账号", exact: true }).click()
  await page.getByLabel("账号备注", { exact: true }).fill("取消测试")
  await page.getByLabel("手机号（含国家码）").fill("+12025550124")
  await page.getByRole("button", { name: "发送验证码" }).click()
  await expect(
    page.getByLabel("Telegram 验证码", { exact: true })
  ).toBeVisible()
  await page.getByLabel("Telegram 验证码", { exact: true }).fill("12345")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByRole("button", { name: "添加账号", exact: true }).click()
  await expect(page.getByLabel("手机号（含国家码）")).toHaveValue("")
  const calls = await (await request.get(`${api}/test-requests`)).json()
  expect(
    calls.some(
      (c: { method: string; path: string }) =>
        c.method === "DELETE" && c.path.includes("/account-logins/")
    )
  ).toBeTruthy()
  expect(
    calls
      .filter(
        (c: { path: string }) =>
          c.path.includes("/code") || c.path.includes("/password")
      )
      .every((c: { method: string }) => c.method === "POST")
  ).toBeTruthy()
})
test("no-2FA login supports multiple accounts, relogin guards and bound-account logout", async ({
  page,
  request,
}) => {
  await control(request, { twoFactor: false, seed: true })
  await page.goto("/accounts")
  await page.getByRole("button", { name: "退出账号", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "确认退出账号" })
  ).toBeDisabled()
  await page.getByRole("button", { name: "取消", exact: true }).click()
  await page.getByRole("button", { name: "重新登录", exact: true }).click()
  await page.getByLabel("手机号（含国家码）").fill("+12025550123")
  await page.getByRole("button", { name: "发送验证码" }).click()
  await expect(page.getByRole("alert")).toContainText(
    "账号已授权，无需重复登录"
  )
  await page.getByRole("button", { name: "取消并关闭" }).click()
  await page.getByRole("button", { name: "添加账号", exact: true }).click()
  await page.getByLabel("账号备注", { exact: true }).fill("第二账号")
  await page.getByLabel("手机号（含国家码）").fill("+12025550124")
  await page.getByRole("button", { name: "发送验证码" }).click()
  await page.getByLabel("Telegram 验证码", { exact: true }).fill("24680")
  await page.getByRole("button", { name: "验证并继续" }).click()
  await page.getByRole("button", { name: "完成", exact: true }).click()
  await expect(page.getByRole("row")).toHaveCount(3)
  const row = page.getByRole("row").filter({ hasText: "第二账号" })
  await row.getByRole("button", { name: "退出账号", exact: true }).click()
  await page.getByRole("button", { name: "确认退出账号" }).click()
  await expect(
    page.getByRole("cell").getByText("第二账号", { exact: true })
  ).toHaveCount(0)
})
test("series and channel editors preserve extensions; conflict retains draft until explicit override", async ({
  page,
  request,
}) => {
  await control(request, { seed: true })
  await page.goto("/series")
  await page.getByRole("button", { name: "编辑规则" }).click()
  await page.getByLabel("作品名称").fill("重命名作品")
  await page.getByLabel("最新集数", { exact: true }).fill("3")
  await page.getByRole("button", { name: "保存到草稿" }).click()
  await control(request, { bumpVersion: true })
  await page.getByRole("button", { name: "检查并应用" }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("配置版本冲突")
  await page.getByRole("button", { name: "继续编辑" }).click()
  await expect(page.getByText("重命名作品", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "刷新", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "确认覆盖新版本" })
  ).toBeVisible()
  await page.getByRole("button", { name: "确认覆盖新版本" }).click()
  await expect(page.getByRole("dialog")).toContainText(
    "其他访问者的新配置将被本草稿覆盖"
  )
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await expect(page.getByText("配置已应用。")).toBeVisible()
  let state = await (await request.get(`${api}/test-state`)).json()
  expect(state.config.series[0].extension_field).toEqual({ preserved: true })
  expect(state.config.channels[0].series).toEqual(["重命名作品"])
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "频道", exact: true })
    .click()
  await page.getByRole("button", { name: "编辑", exact: true }).click()
  await page
    .getByLabel("公开 t.me URL 或数值频道 ID")
    .fill("https://t.me/test_channel")
  await page.getByRole("button", { name: "保存到草稿" }).click()
  await page.getByRole("button", { name: "检查并应用" }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  state = await (await request.get(`${api}/test-state`)).json()
  expect(state.config.channels[0].extension_field).toBe("channel-kept")
  expect(state.config.channels[0].id).toBeUndefined()
  expect(state.config.channels[0].url).toBe("https://t.me/test_channel")
})
test("settings save waits for guarded tasks and preserves all values", async ({
  page,
  request,
}) => {
  await control(request, { seed: true, blocked: true })
  await page.goto("/settings")
  await page.getByLabel("全局下载并发").fill("4")
  await page.getByLabel("Emby 接口地址").fill("http://emby-fixture:8096/emby")
  await page.getByLabel("Emby API Key").fill("isolated-emby-key")
  await page.getByRole("button", { name: "保存设置并检查影响" }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("仍有在途下载或补扫")
  await page.getByRole("button", { name: "继续编辑" }).click()
  await expect(page.getByLabel("全局下载并发")).toHaveValue("4")
  await control(request, { blocked: false })
  await page.getByRole("button", { name: "检查并应用" }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const state = await (await request.get(`${api}/test-state`)).json()
  expect(state.config.download_concurrency).toBe(4)
  expect(state.config.emby_base_url).toBe("http://emby-fixture:8096/emby")
  expect(state.config.emby_api_key).toBeUndefined()
  expect(state.emby.configured).toBeTruthy()
  await expect(page.getByLabel("Emby API Key")).toHaveValue("")
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "isolated-emby-key"
  )
})
test("tasks paginate/filter/details/retry and scans submit Shanghai ISO", async ({
  page,
  request,
}) => {
  await control(request, { seed: true })
  await page.goto("/downloads")
  await expect(page.getByText("共 51 条")).toBeVisible()
  await page.getByRole("button", { name: "下一页" }).click()
  await expect(page.getByText("第 2 页", { exact: false })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "详情", exact: true })
  ).toHaveCount(1)
  await page.getByRole("combobox", { name: "状态", exact: true }).click()
  await page.getByRole("option", { name: "下载失败", exact: true }).click()
  await page.getByRole("button", { name: "查询", exact: true }).click()
  await expect(page.getByText("共 1 条")).toBeVisible()
  await page.getByRole("button", { name: "详情", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("测试下载错误")
  await page.getByRole("button", { name: "重试失败任务" }).click()
  await page.getByRole("button", { name: "确认重试该任务" }).click()
  await expect(
    page.getByText("已提交重试；仍遵守白名单与最新集数选择。")
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "扫描记录" })
    .click()
  await page.getByRole("button", { name: "补扫历史" }).click()
  await page.getByLabel("开始时间", { exact: true }).fill("2026-03-12T09:30")
  await page.getByLabel("结束时间（不包含）").fill("2026-03-13T09:30")
  await page.getByRole("button", { name: "提交补扫" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const calls = await (await request.get(`${api}/test-requests`)).json()
  const scan = calls.find((c: { path: string }) => c.path === "/internal/scans")
  expect(scan.body.since).toBe("2026-03-12T09:30:00+08:00")
  expect(scan.body.until).toBe("2026-03-13T09:30:00+08:00")
})
test("UI selects, radio scan scope and live download progress", async ({
  page,
  request,
}) => {
  await control(request, { seed: true })
  await page.goto("/downloads")
  const progress = page.getByRole("table").getByRole("progressbar")
  await expect(progress).toHaveAttribute("aria-valuenow", "25")
  await page.getByRole("combobox", { name: "状态", exact: true }).click()
  await page.keyboard.press("Home")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("combobox", { name: "状态", exact: true })
  ).toContainText("全部记录")
  await page.getByRole("button", { name: "查询", exact: true }).click()
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("progressbar") })
  await row.getByRole("button", { name: "详情", exact: true }).click()
  const detail = page.getByRole("dialog").getByRole("progressbar")
  await expect(detail).toHaveAttribute("aria-valuenow", "25")
  await control(request, { downloadedBytes: 512 * 1024 ** 2 })
  await expect(detail).toHaveAttribute("aria-valuenow", "50", {
    timeout: 8000,
  })
  await page.keyboard.press("Escape")
  await expect(progress).toHaveAttribute("aria-valuenow", "50")
  await row.getByRole("button", { name: "详情", exact: true }).click()
  await control(request, { taskStatus: "completed" })
  await expect(detail).toHaveAttribute("aria-valuenow", "100", {
    timeout: 8000,
  })
  await expect(page.getByRole("dialog")).toContainText("100.0%")
  await page.keyboard.press("Escape")
  await page.goto("/scans")
  await page.getByRole("button", { name: "补扫历史" }).click()
  await page.getByRole("radio", { name: "指定频道", exact: true }).click()
  await page.getByRole("combobox", { name: "频道", exact: true }).click()
  await page.getByRole("option", { name: "-100123", exact: true }).click()
  await page.getByLabel("开始时间", { exact: true }).fill("2026-03-12T09:30")
  await page.getByLabel("结束时间（不包含）").fill("2026-03-13T09:30")
  await page.getByRole("button", { name: "提交补扫" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByRole("button", { name: "补扫历史" }).click()
  await page.getByRole("radio", { name: "全部已配置频道", exact: true }).click()
  await expect(
    page.getByRole("combobox", { name: "频道", exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: "提交补扫" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const calls = await (await request.get(`${api}/test-requests`)).json()
  const scans = calls.filter(
    (c: { path: string }) => c.path === "/internal/scans"
  )
  expect(scans[0].body.channel).toBe(-100123)
  expect(scans[1].body.channel).toBeUndefined()
})

test("untrusted server-function writes are rejected and internal proxy is absent from browser assets", async ({
  page,
  request,
}) => {
  await page.goto("/accounts")
  await page.getByRole("button", { name: "添加账号", exact: true }).click()
  await page.getByLabel("账号备注", { exact: true }).fill("来源检查")
  for (const [origin, contentType] of [
    ["http://evil.example", "application/json"],
    ["http://127.0.0.1:13000", "text/plain"],
  ]) {
    await page.route("**/_server*/**", async (route) => {
      const intercepted = route.request()
      if (intercepted.method() !== "POST") return route.continue()
      const response = await route.fetch({
        headers: {
          ...intercepted.headers(),
          origin,
          "content-type": contentType,
        },
      })
      await route.fulfill({ response })
    })
    await page.getByLabel("手机号（含国家码）").fill("+12025550123")
    const replied = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("_server")
    )
    await page.getByRole("button", { name: "发送验证码" }).click()
    const response = await replied
    if (response.status() < 400) {
      await expect(page.getByRole("alert")).toBeVisible()
      if (contentType === "application/json")
        await expect(page.getByRole("alert")).toContainText("不受信任")
    }
    await expect(page.getByLabel("手机号（含国家码）")).toHaveValue("")
    await page.unroute("**/_server*/**")
  }
  const calls = await (await request.get(`${api}/test-requests`)).json()
  expect(
    calls.filter(
      (c: { path: string; method: string }) =>
        c.path === "/internal/account-logins" && c.method === "POST"
    )
  ).toHaveLength(0)
  const assets = join(process.cwd(), ".output/public/assets")
  const source = readdirSync(assets)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(assets, file), "utf8"))
    .join("\n")
  for (const forbidden of [
    "fixture-management-token",
    "INTERNAL_API_URL",
    "Authorization: `Bearer",
    "/internal/account-logins",
  ])
    expect(source).not.toContain(forbidden)
})
