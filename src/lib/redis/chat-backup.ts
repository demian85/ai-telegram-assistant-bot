import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import type { Redis } from 'ioredis'

export const chatBackupDirectory = () =>
  resolve(process.env.CHAT_BACKUP_DIR || 'backups')

// RESP bulk lengths count UTF-8 bytes. The payload stays verbatim, including
// Unicode, embedded newlines, and JSON from older versions of the bot.
function command(...args: string[]): string {
  return (
    `*${args.length}\r\n` +
    args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')
  )
}

async function writeCollection(
  file: FileHandle,
  key: string,
  op: 'RPUSH' | 'ZADD' | 'SADD',
  values: string[]
) {
  if (!values.length) return
  await file.writeFile(command('MULTI') + command('DEL', key))
  // An even batch size keeps each ZADD score/member pair together.
  for (let i = 0; i < values.length; i += 256) {
    await file.writeFile(command(op, key, ...values.slice(i, i + 256)))
  }
  await file.writeFile(command('EXEC'))
}

async function writeChatKey(redis: Redis, file: FileHandle, key: string) {
  if (key.startsWith('conversation:')) {
    await writeCollection(file, key, 'RPUSH', await redis.lrange(key, 0, -1))
  } else if (key.startsWith('memory:summary:')) {
    const members = await redis.zrange(key, 0, -1, 'WITHSCORES')
    // ZRANGE returns member/score pairs. ZADD accepts score/member pairs.
    for (let i = 0; i < members.length; i += 2) {
      const score = members[i + 1]
      members[i + 1] = members[i]
      members[i] = score
    }
    await writeCollection(file, key, 'ZADD', members)
  } else if (key === 'news:chat-subscriptions') {
    await writeCollection(file, key, 'SADD', await redis.smembers(key))
  } else if (
    key.startsWith('news:chat-subscription:') ||
    key.startsWith('news:preferences:') ||
    key.startsWith('news:relevance-threshold:')
  ) {
    const value = await redis.get(key)
    if (value !== null) await file.writeFile(command('SET', key, value))
  }
}

export async function writeChatBackup(redis: Redis, destination: string) {
  const directory = dirname(destination)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const partial = join(directory, `.chat-backup-${randomUUID()}.tmp`)
  const file = await open(partial, 'wx', 0o600)
  try {
    try {
      // Even an empty database produces a valid, replayable command stream.
      await file.writeFile(command('PING'))
      let cursor = '0'
      do {
        const [next, keys] = await redis.scan(cursor, 'COUNT', 250)
        for (const key of keys) await writeChatKey(redis, file, key)
        cursor = next
      } while (cursor !== '0')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(partial, destination)
  } finally {
    await rm(partial, { force: true })
  }
}
