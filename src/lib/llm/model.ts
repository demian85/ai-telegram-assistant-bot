import { ChatOpenAI } from '@langchain/openai'

import type { AppConfig, LlmRole } from '@lib/config/types.js'
import { VeniceDecisionModel } from './decision-model.js'

export type LlmRoleModels = Record<
  Exclude<LlmRole, 'newsRelevance'>,
  ChatOpenAI
> & {
  readonly newsRelevance: VeniceDecisionModel
}

export function createLlmRoleModels(config: AppConfig): LlmRoleModels {
  const apiKey = process.env[config.llm.apiKeyEnvVar]

  if (!apiKey) {
    throw new Error(
      `${config.llm.apiKeyEnvVar} environment variable is required`
    )
  }

  return {
    chat: createLlmModel(config.llm.roles.chat, apiKey, config.llm.baseUrl),
    summarizer: createLlmModel(
      config.llm.roles.summarizer,
      apiKey,
      config.llm.baseUrl
    ),
    newsRelevance: new VeniceDecisionModel({
      model: config.news.decisionModel ?? 'jev-latest',
      apiKey,
      baseURL: config.llm.baseUrl,
    }),
    newsPreferences: createLlmModel(
      config.llm.roles.newsPreferences,
      apiKey,
      config.llm.baseUrl
    ),
  }
}

function createLlmModel(
  roleConfig: AppConfig['llm']['roles'][Exclude<LlmRole, 'newsRelevance'>],
  apiKey: string,
  baseUrl: string
): ChatOpenAI {
  return new ChatOpenAI({
    modelName: roleConfig.model,
    apiKey,
    configuration: { baseURL: baseUrl },
  })
}

export function llmSupportsVision(role: LlmRole, config: AppConfig): boolean {
  if (role === 'newsRelevance') return false
  return config.llm.roles[role].supportsVision
}

export function llmSupportsWebSearch(
  role: LlmRole,
  config: AppConfig
): boolean {
  if (role === 'newsRelevance') return false
  return config.llm.roles[role].supportsWebSearch ?? false
}

export function getLlmModelForRole(role: LlmRole, config: AppConfig): string {
  if (role === 'newsRelevance') return config.news.decisionModel ?? 'jev-latest'
  return config.llm.roles[role].model
}
