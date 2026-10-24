import type { AppConfig } from '../config/types.js'
import { z } from 'zod'
import OpenAI from 'openai'

export interface SearchOptions {
  readonly web: 'off' | 'auto' | 'on'
  readonly x: boolean
  readonly scrape: boolean
  readonly citations: boolean
}

export const noSearch: SearchOptions = {
  web: 'off',
  x: false,
  scrape: false,
  citations: false,
}

export function providerOptions(
  config: AppConfig,
  search: SearchOptions
): Record<string, unknown> {
  const provider =
    config.llm.provider ??
    (new URL(config.llm.baseUrl).hostname === 'api.venice.ai'
      ? 'venice'
      : 'openai-compatible')
  if (provider === 'venice')
    return {
      venice_parameters: {
        enable_web_search: search.web,
        enable_x_search: search.x,
        enable_web_scraping: search.scrape,
        enable_web_citations: search.citations,
      },
    }
  if (search.web !== 'off' || search.x || search.scrape) {
    throw new Error(
      'Search is not supported by the configured provider adapter'
    )
  }
  return {}
}

export function assertChatCapabilities(
  config: AppConfig,
  catalog: unknown
): void {
  const search = config.llm.roles.chat.search
  if (!search || (search.web === 'off' && !search.x && !search.scrape)) return
  const parsed = z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          model_spec: z
            .object({
              capabilities: z.object({
                supportsXSearch: z.boolean().optional(),
                supportsWebSearch: z.boolean().optional(),
                supportsFunctionCalling: z.boolean().optional(),
              }),
            })
            .optional(),
        })
      ),
    })
    .parse(catalog)
  const capabilities = parsed.data.find(
    (entry) => entry.id === config.llm.roles.chat.model
  )?.model_spec?.capabilities
  if (
    !capabilities?.supportsFunctionCalling ||
    (search.x && !capabilities.supportsXSearch) ||
    (search.web !== 'off' && !capabilities.supportsWebSearch)
  ) {
    throw new Error(
      'Configured chat model does not advertise the required search and tool capabilities'
    )
  }
}

export async function validateChatCapabilities(
  config: AppConfig
): Promise<void> {
  const provider =
    config.llm.provider ??
    (new URL(config.llm.baseUrl).hostname === 'api.venice.ai'
      ? 'venice'
      : 'openai-compatible')
  const search = config.llm.roles.chat.search
  if (
    provider !== 'venice' ||
    !search ||
    (search.web === 'off' && !search.x && !search.scrape)
  )
    return
  const client = new OpenAI({
    apiKey: process.env[config.llm.apiKeyEnvVar],
    baseURL: config.llm.baseUrl,
    maxRetries: 0,
    timeout: 15_000,
  })
  assertChatCapabilities(config, await client.models.list())
}
