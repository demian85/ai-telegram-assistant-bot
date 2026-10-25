import { ChatOpenAI } from '@langchain/openai'

import type { AppConfig, LlmRole } from '@lib/config/types.js'
import { VeniceDecisionModel } from './decision-model.js'
import { noSearch, providerOptions } from './provider-options.js'
import { modelTelemetry } from './response.js'

export type LlmRoleModels = Record<LlmRole, ChatOpenAI> & {
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
    chat: createLlmModel(config.llm.roles.chat, apiKey, config),
    summarizer: createLlmModel(config.llm.roles.summarizer, apiKey, config),
    newsRelevance: new VeniceDecisionModel({
      model: config.news.decisionModel ?? 'jev-latest',
      apiKey,
      baseURL: config.llm.baseUrl,
    }),
    newsPreferences: createLlmModel(
      config.llm.roles.newsPreferences,
      apiKey,
      config
    ),
  }
}

function createLlmModel(
  roleConfig: AppConfig['llm']['roles'][LlmRole],
  apiKey: string,
  config: AppConfig
): ChatOpenAI {
  const isChat = roleConfig === config.llm.roles.chat
  const search = isChat ? (config.llm.roles.chat.search ?? noSearch) : noSearch
  if (/:.*enable_(web|x)_/.test(roleConfig.model)) {
    throw new Error(
      'Use a plain model ID and chat.search settings instead of model suffixes'
    )
  }
  return new ChatOpenAI({
    modelName: roleConfig.model,
    apiKey,
    configuration: { baseURL: config.llm.baseUrl },
    modelKwargs: providerOptions(config, search),
    timeout: 60_000,
    maxRetries: 1,
    __includeRawResponse: true,
    callbacks: [modelTelemetry],
  })
}

export function getLlmModelForRole(role: LlmRole, config: AppConfig): string {
  return config.llm.roles[role].model
}
