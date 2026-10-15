import { definePlugin } from "nitro"
import { closeRuntime, getRuntime } from "./runtime"

export default definePlugin((app) => {
  if (process.env.RELAY_TEST_MODE === "1" && process.env.RELAY_TEST_PROXY_URL)
    return
  const startup = getRuntime().catch(() => {
    console.error("后台启动失败，请检查配置与状态目录权限")
    process.exitCode = 1
  })
  app.hooks.hook("close", async () => {
    await startup
    await closeRuntime()
  })
})
