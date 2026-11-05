import assert from "node:assert/strict"
import { test } from "node:test"
import { identifyMedia } from "../src/server/ai.ts"
import { defaults, finalPath } from "../src/server/config.ts"
import { mediaMessage, PRIMARY } from "./fake-telegram.ts"
import type { Config } from "../src/lib/types.ts"

const config: Config = {
  ...defaults,
  series: [
    { name: "吞噬星空", exclude_keywords: ["预告"], latest_episodes: 2 },
  ],
  ai: {
    enabled: true,
    base_url: "https://ai.test/v1/",
    model: "test-model",
    api_key: "private-key",
  },
}
const names = ["吞噬星空"]
const answer =
  (result: unknown): typeof fetch =>
  async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(result) } }],
    })

test("AI resolves unknown titles and episodes using only metadata and configured works", async () => {
  const message = mediaMessage(1, "Swallowed Star EP159")
  const candidate = await identifyMedia(
    config,
    PRIMARY,
    names,
    message,
    "album text",
    async (url, init) => {
      assert.equal(url, "https://ai.test/v1/chat/completions")
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer private-key"
      )
      const body = JSON.parse(String(init?.body))
      const input = JSON.parse(body.messages[1].content)
      assert.equal(body.model, "test-model")
      assert.equal(input.text, message.text)
      assert.equal(input.album, "album text")
      assert.equal(input.filename, "video.mp4")
      assert.equal(input.works[0].name, names[0])
      assert.equal(input.document, undefined)
      return answer({ series_name: names[0], season: 1, episode: 159 })(
        url,
        init
      )
    }
  )
  assert.equal(candidate?.episode, 159)
  assert.equal(candidate.series_name, names[0])
  assert.ok(
    finalPath("/media", candidate, "动漫").startsWith(
      "/media/动漫/吞噬星空/Season 01/"
    )
  )
  assert.ok(finalPath("/media", candidate).startsWith("/media/TV/"))
})

test("known episodes and disabled AI never call the provider", async () => {
  const unused: typeof fetch = async () => {
    throw new Error("provider should not run")
  }
  const known = await identifyMedia(
    config,
    PRIMARY,
    names,
    mediaMessage(1, "吞噬星空 第159集"),
    "",
    unused
  )
  assert.equal(known?.episode, 159)
  const disabled = await identifyMedia(
    { ...config, ai: { ...config.ai!, enabled: false } },
    PRIMARY,
    names,
    mediaMessage(2, "unknown"),
    "",
    unused
  )
  assert.equal(disabled, null)
  assert.equal(
    await identifyMedia(
      config,
      PRIMARY,
      names,
      { id: 3, text: "text only", date: 1 },
      "",
      unused
    ),
    null
  )
})

test("AI cannot bypass exclusions, fixed seasons, limits or configured titles", async () => {
  const message = mediaMessage(1, "unknown 预告")
  assert.equal(
    await identifyMedia(
      config,
      PRIMARY,
      names,
      message,
      "",
      answer({ series_name: names[0], season: 1, episode: 159 })
    ),
    null
  )
  assert.equal(
    await identifyMedia(
      config,
      PRIMARY,
      names,
      mediaMessage(1, "unknown"),
      "",
      answer({ series_name: names[0], season: 1, episode: null })
    ),
    null
  )
  assert.equal(
    await identifyMedia(
      config,
      PRIMARY,
      names,
      message,
      "",
      answer({ series_name: null })
    ),
    null
  )
  for (const result of [
    { series_name: "invented", season: 1, episode: 1 },
    { series_name: names[0], season: 100, episode: 1 },
    { series_name: names[0], season: 1, episode: 1.5 },
    { series_name: names[0], season: 1, episode: -1 },
  ]) {
    await assert.rejects(
      identifyMedia(config, PRIMARY, names, message, "", answer(result)),
      /范围/
    )
  }
  const fixed = {
    ...config,
    series: [{ ...config.series[0], fixed_season: 3 }],
  }
  const task = await identifyMedia(
    fixed,
    PRIMARY,
    names,
    mediaMessage(1, "unknown"),
    "",
    answer({ series_name: names[0], season: 1, episode: 5 })
  )
  assert.equal(task?.season, 3)
})

test("provider failures and malformed responses are retryable errors without exposing provider text", async () => {
  const message = mediaMessage(1, "unknown")
  await assert.rejects(
    identifyMedia(
      config,
      PRIMARY,
      names,
      message,
      "",
      async () => new Response("sensitive-provider-error", { status: 429 })
    ),
    /AI 识别请求失败 \(429\)/
  )
  await assert.rejects(
    identifyMedia(config, PRIMARY, names, message, "", async () =>
      Response.json({ choices: [{ message: { content: "not json" } }] })
    ),
    /有效 JSON/
  )
  await assert.rejects(
    identifyMedia(config, PRIMARY, names, message, "", async () =>
      Response.json({})
    ),
    /缺少/
  )
})
