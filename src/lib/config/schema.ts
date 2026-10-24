import { z } from 'zod'
import {
  chatPromptVariables,
  promptTemplateSchema,
  summarizerPromptVariables,
} from './prompt-template.js'

export const telegramConfigSchema = z.strictObject({
  botUsername: z.string(),
  whitelistedUsers: z.array(z.string()),
  allowedGroupIds: z.array(z.string().regex(/^-[1-9]\d*$/)).default([]),
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

export const chatRoleConfigSchema = llmRoleConfigSchema
  .omit({ systemPrompt: true })
  .extend({
    search: z
      .strictObject({
        web: z.enum(['off', 'auto', 'on']),
        x: z.boolean(),
        scrape: z.boolean(),
        citations: z.boolean(),
      })
      .optional(),
    systemPrompts: z.strictObject({
      private: promptTemplateSchema(chatPromptVariables),
      group: promptTemplateSchema(chatPromptVariables),
    }),
  })

const summarizerRoleConfigSchema = llmRoleConfigSchema.extend({
  systemPrompt: promptTemplateSchema(summarizerPromptVariables),
})

export const llmConfigSchema = z.strictObject({
  provider: z.enum(['openai-compatible', 'venice']).optional(),
  apiKeyEnvVar: z.string(),
  baseUrl: z.string(),
  roles: z.strictObject({
    chat: chatRoleConfigSchema,
    summarizer: summarizerRoleConfigSchema,
    newsPreferences: llmRoleConfigSchema,
  }),
})

export const appConfigSchema = z.strictObject({
  telegram: telegramConfigSchema,
  news: newsConfigSchema,
  llm: llmConfigSchema,
})
