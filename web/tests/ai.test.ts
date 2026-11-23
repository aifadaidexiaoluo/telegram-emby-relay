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

test("verified absolute mapping permits AI to correct placeholder S01 and convert 248 to S05E40", async () => {
  const configured: Config = {
    ...config,
    series: [
      {
        name: names[0],
        latest_episodes: 3,
        episode_mappings: [
          {
            absolute_start: 209,
            absolute_end: 260,
            season: 5,
            episode_start: 1,
            source: "https://fixture.invalid/season5",
          },
        ],
      },
    ],
  }
  const message = {
    ...mediaMessage(1, "吞噬星空 第248集"),
    document: {
      ...mediaMessage(1, "").document!,
      filename: "吞噬星空.S01E248.mp4",
    },
  }
  const candidate = await identifyMedia(
    configured,
    PRIMARY,
    names,
    message,
    "",
    answer({
      series_name: names[0],
      season: 5,
      episode: 40,
      absolute_episode: 248,
      content_type: "episode",
    })
  )
  assert.equal(candidate?.season, 5)
  assert.equal(candidate.episode, 40)
  assert.equal(candidate.absolute_episode, 248)
  await assert.rejects(
    identifyMedia(
      configured,
      PRIMARY,
      names,
      message,
      "",
      answer({ series_name: names[0], season: 1, episode: 248 })
    ),
    /映射/
  )
})

test("a sibling trailer cannot exclude or classify the main episode", async () => {
  const candidate = await identifyMedia(
    config,
    PRIMARY,
    names,
    mediaMessage(1, "吞噬星空 第100集"),
    "吞噬星空 第100集 吞噬星空 第101集预告",
    answer({
      series_name: names[0],
      season: 1,
      episode: 100,
      content_type: "episode",
    })
  )
  assert.equal(candidate?.content_type, "episode")
})

test("small file size is a hint and does not turn a short main episode into a trailer", async () => {
  const candidate = await identifyMedia(
    config,
    PRIMARY,
    names,
    {
      ...mediaMessage(1, "吞噬星空 第100集"),
      document: {
        ...mediaMessage(1, "").document!,
        size: 7000000,
        duration: 360,
      },
    },
    "",
    answer({
      series_name: names[0],
      season: 1,
      episode: 100,
      content_type: "episode",
      reason: "短篇正片，有完整剧情",
    })
  )
  assert.equal(candidate?.content_type, "episode")
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

test("AI decides season and episode even when local rules already match", async () => {
  const configured: Config = {
    ...config,
    series: [
      {
        ...config.series[0],
        default_season: 1,
        season_aliases: { 年番: 2 },
        episode_patterns: ["S(?P<season>\\d+)E(?P<episode>\\d+)"],
      },
    ],
  }
  let calls = 0
  const candidate = await identifyMedia(
    configured,
    PRIMARY,
    names,
    {
      ...mediaMessage(1, "吞噬星空 年番 第2季 S02E159"),
      document: {
        ...mediaMessage(1, "").document!,
        filename: "Swallowed.Star.S03E05.mp4",
      },
    },
    "吞噬星空 第三季",
    async (url, init) => {
      calls++
      const input = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content
      )
      assert.deepEqual(input.works[0].season_aliases, { 年番: 2 })
      assert.equal(input.works[0].default_season, 1)
      return answer({ series_name: names[0], season: 3, episode: 5 })(url, init)
    }
  )
  assert.equal(calls, 1)
  assert.equal(candidate?.season, 3)
  assert.equal(candidate.episode, 5)
})

test("AI rechecks a season that conflicts with the filename and rejects persistent conflicts", async () => {
  const message = {
    ...mediaMessage(1, "吞噬星空 第15集"),
    document: {
      ...mediaMessage(1, "").document!,
      filename: "Swallowed.Star.S04E15.mp4",
    },
  }
  let calls = 0
  const candidate = await identifyMedia(
    config,
    PRIMARY,
    names,
    message,
    "",
    async (url, init) => {
      calls++
      const input = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content
      )
      assert.equal(input.filename_season, 4)
      if (calls === 2) assert.ok(input.validation_feedback)
      return answer({
        series_name: names[0],
        season: calls === 1 ? 2 : 4,
        episode: 15,
      })(url, init)
    }
  )
  assert.equal(calls, 2)
  assert.equal(candidate?.season, 4)
  let rejectedCalls = 0
  await assert.rejects(
    identifyMedia(config, PRIMARY, names, message, "", async (url, init) => {
      rejectedCalls++
      return answer({ series_name: names[0], season: 2, episode: 15 })(
        url,
        init
      )
    }),
    /分季证据/
  )
  assert.equal(rejectedCalls, 2)
})

