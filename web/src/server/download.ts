import {
  copyFile,
  link,
  mkdir,
  rename,
  unlink,
  lstat,
  statfs,
  realpath,
} from "node:fs/promises"
import { openSync, fsyncSync, closeSync } from "node:fs"
import { dirname, join, relative, isAbsolute } from "node:path"
import { finalPath, ManagementError, now, syncDirectory } from "./config.ts"
import { floodSeconds, rpcName } from "./telegram.ts"
import type { Settings } from "./config.ts"
import type { Database, Download } from "./database.ts"
import type { Transport, TelegramEntity } from "./telegram.ts"

export class PermanentDownloadError extends Error {}
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
  private db: Database
  private settings: Settings
  constructor(db: Database, settings: Settings) {
    this.db = db
    this.settings = settings
    this.incoming = join(dirname(settings.media), ".incoming")
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
      const target = finalPath(this.settings.media, task)
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
      const target = finalPath(this.settings.media, task)
      if (await exists(target)) {
        if (!(await verified(target, task.expected_size)))
          throw new PermanentDownloadError("最终文件冲突，禁止覆盖")
        this.db.completed(task, target)
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
      await publish(
        temp,
        this.incoming,
        target,
        task.expected_size,
        this.settings.media
      )
      this.db.completed(task, target)
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
