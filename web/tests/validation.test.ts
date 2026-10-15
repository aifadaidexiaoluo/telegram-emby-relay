import assert from "node:assert/strict"
import { test } from "node:test"
import {
  assertTrustedWrite,
  configImpacts,
  shanghaiISO,
  validateConfig,
  validateFilters,
  validateWrite,
} from "../src/lib/validation.ts"
import type { Config } from "../src/lib/types.ts"

const empty: Config = {
  channels: [],
  series: [],
  download_concurrency: 2,
  scan_interval_seconds: 1800,
  initial_history_days: 7,
  edit_lookback_hours: 24,
}
const request = (
  url: string,
  origin?: string,
  contentType = "application/json",
  extra: Record<string, string> = {}
) =>
  new Request(url, {
    method: "POST",
    headers: {
      ...(origin ? { origin } : {}),
      "content-type": contentType,
      ...extra,
    },
  })
test("write origin allows only explicit origin or exact loopback origin including port", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    assert.doesNotThrow(() =>
      assertTrustedWrite(
        request(`http://${host}:3000/_server/test`, `http://${host}:3000`)
      )
    )
  assert.doesNotThrow(() =>
    assertTrustedWrite(
      request(
        "http://service:3000/_server/test",
        "https://relay.example",
        "application/json; charset=utf-8"
      ),
      "https://relay.example"
    )
  )
  for (const origin of [
    undefined,
    "null",
    "http://localhost:3001",
    "http://localhost.evil:3000",
    "https://localhost:3000",
  ])
    assert.throws(() =>
      assertTrustedWrite(request("http://localhost:3000/_server/test", origin))
    )
  assert.throws(() =>
    assertTrustedWrite(
      request("http://service:3000/_server/test", "http://service:3000")
    )
  )
  assert.throws(() =>
    assertTrustedWrite(
      request(
        "http://service:3000/_server/test",
        "http://localhost:3000",
        "application/json",
        { "x-forwarded-host": "localhost:3000" }
      )
    )
  )
  for (const type of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
  ])
    assert.throws(() =>
      assertTrustedWrite(
        request(
          "http://localhost:3000/_server/test",
          "http://localhost:3000",
          type
        )
      )
    )
})
test("empty management config is valid and unknown properties are not stripped", () => {
  assert.doesNotThrow(() => validateConfig(empty))
  const config = {
    ...empty,
    series: [{ name: "测试作品", extension_field: { preserved: true } }],
    channels: [
      {
        id: -100123,
        account_id: "account-a",
        series: ["测试作品"],
        extension_field: "kept",
      },
    ],
  }
  validateConfig(config)
  assert.deepEqual(config.series[0].extension_field, { preserved: true })
  assert.equal(config.channels[0].extension_field, "kept")
  assert.throws(
    () => validateConfig({ ...empty, channels: [{ id: -100123, series: [] }] }),
    /至少/
  )
})
test("config rejects dangling references, duplicate names, invalid mapping and ambiguous channels", () => {
  const base = { ...empty, series: [{ name: "测试作品" }] }
  assert.throws(
    () =>
      validateConfig({ ...base, channels: [{ id: 1, series: ["未知作品"] }] }),
    /不存在/
  )
  assert.throws(
    () =>
      validateConfig({
        ...base,
        series: [{ name: "测试作品" }, { name: "测试作品" }],
      }),
    /重复/
  )
  assert.throws(
    () =>
      validateConfig({
        ...base,
        channels: [
          { id: 1, url: "https://t.me/channel", series: ["测试作品"] },
        ],
      }),
    /只能/
  )
  assert.throws(
    () =>
      validateConfig({
        ...base,
        series: [{ name: "测试作品", season_aliases: { final: "1" } }],
      }),
    /整数/
  )
  assert.throws(() => validateConfig({ ...base, download_concurrency: 0 }))
})
test("scan sends Shanghai offset independent of machine timezone and rejects inverted ranges", () => {
  assert.equal(shanghaiISO("2026-03-12T09:30"), "2026-03-12T09:30:00+08:00")
  assert.throws(() => shanghaiISO("03/12/2026"))
  assert.throws(
    () =>
      validateWrite({
        action: "scan",
        since: "2026-03-12T09:30:00",
        until: "2026-03-13T09:30:00",
      }),
    /时区/
  )
  assert.throws(
    () =>
      validateWrite({
        action: "scan",
        since: "2026-03-12T09:30:00+08:00",
        until: "2026-03-11T09:30:00+08:00",
      }),
    /晚于/
  )
})
test("write actions and pagination are allowlisted", () => {
  assert.throws(
    () =>
      validateWrite({
        action: "config",
        version: "v1",
        config: { ...empty, extension_field: "中".repeat(90000) },
      }),
    /过大/
  )
  assert.throws(() =>
    validateWrite({ action: "arbitrary-proxy", path: "/secret" })
  )
  assert.throws(() =>
    validateWrite({ action: "login", name: "测试", phone: "123" })
  )
  assert.throws(() =>
    validateWrite({ action: "retry", channel: 1, message: 0 })
  )
  assert.throws(() =>
    validateFilters({ page: 0, status: "all", q: "", series: "", channel: "" })
  )
  assert.throws(() =>
    validateFilters({
      page: 1,
      status: "unknown",
      q: "",
      series: "",
      channel: "",
    })
  )
})
test("destructive config changes list affected channels and series", () => {
  const before = {
    ...empty,
    series: [{ name: "测试作品" }],
    channels: [{ id: -100123, account_id: "account-a", series: ["测试作品"] }],
  }
  const impacts = configImpacts(before, empty)
  assert.ok(impacts.some((v) => v.includes("测试作品")))
  assert.ok(
    impacts.some((v) => v.includes("-100123") && v.includes("媒体保留"))
  )
})
