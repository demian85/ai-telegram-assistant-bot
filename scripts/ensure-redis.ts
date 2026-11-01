import 'dotenv/config'
import { ensureRedis } from '../src/lib/redis/ensure-redis.js'
import logger from '../src/lib/logger.js'

ensureRedis().catch((err: unknown) => {
  logger.error({ err }, 'Redis startup failed')
  process.exitCode = 1
})
