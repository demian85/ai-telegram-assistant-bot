import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startDailyChatBackups } from '../src/lib/redis/daily-chat-backup.js'
import { InMemoryRedis } from './test-helpers.js'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'chat-backup-test-'))
  vi.stubEnv('CHAT_BACKUP_DIR', directory)
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-01T23:59:00Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

it('keeps today’s existing backup on restart and saves current history at midnight UTC', async () => {
  const redis = new (class extends InMemoryRedis {
    async scan() {
      return ['0', ['conversation:private:42']]
    }
  })()
  const today = join(directory, 'chats-2026-05-01.resp')
  const tomorrow = join(directory, 'chats-2026-05-02.resp')
  await writeFile(today, 'earlier snapshot')
  await redis.lpush('conversation:private:42', '¿Cómo estás?')
  startDailyChatBackups(redis.asRedis())
  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(async () =>
    expect(await readFile(tomorrow, 'utf8')).toContain('¿Cómo estás?')
  )
  expect(await readFile(today, 'utf8')).toBe('earlier snapshot')
})

it('publishes only a complete backup after recovering from a Redis read failure', async () => {
  let unavailable = true
  const redis = new (class extends InMemoryRedis {
    async scan() {
      if (unavailable) throw new Error('Redis unavailable')
      return ['0', ['conversation:group:-42']]
    }
  })()
  await redis.lpush('conversation:group:-42', 'recovered history')
  startDailyChatBackups(redis.asRedis())
  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
  expect(await readdir(directory)).toEqual([])
  unavailable = false
  // Retry crosses midnight and must use the new day's filename.
  await vi.advanceTimersByTimeAsync(300_000)
  await vi.waitFor(async () =>
    expect(
      await readFile(join(directory, 'chats-2026-05-02.resp'), 'utf8')
    ).toContain('recovered history')
  )
})
