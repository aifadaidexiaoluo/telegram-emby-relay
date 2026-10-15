import { createServerFn } from "@tanstack/react-start"
import { validateFilters, validateWrite } from "./validation"
import type { ApiResult, Downloads, State, WriteResult } from "./types"

export const readState = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApiResult<State>> => {
    const { getState } = await import("./management.server")
    return getState()
  }
)
export const readDownloads = createServerFn({ method: "GET" })
  .validator(validateFilters)
  .handler(async ({ data }): Promise<ApiResult<Downloads>> => {
    const { getDownloads } = await import("./management.server")
    return getDownloads(data)
  })
export const writeManagement = createServerFn({ method: "POST" })
  .validator(validateWrite)
  .handler(async ({ data }): Promise<ApiResult<WriteResult>> => {
    const { mutate } = await import("./management.server")
    return mutate(data)
  })
