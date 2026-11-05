import { test, expect } from "@playwright/test"
import type { APIRequestContext, Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import type { State, Downloads } from "../src/lib/types"

const base = "http://127.0.0.1:18766/internal"
const headers = {
  Authorization: "Bearer isolated-node-integration-token",
}
async function state(request: APIRequestContext): Promise<State> {
  const response = await request.get(`${base}/state`, { headers })
  expect(response.ok()).toBeTruthy()
  return response.json()
}
async function login(
  page: Page,
  name: string,
  phone: string,
  twoFactor: boolean
) {
  await page.getByRole("button", { name: "添加账号", exact: true }).click()
  await page.getByLabel("账号备注", { exact: true }).fill(name)
  await page.getByLabel("手机号（含国家码）").fill(phone)
  await page.getByRole("button", { name: "发送验证码" }).click()
  await page.getByLabel("Telegram 验证码", { exact: true }).fill("55555")
  await page.getByRole("button", { name: "验证并继续" }).click()
  if (twoFactor) {
    await page.getByLabel("两步验证密码", { exact: true }).fill("correct")
    await page.getByRole("button", { name: "验证并继续" }).click()
  }
  await expect(page.getByText("授权完成，账号已加入工作空间。")).toBeVisible()
  await page.getByRole("button", { name: "完成", exact: true }).click()
}

test("Start connects to TypeScript runtime: two accounts, URL channels, global selection and published media", async ({
  page,
  request,
}) => {
  test.setTimeout(60000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/accounts")
  await login(page, "账号甲", "+12025550123", true)
  await login(page, "账号乙", "+12025550124", false)
  const accounts = (await state(request)).accounts
  expect(accounts).toHaveLength(2)
  await page.goto("/settings")
  await page.getByLabel("文件分类（每行一个）").fill("电影\n动漫")
  await page.getByRole("button", { name: "保存设置并检查影响" }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "作品规则" })
    .click()
  await page.getByRole("button", { name: "添加作品" }).click()
  await page.getByLabel("作品名称").fill("吞噬星空")
  await page.getByRole("combobox", { name: "文件分类", exact: true }).click()
  await page.getByRole("option", { name: "动漫", exact: true }).click()
  await page.getByLabel("最新集数", { exact: true }).fill("1")
  await page.getByRole("button", { name: "保存到草稿" }).click()
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "频道", exact: true })
    .click()
  for (const [reference] of [
    ["https://t.me/FixturePrimary", accounts[0].id],
    ["-1009876543210", accounts[1].id],
  ]) {
    await page.getByRole("button", { name: "添加频道" }).click()
    await page.getByLabel("公开 t.me URL 或数值频道 ID").fill(reference)
    await page.getByRole("button", { name: "保存到草稿" }).click()
  }
  await page.getByRole("button", { name: "检查并应用" }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect
    .poll(async () => (await state(request)).counts.completed ?? 0, {
      timeout: 30000,
    })
    .toBe(1)
  const result = await state(request)
  expect(result.selection_ready).toBeTruthy()
  expect(result.concurrency).toBe(2)
  expect(result.channels.map((c) => c.account_id)).toEqual([
    accounts[0].id,
    accounts[0].id,
  ])
  expect(result.channels[0].reference).toBe("@fixtureprimary")
  expect(result.emby.requested_generation).toBe(1)
  const response = await request.get(`${base}/downloads?status=completed`, {
    headers,
  })
  const downloads: Downloads = await response.json()
  expect(downloads.total).toBe(1)
  expect(downloads.items[0].downloaded_bytes).toBe(4)
  expect(downloads.items[0].document_id).toBe("9223372036854700002")
  expect(downloads.items[0].episode).toBe(158)
  expect(downloads.items[0].account_id).toBe(accounts[0].id)
  expect(downloads.items[0].final_path).toContain("/动漫/吞噬星空/")
  expect(readFileSync(downloads.items[0].final_path!).length).toBe(4)
  await page.getByRole("button", { name: "刷新", exact: true }).click()
  const row = page
    .getByRole("row")
    .filter({ hasText: "https://t.me/FixturePrimary" })
  await expect(row).toContainText("账号甲")
  await expect(row).not.toContainText("等待应用或解析")
  await expect(row).toContainText("扫描完成")
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "下载任务" })
    .click()
  await page.getByRole("combobox", { name: "状态", exact: true }).click()
  await page.getByRole("option", { name: "文件已完成", exact: true }).click()
  await page.getByRole("button", { name: "查询", exact: true }).click()
  await expect(page.getByText("共 1 条")).toBeVisible()
  await expect(page.getByRole("table")).toContainText("账号甲")
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "100"
  )
  await page.screenshot({
    path: "test-results/runtime-desktop.png",
    fullPage: true,
  })
  expect(errors).toEqual([])
})
