import {
  copyFile,
  link,
  mkdir,
  rename,
  unlink,
  lstat,
  statfs,
  realpath,
  rmdir,
} from "node:fs/promises"
import { openSync, fsyncSync, closeSync, lstatSync } from "node:fs"
import { dirname, join, relative, isAbsolute } from "node:path"
import { finalPath, ManagementError, now, syncDirectory } from "./config.ts"
import { floodSeconds, rpcName } from "./telegram.ts"
import { writeMediaMetadata } from "./metadata.ts"
import type { Candidate, Settings } from "./config.ts"
import { MANUAL_EPISODE } from "./database.ts"
import type { Database, Download } from "./database.ts"
import type { Transport, TelegramEntity } from "./telegram.ts"

export class PermanentDownloadError extends Error {}
function lstatSyncIdentity(path: string) {
  const info = lstatSync(path, { bigint: true })
  return { device: String(info.dev), inode: String(info.ino) }
}
export async function verified(path: string, size: number) {
  try {
    const s = await lstat(path)
    return s.isFile() && !s.isSymbolicLink() && s.size === size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
export async function publish(
  temp: string,
  incoming: string,
  target: string,
  size: number,
  media: string
) {
  if (!(await verified(temp, size))) throw new Error("下载文件大小不符")
  await mkdir(dirname(target), { recursive: true })
  const root = await realpath(media),
    parent = await realpath(dirname(target)),
    rel = relative(root, parent)
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new PermanentDownloadError("目标目录越出媒体目录")
  if (await exists(target)) {
    if (await verified(target, size)) return
    throw new PermanentDownloadError("最终文件冲突，禁止覆盖")
  }
  const staging = join(
    incoming,
    temp
      .split("/")
      .at(-1)!
      .replace(/\.part$/, ".ready")
  )
  await unlink(staging).catch((e) => {
    if (e.code !== "ENOENT") throw e
  })
  try {
    await rename(temp, staging)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    await copyFile(temp, staging)
  }
  if (!(await verified(staging, size))) throw new Error("发布暂存文件大小不符")
  const fd = openSync(staging, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    await link(staging, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!(await verified(target, size)))
      throw new PermanentDownloadError("发布时目标文件冲突，禁止覆盖")
  }
  for (let directory = dirname(target); ; directory = dirname(directory)) {
    syncDirectory(directory)
    if (directory === media) break
  }
  await unlink(staging)
  syncDirectory(incoming)
}
export class Downloader {
  pauseUntil = 0
  reservations = new Map<string, number>()
  incoming: string
  private cleanupTask?: Promise<void>
  private db: Database
  private settings: Settings
  constructor(db: Database, settings: Settings) {
    this.db = db
    this.settings = settings
    this.incoming = join(settings.media, ".incoming")
  }
  tempPath(task: Download) {
    return join(
      this.settings.temp,
      `${task.channel_id}-${task.message_id}.part`
    )
  }
  async prepare() {
    for (const path of [this.settings.media, this.settings.temp, this.incoming])
      await mkdir(path, { recursive: true, mode: 0o700 })
    if (
      (await lstat(this.settings.media)).dev !==
      (await lstat(this.incoming)).dev
    )
      throw new ManagementError("媒体目录与 .incoming 必须在同一文件系统", 503)
  }
  async reclassify(task: Candidate, allowSeriesChange = false) {
    const previous = this.db.sql
      .prepare(
        "SELECT status,final_path,series_name,CAST(document_id AS TEXT) AS document_id,expected_size,season,episode,content_type,absolute_episode,identification_reason FROM downloads WHERE channel_id=? AND message_id=?"
      )
      .get(task.channel_id, task.message_id) as Download | undefined
    if (
      previous?.status !== "completed" ||
      previous.identification_reason === MANUAL_EPISODE ||
      !previous.final_path ||
      (!allowSeriesChange && previous.series_name !== task.series_name) ||
      previous.document_id !== task.document_id ||
      previous.expected_size !== task.expected_size
    )
      return
    const original = previous.final_path
    const target = finalPath(
      this.settings.media,
      task,
      this.db.categories.get(task.series_name)
    )
    if (original === target) {
      if (!(await verified(original, task.expected_size)))
        throw new PermanentDownloadError("原文件缺失或大小不符，拒绝修正元数据")
      await writeMediaMetadata(
        this.settings.media,
        task,
        target,
        this.db.series.get(task.series_name)
      )
      this.db.sql
        .prepare(
          "UPDATE downloads SET content_type=?,absolute_episode=?,identification_reason=? WHERE channel_id=? AND message_id=? AND status='completed'"
        )
        .run(
          task.content_type ?? "episode",
          task.absolute_episode ?? null,
          task.identification_reason ?? null,
          task.channel_id,
          task.message_id
        )
      return
    }
    const root = await realpath(this.settings.media)
    const sourceParent = await realpath(dirname(original))
    const sourceRelative = relative(root, sourceParent)
    if (sourceRelative.startsWith("..") || isAbsolute(sourceRelative))
      throw new PermanentDownloadError("原文件越出媒体目录，拒绝修正分季")
    if (!(await verified(original, task.expected_size)))
      throw new PermanentDownloadError("原文件缺失或大小不符，拒绝修正分季")
    await mkdir(dirname(target), { recursive: true })
    const parent = await realpath(dirname(target))
    const rel = relative(root, parent)
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new PermanentDownloadError("目标目录越出媒体目录")
    try {
      await link(original, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const a = await lstat(original),
        b = await lstat(target)
      if (
        !b.isFile() ||
        b.isSymbolicLink() ||
        a.dev !== b.dev ||
        a.ino !== b.ino
      )
        throw new PermanentDownloadError("分季目标文件冲突，禁止覆盖")
    }
    for (let directory = dirname(target); ; directory = dirname(directory)) {
      syncDirectory(directory)
      if (directory === this.settings.media) break
    }
    await writeMediaMetadata(
      this.settings.media,
      task,
      target,
      this.db.series.get(task.series_name)
    )
    this.db.transaction(() => {
      const updated = this.db.sql
        .prepare(
          "UPDATE downloads SET season=?,episode=?,final_path=?,content_type=?,absolute_episode=?,identification_reason=?,series_name=?,updated_at=? WHERE channel_id=? AND message_id=? AND status='completed' AND document_id=? AND final_path=?"
        )
        .run(
          task.season,
          task.episode,
          target,
          task.content_type ?? "episode",
          task.absolute_episode ?? null,
          task.identification_reason ?? null,
          task.series_name,
          now(),
          task.channel_id,
          task.message_id,
          BigInt(task.document_id),
          original
        )
      if (updated.changes !== 1)
        throw new Error("分季修正时任务发生变化，保留原文件")
      const info = lstatSyncIdentity(original)
      this.db.sql
        .prepare(
          "INSERT OR IGNORE INTO media_cleanup(path,expected_size,device,inode,channel_id,message_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?)"
        )
        .run(
          original,
          task.expected_size,
          info.device,
          info.inode,
          task.channel_id,
          task.message_id,
          "moved",
          now()
        )
      this.db.sql
        .prepare(
          "UPDATE emby_refresh_state SET requested_generation=requested_generation+1,dirty_since=COALESCE(dirty_since,?),last_completed_at=? WHERE id=1"
        )
        .run(now(), now())
      this.db.selectLatest()
    })
    await this.cleanup()
  }
  cleanup() {
    this.cleanupTask ??= this.cleanFiles().finally(() => {
      this.cleanupTask = undefined
    })
    return this.cleanupTask
  }
  private async cleanFiles() {
    const trailers = this.db.sql
      .prepare(
        "SELECT channel_id,message_id,series_name,season,episode,absolute_episode,expected_size,final_path FROM downloads WHERE content_type='trailer' AND status='completed' AND final_path IS NOT NULL"
      )
      .all()
    for (const trailer of trailers) {
      const main = this.db.sql
        .prepare(
          `SELECT channel_id,message_id,final_path,expected_size FROM downloads WHERE series_name=? AND content_type='episode' AND status='completed' AND matched=1 AND final_path IS NOT NULL AND
         ((? IS NOT NULL AND absolute_episode=?) OR ((absolute_episode IS NULL OR ? IS NULL) AND season=? AND episode=?) OR (? IS NULL AND season=? AND episode IS NOT NULL)) ORDER BY channel_id,message_id LIMIT 1`
        )
        .get(
          trailer.series_name,
          trailer.absolute_episode,
          trailer.absolute_episode,
          trailer.absolute_episode,
          trailer.season,
          trailer.episode,
          trailer.episode,
          trailer.season
        )
      if (
        !main ||
        !(await verified(String(main.final_path), Number(main.expected_size)))
      )
        continue
      if (
        !(await verified(
          String(trailer.final_path),
          Number(trailer.expected_size)
        ))
      )
        continue
      const info = lstatSyncIdentity(String(trailer.final_path))
      this.db.sql
        .prepare(
          "INSERT OR IGNORE INTO media_cleanup(path,expected_size,device,inode,channel_id,message_id,reason,replacement_channel,replacement_message,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
        )
        .run(
          trailer.final_path,
          trailer.expected_size,
          info.device,
          info.inode,
          trailer.channel_id,
          trailer.message_id,
          "replaced_trailer",
          main.channel_id,
          main.message_id,
          now()
        )
    }
    for (const job of this.db.sql
      .prepare("SELECT * FROM media_cleanup ORDER BY created_at")
      .all()) {
      const path = String(job.path)
      try {
        const root = await realpath(this.settings.media)
        const parent = await realpath(dirname(path))
        const rel = relative(root, parent)
        if (rel.startsWith("..") || isAbsolute(rel))
          throw new Error("清理路径越出媒体目录")
        if (job.reason === "replaced_trailer") {
          const main = this.db.sql
            .prepare(
              "SELECT final_path,expected_size,series_name,season,episode,absolute_episode FROM downloads WHERE channel_id=? AND message_id=? AND content_type='episode' AND status='completed' AND matched=1"
            )
            .get(job.replacement_channel, job.replacement_message)
          const trailer = this.db.sql
            .prepare(
              "SELECT content_type,final_path,series_name,season,episode,absolute_episode FROM downloads WHERE channel_id=? AND message_id=?"
            )
            .get(job.channel_id, job.message_id)
          if (
            !main?.final_path ||
            !(await verified(
              String(main.final_path),
              Number(main.expected_size)
            )) ||
            trailer?.content_type !== "trailer" ||
            trailer.final_path !== path ||
            main.series_name !== trailer.series_name ||
            !(trailer.episode === null
              ? main.season === trailer.season
              : trailer.absolute_episode !== null &&
                  main.absolute_episode !== null
                ? trailer.absolute_episode === main.absolute_episode
                : main.season === trailer.season &&
                  main.episode === trailer.episode)
          )
            throw new Error("正片或预告状态已改变，保留文件")
        } else {
          if (
            this.db.sql
              .prepare("SELECT 1 FROM downloads WHERE final_path=?")
              .get(path)
          )
            throw new Error("文件仍被媒体记录引用，保留文件")
          const moved = this.db.sql
            .prepare(
              "SELECT final_path,expected_size FROM downloads WHERE channel_id=? AND message_id=? AND status='completed'"
            )
            .get(job.channel_id, job.message_id)
          if (
            !moved?.final_path ||
            !(await verified(
              String(moved.final_path),
              Number(moved.expected_size)
            ))
          )
            throw new Error("迁移目标缺失，保留原文件")
          const destination = lstatSyncIdentity(String(moved.final_path))
          if (
            destination.device !== job.device ||
            destination.inode !== job.inode
          )
            throw new Error("迁移目标身份不符，保留原文件")
        }
        if (await exists(path)) {
          const info = lstatSyncIdentity(path)
          if (
            !(await verified(path, Number(job.expected_size))) ||
            info.device !== job.device ||
            info.inode !== job.inode
          )
            throw new Error("清理文件身份已改变，保留文件")
          await unlink(path)
          syncDirectory(dirname(path))
        }
        this.db.transaction(() => {
          if (job.reason === "replaced_trailer") {
            this.db.sql
              .prepare(
                "UPDATE downloads SET status='cancelled',matched=0,final_path=NULL,last_error='同集正片已发布，预告已自动清理',updated_at=? WHERE channel_id=? AND message_id=? AND content_type='trailer' AND final_path=?"
              )
              .run(now(), job.channel_id, job.message_id, path)
            this.db.sql
              .prepare(
                "UPDATE emby_refresh_state SET requested_generation=requested_generation+1,dirty_since=COALESCE(dirty_since,?),last_completed_at=? WHERE id=1"
              )
              .run(now(), now())
          }
          this.db.sql
            .prepare("DELETE FROM media_cleanup WHERE path=?")
            .run(path)
        })
        for (
          let directory = dirname(path);
          relative(root, directory).split("/").length > 2;
          directory = dirname(directory)
        ) {
          try {
            await rmdir(directory)
          } catch (error) {
            if (
              ["ENOTEMPTY", "EEXIST", "ENOENT"].includes(
                (error as NodeJS.ErrnoException).code ?? ""
              )
            )
              break
            throw error
          }
        }
      } catch (error) {
        this.db.sql
          .prepare("UPDATE media_cleanup SET last_error=? WHERE path=?")
          .run(
            error instanceof Error ? error.message : "清理失败，等待重试",
            path
          )
      }
    }
  }
  async recover() {
    this.db.sql.exec(
      "UPDATE downloads SET status='pending',next_retry_at=0 WHERE status='downloading'"
    )
    for (const task of this.db.tasks()) {
      if (task.status === "completed") continue
      if (!this.db.channels.get(task.channel_id)?.includes(task.series_name)) {
        this.db.update(task, {
          status: "cancelled",
          last_error: "当前频道或作品已移出白名单",
        })
        continue
      }
      const target = finalPath(
        this.settings.media,
        task,
        this.db.categories.get(task.series_name)
      )
      if (await exists(target)) {
        if (await verified(target, task.expected_size))
          this.db.completed(task, target)
        else
          this.db.update(task, {
            status: "failed",
            last_error: "最终文件冲突，保留文件等待人工处理",
          })
      }
      for (const path of [
        this.tempPath(task),
        join(this.incoming, `${task.channel_id}-${task.message_id}.ready`),
      ])
        await unlink(path).catch((e) => {
          if (e.code !== "ENOENT") throw e
        })
    }
    await this.cleanup()
  }
  async process(
    task: Download,
    client: Transport,
    entity: TelegramEntity,
    flood: (seconds: number) => void,
    unauthorized: () => void
  ) {
    const key = `${task.channel_id}:${task.message_id}`,
      original = task.attempts
    try {
      if (!this.db.channels.get(task.channel_id)?.includes(task.series_name)) {
        this.db.update(task, {
          status: "cancelled",
          last_error: "当前频道或作品已移出白名单",
        })
        return
      }
      const target = finalPath(
        this.settings.media,
        task,
        this.db.categories.get(task.series_name)
      )
      if (await exists(target)) {
        if (!(await verified(target, task.expected_size)))
          throw new PermanentDownloadError("最终文件冲突，禁止覆盖")
        await writeMediaMetadata(
          this.settings.media,
          task,
          target,
          this.db.series.get(task.series_name)
        )
        this.db.completed(task, target)
        await this.cleanup()
        return
      }
      this.reservations.set(key, task.expected_size)
      for (const path of [this.settings.temp, this.settings.media]) {
        const disk = await statfs(path)
        const reserved = [...this.reservations.values()].reduce(
          (a, b) => a + b,
          0
        )
        if (disk.bavail * disk.bsize < reserved + 64 * 1024 * 1024)
          throw Object.assign(new Error("磁盘空间不足"), { code: "ENOSPC" })
      }
      this.db.update(task, { attempts: ++task.attempts })
      const source = (await client.messages(entity, [task.message_id]))[0]
      if (!source?.document)
        throw new PermanentDownloadError("源消息或媒体已删除")
      if (
        source.document.id !== task.document_id ||
        source.document.size !== task.expected_size
      )
        throw new PermanentDownloadError("源媒体已被替换")
      const temp = this.tempPath(task)
      await unlink(temp).catch((e) => {
        if (e.code !== "ENOENT") throw e
      })
      await client.download(entity, task.message_id, temp, source.document)
      const classification = this.db.sql
        .prepare(
          "SELECT content_type,matched FROM downloads WHERE channel_id=? AND message_id=?"
        )
        .get(task.channel_id, task.message_id)
      if (
        classification?.content_type !== "episode" ||
        classification.matched !== 1
      ) {
        await unlink(temp)
        this.db.update(task, {
          status: "cancelled",
          last_error: "下载期间识别结果改变，等待重新选集",
        })
        return
      }
      await publish(
        temp,
        this.incoming,
        target,
        task.expected_size,
        this.settings.media
      )
      await writeMediaMetadata(
        this.settings.media,
        task,
        target,
        this.db.series.get(task.series_name)
      )
      this.db.completed(task, target)
      await this.cleanup()
      await unlink(temp).catch((e) => {
        if (e.code !== "ENOENT") console.error("临时文件清理失败", e.code)
      })
    } catch (error) {
      const seconds = floodSeconds(error),
        name = rpcName(error),
        code = (error as NodeJS.ErrnoException).code
      if (seconds !== undefined) {
        flood(seconds)
        this.db.update(task, {
          status: "retry_wait",
          attempts: original,
          next_retry_at: now() + seconds + 1,
          last_error: `Telegram 限流 ${seconds}s`,
        })
      } else if (
        /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(name)
      ) {
        unauthorized()
        this.db.update(task, {
          status: "retry_wait",
          attempts: original,
          next_retry_at: now() + 60,
          last_error: "Telegram 会话失效，需要重新登录",
        })
      } else if (
        error instanceof PermanentDownloadError ||
        /CHANNEL_PRIVATE|MESSAGE_ID_INVALID|MEDIA_REPLACED|MEDIA_DELETED/.test(
          name
        )
      )
        this.db.update(task, {
          status: "failed",
          last_error:
            error instanceof PermanentDownloadError
              ? error.message
              : "频道或消息不可访问",
        })
      else if (["ENOSPC", "EDQUOT", "EACCES", "EROFS"].includes(code || "")) {
        this.pauseUntil = now() + 60
        this.db.update(task, {
          status: "retry_wait",
          attempts: original,
          next_retry_at: this.pauseUntil,
          last_error: "存储不可写或磁盘空间不足",
        })
      } else {
        const attempts = Math.max(1, task.attempts)
        this.db.update(task, {
          status: attempts >= 8 ? "failed" : "retry_wait",
          attempts,
          next_retry_at:
            now() + Math.min(1800, 30 * 2 ** Math.min(attempts - 1, 6)),
          last_error: "下载失败，请检查连接或重试",
        })
      }
    } finally {
      this.reservations.delete(key)
    }
  }
}
