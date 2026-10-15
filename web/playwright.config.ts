import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:13000",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/mock-management.mjs",
      url: "http://127.0.0.1:18765/test-state",
      timeout: 15000,
    },
    {
      command: "node .output/server/index.mjs",
      url: "http://127.0.0.1:13000",
      env: {
        HOST: "127.0.0.1",
        PORT: "13000",
        RELAY_TEST_MODE: "1",
        RELAY_TEST_PROXY_URL: "http://127.0.0.1:18765",
        MANAGEMENT_TOKEN: "fixture-management-token",
        WEB_ORIGIN: "http://127.0.0.1:13000",
      },
      timeout: 15000,
    },
  ],
})
