import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Redis } from 'ioredis'
import logger from '../logger.js'

const execFileAsync = promisify(execFile)

class RedisStartupError extends Error {
  override name = 'RedisStartupError'
}

async function pingRedis(redisUrl: string): Promise<void> {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 2000,
    commandTimeout: 2000,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
    enableReadyCheck: false,
    disableClientInfo: true,
  })
  let connectionError: Error | undefined
  client.on('error', (error: Error) => {
    connectionError = error
  })
  try {
    await client.connect()
    if ((await client.ping()) !== 'PONG') {
      throw new RedisStartupError('Redis did not respond to PING with PONG')
    }
  } catch (error) {
    throw connectionError ?? error
  } finally {
    client.disconnect()
  }
}

export async function ensureRedis(
  redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
): Promise<void> {
  const url = new URL(redisUrl)
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new RedisStartupError('REDIS_URL must use redis:// or rediss://')
  }

  try {
    await pingRedis(redisUrl)
    logger.info('Using existing Redis instance')
    return
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const canStartLocally =
      url.protocol === 'redis:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      'code' in error &&
      error.code === 'ECONNREFUSED'
    if (!canStartLocally) {
      throw new RedisStartupError(
        'Configured Redis is unavailable. Check REDIS_URL, credentials, and the Redis server; automatic startup only supports an unauthenticated local Redis connection.',
        { cause: error }
      )
    }
  }

  logger.info('Starting local Redis container')
  try {
    await execFileAsync(
      'docker',
      [
        'compose',
        '-f',
        'docker-compose.yml',
        '-f',
        'docker-compose.local.yml',
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '60',
        'redis',
      ],
      {
        env: { ...process.env, REDIS_PORT: url.port || '6379' },
        timeout: 180_000,
      }
    )
  } catch (error) {
    if (!(error instanceof Error)) throw error
    throw new RedisStartupError(
      'Could not start local Redis. Install/start Docker with Compose, or set REDIS_URL to a running Redis instance.',
      { cause: error }
    )
  }
  await pingRedis(redisUrl)
  logger.info('Local Redis container is ready')
}
