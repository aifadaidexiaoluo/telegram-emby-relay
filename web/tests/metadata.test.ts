import assert from "node:assert/strict"
import { test } from "node:test"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { syncEmbyMetadata } from "../src/server/emby.ts"
import { writeMediaMetadata, referenceContext } from "../src/server/metadata.ts"
import { defaults } from "../src/server/config.ts"
import { identifyMedia } from "../src/server/ai.ts"
import { mediaMessage, PRIMARY } from "./fake-telegram.ts"

test("mainland animation metadata is written with exact season numbers while preserving existing NFO identity", async (t) => {
  const media = mkdtempSync(join(tmpdir(), "relay-metadata-"))
  t.after(() => rmSync(media, { recursive: true, force: true }))
  const folder = join(media, "动漫", "吞噬星空"),
    path = join(folder, "Season 05", "test.mp4")
  mkdirSync(join(folder, "Season 05"), { recursive: true })
  writeFileSync(
    join(folder, "tvshow.nfo"),
    '<tvshow><uniqueid type="tmdb">101172</uniqueid><country>US</country><plot>已有剧情</plot></tvshow>'
  )
  const task = {
    channel_id: PRIMARY,
    message_id: 1,
    series_name: "吞噬星空",
    document_id: "1",
    expected_size: 4,
    extension: ".mp4",
    published_at: 1,
    season: 5,
    episode: 40,
    absolute_episode: 248,
  }
  await writeMediaMetadata(media, task, path, {
    name: "吞噬星空",
    category: "动漫",
    media_type: "animation",
    production_locations: ["中国大陆"],
    genres: ["动画", "科幻"],
  })
  const nfo = readFileSync(join(folder, "tvshow.nfo"), "utf8")
  assert.match(nfo, /<country>中国大陆<\/country>/)
  assert.match(nfo, /<uniqueid type="tmdb">101172<\/uniqueid>/)
  assert.match(nfo, /已有剧情/)
  assert.doesNotMatch(nfo, /<country>US<\/country>/)
  assert.match(
    readFileSync(path.replace(".mp4", ".nfo"), "utf8"),
    /<episode>40<\/episode>/
  )
})

test("Emby metadata updates preserve provider identity and lock reviewed country and genres", async () => {
  const requests: string[] = []
  const original = {
    Id: "127",
    Path: "/mnt/share/动漫/吞噬星空",
    Name: "吞噬星空",
    ProviderIds: { Tmdb: "101172" },
    Overview: "existing",
    ProductionLocations: ["United States"],
    Genres: ["Animation"],
    LockedFields: ["Overview"],
    GenreItems: [{ Name: "Animation", Id: 22 }],
    TagItems: [{ Name: "已有标签", Id: 1 }],
  }
  await syncEmbyMetadata(
    "http://emby.test",
    "test-key",
    [
      {
        name: "吞噬星空",
        category: "动漫",
        media_type: "animation",
        production_locations: ["中国大陆"],
        genres: ["动画", "科幻"],
      },
    ],
    async (url, init) => {
      requests.push(String(url))
      if (String(url).includes("/Items?"))
        return Response.json({ Items: [{ Id: "127", Path: original.Path }] })
      if (String(url).endsWith("/Users")) return Response.json([{ Id: "user" }])
      if (String(url).includes("/Users/user/Items/127"))
        return Response.json(original)
      assert.equal(String(url), "http://emby.test/Items/127")
      assert.equal(init?.method, "POST")
      const body = JSON.parse(String(init.body))
      assert.deepEqual(body.ProviderIds, original.ProviderIds)
      assert.equal(body.Overview, original.Overview)
      assert.deepEqual(body.ProductionLocations, ["中国大陆"])
      assert.deepEqual(body.GenreItems, [{ Name: "动画" }, { Name: "科幻" }])
      assert.ok(
        body.TagItems.some((tag: { Name: string }) => tag.Name === "国产动漫")
      )
      assert.equal(body.PreferredMetadataCountryCode, "CN")
      assert.ok(body.LockedFields.includes("ProductionLocations"))
      assert.ok(body.LockedFields.includes("Overview"))
      assert.ok(body.Tags.includes("国产动漫"))
      return new Response(null, { status: 204 })
    }
  )
  assert.equal(requests.length, 4)
})

test("reference fetching rejects private hosts and credentials without making a request", async () => {
  const result = await referenceContext(
    {
      name: "作品",
      metadata_sources: [
        "http://127.0.0.1/secret",
        "https://localhost/",
        "https://key@animexin.dev/page",
        "https://animexin.dev:444/page",
      ],
    },
    async () => {
      throw new Error("must not fetch")
    }
  )
  assert.deepEqual(result, [null, null, null])
})

test("a website watermark cannot override a different explicit work title", async () => {
  const config = {
    ...defaults,
    series: [{ name: "诛仙" }],
    ai: {
      enabled: true,
      base_url: "https://fixture.invalid",
      model: "fixture",
    },
  }
  const message = {
    ...mediaMessage(1, "《喜羊羊与灰太狼之羊羊快乐的一年》第三集03"),
    document: {
      ...mediaMessage(1, "").document!,
      filename: "喜羊羊与灰太狼第03集_2010国产动漫_诛仙动漫.mp4",
    },
  }
  assert.equal(
    await identifyMedia(config, PRIMARY, ["诛仙"], message, "", async () => {
      throw new Error("must not classify a watermark")
    }),
    null
  )
})
