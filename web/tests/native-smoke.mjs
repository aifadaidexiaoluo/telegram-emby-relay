// Run the built Start application directly, with isolated state and no fixture HTTP proxy.
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { chromium } from "@playwright/test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"

const root = mkdtempSync(join(tmpdir(), "relay-native-smoke-"))
const env = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: "13001",
  WEB_ORIGIN: "http://127.0.0.1:13001",
  TG_API_ID: "0",
  TG_API_HASH: "",
  EMBY_API_KEY: "",
  EMBY_BASE_URL: "http://127.0.0.1:18766/emby",
  DATABASE_PATH: join(root, "downloads.sqlite3"),
  TG_SESSION_PATH: join(root, "telegram.session"),
  CONFIG_PATH: join(root, "configuration/config.json"),
  MEDIA_ROOT: join(root, "media"),
  TEMP_ROOT: join(root, "temp"),
}
delete env.RELAY_TEST_MODE
delete env.RELAY_TEST_PROXY_URL
const child = spawn(process.execPath, [".output/server/index.mjs"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
})
let logs = "",
  browser,
  page
child.stdout.on("data", (data) => {
  logs += data
})
child.stderr.on("data", (data) => {
  logs += data
})
try {
  for (let i = 0; i < 100 && !existsSync(env.DATABASE_PATH); i++)
    await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(
    existsSync(env.DATABASE_PATH),
    "background starts before first page request"
  )
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  await page.goto("http://127.0.0.1:13001/settings", { timeout: 10000 })
  const stalePage = await browser.newPage()
  stalePage.setDefaultTimeout(5000)
  await stalePage.goto("http://127.0.0.1:13001/settings")
  await stalePage.getByLabel("全局下载并发").fill("4")
  await page.getByLabel("Emby 接口地址").fill("http://127.0.0.1:18766/emby")
  await page.getByLabel("Emby API Key").fill("native-isolated-key")
  await page.getByRole("button", { name: "保存设置并检查影响" }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await page.getByText("配置已应用。", { exact: true }).waitFor()
  const config = JSON.parse(readFileSync(env.CONFIG_PATH, "utf8"))
  assert.equal(config.emby_api_key, "native-isolated-key")
  await stalePage.getByRole("button", { name: "保存设置并检查影响" }).click()
  await stalePage.getByRole("button", { name: "确认应用", exact: true }).click()
  await stalePage
    .getByRole("dialog")
    .getByText("配置已被修改，请刷新后重新编辑", { exact: false })
    .waitFor()
  assert.equal(
    JSON.parse(readFileSync(env.CONFIG_PATH, "utf8")).download_concurrency,
    2
  )
  await stalePage.close()
  await page.reload()
  assert.equal(await page.getByLabel("Emby API Key").inputValue(), "")
  assert.ok(!(await page.content()).includes("native-isolated-key"))
  await page.getByLabel("Emby API Key").fill("native-isolated-key")
  await page.getByRole("button", { name: "保存设置并检查影响" }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  for (
    let i = 0;
    i < 50 && (await page.getByLabel("Emby API Key").inputValue());
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(await page.getByLabel("Emby API Key").inputValue(), "")
  console.log(
    "PASS: native Start startup, config save/version conflict, private Key/no echo, same-Key form clearing"
  )
} catch (error) {
  console.error("Native Start smoke failed:", error.message)
  if (page) console.error((await page.locator("body").innerText()).slice(-1500))
  console.error(logs.slice(-1800))
  process.exitCode = 1
} finally {
  await browser?.close()
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 10000)
    if (child.exitCode !== null) {
      clearTimeout(timer)
      resolve()
    } else
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
  })
  const lock = new DatabaseSync(env.DATABASE_PATH + ".runtime-lock.sqlite3")
  try {
    lock.exec("BEGIN EXCLUSIVE; ROLLBACK")
  } catch {
    console.error("FAIL: graceful shutdown did not release state lock")
    process.exitCode = 1
  } finally {
    lock.close()
  }
  rmSync(root, { recursive: true, force: true })
}
