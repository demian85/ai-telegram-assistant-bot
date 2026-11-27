import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Redis } from 'ioredis'
import logger from '../logger.js'
import { chatBackupDirectory, writeChatBackup } from './chat-backup.js'

export function startDailyChatBackups(redis: Redis) {
  const directory = chatBackupDirectory()
  async function run() {
    const day = new Date().toISOString().slice(0, 10)
    const file = join(directory, `chats-${day}.resp`)
    let nextRun: number
    try {
      const existing = await stat(file).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        }
      )
      if (!existing) {
        await writeChatBackup(redis, file)
        logger.info({ file }, 'Daily chat backup saved')
      } else if (!existing.isFile()) {
        throw new Error('Daily chat backup path must be a regular file')
      }
      nextRun = Date.parse(day) + 86_400_000
    } catch (err) {
      logger.error(
        { err },
        'Daily chat backup failed, retrying in five minutes'
      )
      nextRun = Date.now() + 300_000
    }
    setTimeout(run, Math.max(0, nextRun - Date.now())).unref()
  }
  void run()
}
