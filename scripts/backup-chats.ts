import 'dotenv/config'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeRedisClient, getRedisClient } from '../src/lib/redis/client.js'
import {
  chatBackupDirectory,
  writeChatBackup,
} from '../src/lib/redis/chat-backup.js'

const stamp = new Date().toISOString().replaceAll(':', '-')
const file = join(chatBackupDirectory(), `chats-${stamp}-${randomUUID()}.resp`)
try {
  await writeChatBackup(getRedisClient(), file)
  console.log('Chat backup saved:', file)
} catch (err) {
  console.error('Chat backup failed:', err)
  process.exitCode = 1
} finally {
  closeRedisClient()
}
