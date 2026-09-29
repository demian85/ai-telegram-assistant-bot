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
  feeds: string[]
  pollIntervalMinutes: number
  deliveryCheckIntervalSeconds: number
  relevanceThreshold: number
  maxArticlesPerPoll: number
  topics: string[]
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
  defaultModel: string
  roles: Record<LlmRole, LlmRoleConfig>
}

export interface AppConfig {
  telegram: TelegramConfig
  news: NewsAppConfig
  llm: LlmConfig
}
