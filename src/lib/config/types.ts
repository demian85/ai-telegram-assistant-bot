import type { NewsRelevanceRoleConfig } from './news-decision-config.js'

export type LlmRole =
  | 'chat'
  | 'summarizer'
  | 'newsRelevance'
  | 'newsPreferences'

export interface TelegramConfig {
  botUsername: string
  whitelistedUsers: string[]
}

export interface NewsAppConfig {
  readonly decisionModel?: string
  readonly decisionConfidenceThreshold?: number
  feeds: string[]
  pollIntervalMinutes: number
  deliveryCheckIntervalSeconds: number
  relevanceThreshold: number
  maxArticlesPerPoll: number
  defaultFilter: string
}

export interface LlmRoleConfig {
  model: string
  supportsVision: boolean
  supportsWebSearch?: boolean
  systemPrompt: string
}

export interface LlmConfig {
  apiKeyEnvVar: string
  baseUrl: string
  readonly defaultModel?: string
  roles: Record<Exclude<LlmRole, 'newsRelevance'>, LlmRoleConfig> & {
    readonly newsRelevance: NewsRelevanceRoleConfig
  }
}

export interface AppConfig {
  telegram: TelegramConfig
  news: NewsAppConfig
  llm: LlmConfig
}
