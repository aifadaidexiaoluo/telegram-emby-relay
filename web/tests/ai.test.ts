import assert from "node:assert/strict"
import { test } from "node:test"
import { identifyMedia } from "../src/server/ai.ts"
import { defaults, finalPath } from "../src/server/config.ts"
import { mediaMessage, PRIMARY } from "./fake-telegram.ts"
import type { Config } from "../src/lib/types.ts"

const config: Config = {
  ...defaults,
  series: [
    {
      name: "吞噬星空",
      aliases: ["Swallowed Star"],
      exclude_keywords: ["预告"],
      latest_episodes: 2,
    },
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

test("AI supplements episodes only for keyword-matched works using metadata", async () => {
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
  const message = mediaMessage(1, "吞噬星空 预告")
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
      mediaMessage(1, "吞噬星空"),
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
      identifyMedia(
        config,
        PRIMARY,
        names,
        mediaMessage(1, "吞噬星空"),
        "",
        answer(result)
      ),
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
    mediaMessage(1, "吞噬星空"),
    "",
    answer({ series_name: names[0], season: 1, episode: 5 })
  )
  assert.equal(task?.season, 3)
})

test("unmatched, excluded and disallowed videos never call AI", async () => {
  let calls = 0
  const provider: typeof fetch = async () => {
    calls++
    throw new Error("provider should not run")
  }
  for (const [text, allowed, album] of [
    ["unrelated video EP159", names, ""],
    ["吞噬星空 第159集 预告", names, ""],
    ["Swallowed Star", names, "预告"],
    ["吞噬星空", [], ""],
  ] as [string, string[], string][]) {
    assert.equal(
      await identifyMedia(
        config,
        PRIMARY,
        allowed,
        mediaMessage(1, text),
        album,
        provider
      ),
      null
    )
  }
  assert.equal(calls, 0)
})

test("explicit titles outside the channel cannot borrow an allowed album title", async () => {
  const scoped: Config = {
    ...config,
    series: [...config.series, { name: "完美世界" }],
  }
  let calls = 0
  assert.equal(
    await identifyMedia(
      scoped,
      PRIMARY,
      names,
      mediaMessage(1, "完美世界 第159集"),
      "吞噬星空 第158集",
      async () => {
        calls++
        throw new Error("provider should not run")
      }
    ),
    null
  )
  assert.equal(calls, 0)
})

test("AI only receives keyword candidates and cannot switch to another allowed work", async () => {
  const scoped: Config = {
    ...config,
    series: [...config.series, { name: "完美世界", latest_episodes: 2 }],
  }
  const allowed = scoped.series.map((rule) => rule.name)
  const provider: typeof fetch = async (url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    assert.deepEqual(
      input.works.map((rule: { name: string }) => rule.name),
      names
    )
    return answer({ series_name: "完美世界", season: 1, episode: 159 })(
      url,
      init
    )
  }
  await assert.rejects(
    identifyMedia(
      scoped,
      PRIMARY,
      allowed,
      mediaMessage(1, "吞噬星空"),
      "",
      provider
    ),
    /范围/
  )
})

test("AI can disambiguate multiple keyword hits and use album keywords", async () => {
  const ambiguous: Config = {
    ...config,
    series: [...config.series, { name: "完美世界", latest_episodes: 2 }],
  }
  const result = answer({ series_name: names[0], season: 1, episode: 159 })
  for (const [text, album] of [
    ["吞噬星空 完美世界", ""],
    ["EP159", "吞噬星空"],
  ]) {
    const candidate = await identifyMedia(
      ambiguous,
      PRIMARY,
      ["吞噬星空", "完美世界"],
      mediaMessage(1, text),
      album,
      result
    )
    assert.equal(candidate?.series_name, names[0])
    assert.equal(candidate.episode, 159)
  }
})

test("provider failures and malformed model responses expose only safe errors", async () => {
  const message = mediaMessage(1, "吞噬星空")
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
