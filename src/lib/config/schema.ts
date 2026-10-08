import { z } from 'zod'

export const telegramConfigSchema = z.strictObject({
  botUsername: z.string(),
  whitelistedUsers: z.array(z.string()),
})

export const newsConfigSchema = z.strictObject({
  feeds: z.array(z.string()),
  pollIntervalMinutes: z.number(),
  deliveryCheckIntervalSeconds: z.number(),
  relevanceThreshold: z.number(),
  maxArticlesPerPoll: z.number(),
  defaultFilter: z.string().trim().min(1).max(3000),
  decisionModel: z.string().trim().min(1).optional(),
  decisionConfidenceThreshold: z.number().min(0).max(1).optional(),
})

export const llmRoleConfigSchema = z.strictObject({
  model: z.string(),
  supportsVision: z.boolean(),
  supportsWebSearch: z.boolean().optional(),
  systemPrompt: z.string(),
})

export const llmConfigSchema = z.strictObject({
  apiKeyEnvVar: z.string(),
  baseUrl: z.string(),
  roles: z.strictObject({
    chat: llmRoleConfigSchema,
    summarizer: llmRoleConfigSchema,
    newsPreferences: llmRoleConfigSchema,
  }),
})

export const appConfigSchema = z.strictObject({
  telegram: telegramConfigSchema,
  news: newsConfigSchema,
  llm: llmConfigSchema,
})
