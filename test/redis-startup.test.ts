import { createServer, type Server } from 'node:net'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { ensureRedis } from '../src/lib/redis/ensure-redis.js'

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve()
          server.close((error) => (error ? reject(error) : resolve()))
        })
    )
  )
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Expected TCP listener')
  }
  return `redis://127.0.0.1:${address.port}`
}

it('reuses a responding local Redis without needing Docker', async () => {
  vi.stubEnv('PATH', '')
  const commands: string[] = []
  const url = await listen(
    createServer((socket) => {
      socket.on('data', (data) => {
        commands.push(data.toString())
        socket.write('+PONG\r\n')
      })
    })
  )

  await ensureRedis(url)

  expect(commands).toEqual(['*1\r\n$4\r\nping\r\n'])
})

it('attempts local container startup when the Redis port refuses connections', async () => {
  const server = createServer()
  const url = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.stubEnv('PATH', '')

  await expect(ensureRedis(url)).rejects.toMatchObject({
    name: 'RedisStartupError',
    message: expect.stringContaining('Could not start local Redis'),
    cause: { code: 'ENOENT' },
  })
})

it('preserves Redis authentication errors instead of starting another server', async () => {
  vi.stubEnv('PATH', '')
  const url = await listen(
    createServer((socket) => {
      socket.on('data', () =>
        socket.write('-NOAUTH Authentication required.\r\n')
      )
    })
  )

  await expect(ensureRedis(url)).rejects.toMatchObject({
    name: 'RedisStartupError',
    message: expect.stringContaining('Configured Redis is unavailable'),
    cause: { message: 'NOAUTH Authentication required.' },
  })
})

it('preserves explicit local credentials instead of starting an unauthenticated server', async () => {
  const server = createServer()
  const url = new URL(await listen(server))
  await new Promise<void>((resolve) => server.close(() => resolve()))
  url.password = 'example-password'
  vi.stubEnv('PATH', '')

  await expect(ensureRedis(url.toString())).rejects.toMatchObject({
    name: 'RedisStartupError',
    message: expect.stringContaining('Configured Redis is unavailable'),
    cause: { code: 'ECONNREFUSED' },
  })
})