test("AI uses a consistent configured season alias when filename lacks a season", async () => {
  const configured: Config = {
    ...config,
    series: [{ ...config.series[0], season_aliases: { 完结季: 4 } }],
  }
  const candidate = await identifyMedia(
    configured,
    PRIMARY,
    names,
    mediaMessage(1, "吞噬星空 完结季 第18集"),
    "",
    answer({ series_name: names[0], season: 4, episode: 18 })
  )
  assert.equal(candidate?.season, 4)
  await assert.rejects(
    identifyMedia(
      configured,
      PRIMARY,
      names,
      mediaMessage(1, "吞噬星空 完结季 第18集"),
      "",
      answer({ series_name: names[0], season: 2, episode: 18 })
    ),
    /分季证据/
  )
})

test("AI must agree with an explicit Chinese season in the caption", async () => {
  const message = mediaMessage(1, "吞噬星空 第三季 第18集")
  await assert.rejects(
    identifyMedia(
      config,
      PRIMARY,
      names,
      message,
      "",
      answer({ series_name: names[0], season: 2, episode: 18 })
    ),
    /分季证据/
  )
  const candidate = await identifyMedia(
    config,
    PRIMARY,
    names,
    message,
    "",
    answer({ series_name: names[0], season: 3, episode: 18 })
  )
  assert.equal(candidate?.season, 3)
  const conflictingFilename = {
    ...message,
    document: { ...message.document!, filename: "Swallowed.Star.S01E101.mp4" },
  }
  const reconciled = await identifyMedia(
    config,
    PRIMARY,
    names,
    conflictingFilename,
    "",
    answer({ series_name: names[0], season: 3, episode: 18 })
  )
  assert.equal(reconciled?.season, 3)
  await assert.rejects(
    identifyMedia(
      config,
      PRIMARY,
      names,
      conflictingFilename,
      "",
      answer({ series_name: names[0], season: 2, episode: 18 })
    ),
    /分季证据/
  )
})

test("AI cannot invent an episode conversion without source evidence", async () => {
  let calls = 0
  const candidate = await identifyMedia(
    config,
    PRIMARY,
    names,
    mediaMessage(1, "吞噬星空 第三季 第94集"),
    "",
    async (url, init) => {
      calls++
      return answer({
        series_name: names[0],
        season: 3,
        episode: calls === 1 ? 16 : 94,
      })(url, init)
    }
  )
  assert.equal(calls, 2)
  assert.equal(candidate?.episode, 94)
})

test("AI rejection or uncertainty never falls back to known local episodes", async () => {
  for (const result of [
    { series_name: null },
    { series_name: names[0], season: null, episode: 159 },
    { series_name: names[0], season: 2, episode: null },
  ]) {
    assert.equal(
      await identifyMedia(
        config,
        PRIMARY,
        names,
        mediaMessage(1, "吞噬星空 第159集"),
        "",
        answer(result)
      ),
      null
    )
  }
})

test("disabled AI and non-media never call the provider", async () => {
  const unused: typeof fetch = async () => {
    throw new Error("provider should not run")
  }
  const known = await identifyMedia(
    { ...config, ai: { ...config.ai!, enabled: false } },
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

test("trailers are explicitly classified without occupying main episode identity", async () => {
  const noCustomExclusions = {
    ...config,
    series: [{ ...config.series[0], exclude_keywords: undefined }],
  }
  for (const text of ["吞噬星空 第160集 预告", "吞噬星空 teaser"]) {
    assert.equal(
      (
        await identifyMedia(
          noCustomExclusions,
          PRIMARY,
          names,
          mediaMessage(1, text),
          "",
          answer({
            series_name: names[0],
            season: 1,
            episode: 160,
            content_type: "episode",
          })
        )
      )?.content_type,
      "trailer"
    )
  }
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

test("AI retries an out-of-range response once with corrective feedback", async () => {
  let calls = 0
  const candidate = await identifyMedia(
    config,
    PRIMARY,
    names,
    mediaMessage(1, "吞噬星空 第48集"),
    "",
    async (url, init) => {
      calls++
      const input = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content
      )
      if (calls === 2)
        assert.match(input.validation_feedback, /episode_evidence/)
      return answer(
        calls === 1
          ? { series_name: names[0], season: 1, episode: 10000 }
          : {
              series_name: names[0],
              season: 1,
              episode: 48,
              content_type: "episode",
            }
      )(url, init)
    }
  )
  assert.equal(calls, 2)
  assert.equal(candidate?.episode, 48)
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
