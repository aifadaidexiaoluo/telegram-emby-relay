import { getRequest, setResponseHeader } from "@tanstack/react-start/server"
import { assertTrustedWrite } from "./validation"
import { getRuntime } from "../server/runtime"
import { ManagementError } from "../server/config"
import type {
  ApiResult,
  Downloads,
  Filters,
  State,
  Write,
  WriteResult,
} from "./types"

async function result<T>(action: () => Promise<T>): Promise<ApiResult<T>> {
  setResponseHeader("Cache-Control", "no-store")
  try {
    return { ok: true, data: await action() }
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ManagementError" &&
      "status" in error &&
      typeof error.status === "number"
    ) {
      const failure = error as ManagementError
      return {
        ok: false,
        status: failure.status,
        error: failure.message,
        ...(failure.retry_at === undefined
          ? {}
          : { retry_at: failure.retry_at }),
      }
    }
    return {
      ok: false,
      status: 503,
      error: "管理服务暂时不可用，请检查连接与存储后重试。",
    }
  }
}
// Browser regression fixtures are explicitly restricted to the isolated loopback API ports.
function testBase() {
  if (process.env.RELAY_TEST_MODE !== "1" || !process.env.RELAY_TEST_PROXY_URL)
    return undefined
  const url = new URL(process.env.RELAY_TEST_PROXY_URL)
  if (
    url.hostname !== "127.0.0.1" ||
    !["18765", "18766"].includes(url.port) ||
    url.protocol !== "http:"
  )
    throw new Error("Invalid isolated test API")
  return url.origin
}
async function fixture<T>(
  path: string,
  method = "GET",
  body?: unknown
): Promise<T> {
  const response = await fetch(testBase() + "/internal" + path, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.MANAGEMENT_TOKEN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  })
  const data = await response.json()
  if (!response.ok)
    throw new ManagementError(
      data.error || "测试服务不可用",
      response.status,
      data.retry_at
    )
  return data as T
}
export function getState(): Promise<ApiResult<State>> {
  return result(async () =>
    testBase() ? fixture<State>("/state") : (await getRuntime()).state()
  )
}
export function getDownloads(data: Filters): Promise<ApiResult<Downloads>> {
  return result(async () =>
    testBase()
      ? fixture<Downloads>(
          `/downloads?${new URLSearchParams({ ...data, page: String(data.page) })}`
        )
      : (await getRuntime()).downloads(data)
  )
}
export async function mutate(data: Write): Promise<ApiResult<WriteResult>> {
  try {
    assertTrustedWrite(getRequest(), process.env.WEB_ORIGIN)
  } catch {
    return {
      ok: false,
      status: 403,
      error: "请求来源或内容类型不受信任，请检查 WEB_ORIGIN 配置。",
    }
  }
  return result(async () => {
    if (!testBase()) return (await getRuntime()).write(data)
    const id = "id" in data ? encodeURIComponent(data.id) : ""
    switch (data.action) {
      case "login":
        return fixture("/account-logins", "POST", {
          name: data.name,
          phone: data.phone,
          ...(data.account_id ? { account_id: data.account_id } : {}),
        })
      case "code":
        return fixture(`/account-logins/${id}/code`, "POST", {
          code: data.code,
        })
      case "password":
        return fixture(`/account-logins/${id}/password`, "POST", {
          password: data.password,
        })
      case "resend":
        return fixture(`/account-logins/${id}/resend`, "POST", {})
      case "cancel":
        return fixture(`/account-logins/${id}`, "DELETE")
      case "logout":
        return fixture(`/accounts/${id}/logout`, "POST", {})
      case "retry":
        return fixture(
          `/downloads/${data.channel}/${data.message}/retry`,
          "POST",
          {}
        )
      case "scan":
        return fixture("/scans", "POST", {
          since: data.since,
          until: data.until,
          ...(data.channel === undefined ? {} : { channel: data.channel }),
        })
      case "config":
        return fixture("/config", "PUT", {
          version: data.version,
          config: data.config,
        })
    }
  })
}
