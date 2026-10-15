import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.integration.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:13001",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --experimental-strip-types tests/runtime-fixture.ts",
      url: "http://127.0.0.1:18766/internal/state",
      timeout: 15000,
    },
    {
      command: "node .output/server/index.mjs",
      url: "http://127.0.0.1:13001",
      env: {
        HOST: "127.0.0.1",
        PORT: "13001",
        RELAY_TEST_MODE: "1",
        RELAY_TEST_PROXY_URL: "http://127.0.0.1:18766",
        MANAGEMENT_TOKEN: "isolated-node-integration-token",
        WEB_ORIGIN: "http://127.0.0.1:13001",
      },
      timeout: 15000,
    },
  ],
})
