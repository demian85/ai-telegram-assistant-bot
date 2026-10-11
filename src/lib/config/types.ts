import type { z } from 'zod'
import type {
  appConfigSchema,
  telegramConfigSchema,
  newsConfigSchema,
  llmRoleConfigSchema,
  llmConfigSchema,
} from './schema.js'

export type AppConfig = z.infer<typeof appConfigSchema>
export type TelegramConfig = z.infer<typeof telegramConfigSchema>
export type NewsAppConfig = z.infer<typeof newsConfigSchema>
export type LlmRoleConfig = z.infer<typeof llmRoleConfigSchema>
export type LlmConfig = z.infer<typeof llmConfigSchema>
export type LlmRole = keyof LlmConfig['roles']
