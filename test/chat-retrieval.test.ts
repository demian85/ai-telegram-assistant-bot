import { ChatOpenAI } from '@langchain/openai'
import type { Redis } from 'ioredis'
import { expect, test, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { loadAppConfig } from '../src/lib/config/load-config.js'
import { createLlmRoleModels } from '../src/lib/llm/model.js'
import { AgentService } from '../src/lib/agent/index.js'
import {
  ChatRetrieval,
  createRetrievalTools,
  publicUrlSchema,
} from '../src/lib/agent/retrieval.js'
import { citedResponse } from '../src/lib/llm/response.js'
import { createAgentTools } from '../src/lib/agent/tools.js'
import { InMemoryRedis } from './test-helpers.js'
import { NewsQueryService } from '../src/lib/news/news-query-service.js'
import { filterHarness } from './news-filter-helpers.js'
import {
  assertChatCapabilities,
  providerOptions,
} from '../src/lib/llm/provider-options.js'

afterEach(() => vi.unstubAllEnvs())
const requestSchema = z.object({
  model: z.string(),
  prompt_cache_key: z.string().optional(),
  tools: z
    .array(z.object({ function: z.object({ name: z.string() }) }))
    .optional(),
  venice_parameters: z.unknown().optional(),
})
function recordingModel(
  model: string,
  requests: z.infer<typeof requestSchema>[]
) {
  return new ChatOpenAI({
    model,
    apiKey: 'offline',
    maxRetries: 0,
    __includeRawResponse: true,
    configuration: {
      fetch: async (_url, init) => {
        requests.push(requestSchema.parse(JSON.parse(String(init?.body))))
        return Response.json({
          id: 'test',
          object: 'chat.completion',
          created: 0,
          model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'evidence [1]' },
            },
          ],
          venice_parameters: {
            web_search_citations: [
              { url: 'https://example.com/article', title: 'Article' },
            ],
          },
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 5,
            total_tokens: 2005,
            prompt_tokens_details: { cached_tokens: 1024 },
          },
        })
      },
    },
  })
}

test.each(['private', 'group'] as const)(
  'isolates summary tools and cache scope from normal %s chat',
  async (chatType) => {
    const requests: z.infer<typeof requestSchema>[] = []
    const chat = recordingModel('chat', requests)
    const summary = recordingModel('summary', requests)
    const redis = new InMemoryRedis().asRedis<Redis>()
    const tools = createRetrievalTools(new ChatRetrieval(chat, redis), {
      search: true,
      read: true,
    })
    const agent = new AgentService({
      redis,
      agentModel: chat,
      summarizerModel: summary,
      supportsVision: false,
      tools,
      systemPrompts: { private: 'private', group: 'group' },
      summarizerSystemPrompt: '{{period}}',
    })
    await agent.initialize()
    const answer = await agent.invokeLive(
      `${chatType}:1`,
      { text: 'hello' },
      chatType
    )
    await agent.invokeLive(`${chatType}:1`, { text: 'again' }, chatType)
    await agent.invokeLive(`${chatType}:2`, { text: 'another' }, chatType)
    await agent.invokeLive(
      `${chatType}:1`,
      { text: 'summarize' },
      chatType,
      'summary'
    )
    expect(
      requests
        .slice(0, 3)
        .map((request) => request.tools?.map((entry) => entry.function.name))
    ).toEqual(Array.from({ length: 3 }, () => ['search_web', 'read_webpage']))
    expect(requests[3]?.model).toBe('summary')
    expect(requests[3]?.tools ?? []).toEqual([])
    expect(requests[0]?.prompt_cache_key).toBeTruthy()
    expect(requests[0]?.prompt_cache_key).toBe(requests[1]?.prompt_cache_key)
    expect(requests[0]?.prompt_cache_key).not.toBe(
      requests[2]?.prompt_cache_key
    )
    expect(answer).toContain('https://example.com/article')
  }
)

test('confines provider-native retrieval options to chat and retrieval roles', () => {
  const config = loadAppConfig()
  vi.stubEnv(config.llm.apiKeyEnvVar, 'offline')
  const models = createLlmRoleModels(config)
  expect(models.chat.modelKwargs).toMatchObject({
    venice_parameters: {
      enable_x_search: true,
      enable_web_search: 'auto',
      enable_web_scraping: true,
      enable_web_citations: true,
    },
  })
  for (const model of [models.summarizer, models.newsPreferences])
    expect(model.modelKwargs).toEqual({
      venice_parameters: {
        enable_web_search: 'off',
        enable_x_search: false,
        enable_web_scraping: false,
        enable_web_citations: false,
      },
    })
})

test('reuses cached evidence in one chat but separates chats and bounds tool calls', async () => {
  const requests: z.infer<typeof requestSchema>[] = []
  const redis = new InMemoryRedis()
  const retrieval = new ChatRetrieval(
    recordingModel('retrieval', requests),
    redis.asRedis()
  )
  const tools = createRetrievalTools(retrieval, { search: true, read: false })
  const search = tools[0]
  if (!search) throw new Error('Search tool missing')
  const config = {
    configurable: {
      purpose: 'chat',
      chatScope: 'private:1',
      retrievalBudget: { remaining: 3 },
    },
  }
  const [first, second] = await Promise.all([
    search.invoke({ query: 'topic' }, config),
    search.invoke({ query: 'topic' }, config),
  ])
  await search.invoke({ query: 'topic' }, config)
  await expect(search.invoke({ query: 'topic' }, config)).rejects.toThrow(
    'Retrieval limit'
  )
  expect(first).toBe(second)
  expect(requests).toHaveLength(1)
  await retrieval.retrieve('search', 'topic', 'group:-1')
  expect(requests).toHaveLength(2)
  const otherProvider = recordingModel('retrieval', requests)
  otherProvider.clientConfig.baseURL = 'https://other-provider.example/v1'
  await new ChatRetrieval(otherProvider, redis.asRedis()).retrieve(
    'search',
    'topic',
    'private:1'
  )
  expect(requests).toHaveLength(3)
})

test.each([
  'http://localhost/a',
  'http://127.0.0.1/a',
  'http://[::1]/',
  'http://user:password@example.com/',
  'file:///tmp/a',
  'http://example.com:8080',
])('rejects nonpublic scraping input %s', (url) => {
  expect(publicUrlSchema.safeParse(url).success).toBe(false)
})

test('normalizes standard citations and rejects unsafe citation schemes', () => {
  expect(
    citedResponse({
      content: 'answer',
      additional_kwargs: {
        __raw_response: {
          choices: [
            {
              message: {
                annotations: [
                  {
                    url_citation: {
                      url: 'https://example.com',
                      title: 'Example',
                    },
                  },
                  { url_citation: { url: 'javascript:alert(1)' } },
                ],
              },
            },
          ],
        },
      },
    })
  ).toBe('answer\n\nSources:\n- [Example](<https://example.com>)')
})

test('keeps the base tools available when retrieval is disabled', () => {
  expect(
    createAgentTools({ supportsWebSearch: true }).map((entry) => entry.name)
  ).toEqual(['calculator', 'help', 'current_time'])
})

test('retains personalized RSS retrieval when native search is enabled', () => {
  const harness = filterHarness()
  const query = new NewsQueryService({
    redis: harness.redis.asRedis(),
    filter: harness.filter,
  })
  expect(
    createAgentTools({ newsQueryService: query, supportsWebSearch: true }).map(
      (entry) => entry.name
    )
  ).toContain('get_recent_news')
})

test('rejects unsupported X search and keeps ordinary compatible providers free of provider fields', () => {
  const config = loadAppConfig()
  expect(() =>
    assertChatCapabilities(config, {
      data: [
        {
          id: config.llm.roles.chat.model,
          model_spec: {
            capabilities: {
              supportsFunctionCalling: true,
              supportsWebSearch: true,
              supportsXSearch: false,
            },
          },
        },
      ],
    })
  ).toThrow('required search')
  const compatible = {
    ...config,
    llm: { ...config.llm, provider: 'openai-compatible' as const },
  }
  expect(
    providerOptions(compatible, {
      web: 'off',
      x: false,
      scrape: false,
      citations: false,
    })
  ).toEqual({})
  expect(() =>
    providerOptions(compatible, {
      web: 'on',
      x: false,
      scrape: false,
      citations: true,
    })
  ).toThrow('not supported')
})

test('maps native citation markers to their source URLs', () => {
  const response = citedResponse({
    content: 'Claim.^2^',
    additional_kwargs: {
      __raw_response: {
        venice_parameters: {
          web_search_citations: [
            { url: 'https://one.example/a' },
            { url: 'https://two.example/b' },
          ],
        },
      },
    },
  })
  expect(response).toContain('Claim.[2](<https://two.example/b>)')
})

test('uses bounded cache lifetimes and fails closed without trusted tool context', async () => {
  const requests: z.infer<typeof requestSchema>[] = []
  const redis = new InMemoryRedis()
  const writes = vi.spyOn(redis, 'setex')
  const retrieval = new ChatRetrieval(
    recordingModel('retrieval', requests),
    redis.asRedis()
  )
  const tools = createRetrievalTools(retrieval, { search: true, read: true })
  const search = tools[0]
  if (!search) throw new Error('Search tool missing')
  await expect(search.invoke({ query: 'untrusted' })).rejects.toThrow()
  await expect(
    search.invoke(
      { query: 'untrusted' },
      {
        configurable: {
          purpose: 'summary',
          chatScope: 'private:1',
          retrievalBudget: { remaining: 3 },
        },
      }
    )
  ).rejects.toThrow()
  expect(requests).toHaveLength(0)
  await retrieval.retrieve('search', 'topic', 'private:1')
  await retrieval.retrieve('read', 'https://example.com/article', 'private:1')
  expect(writes.mock.calls.map((call) => call[1])).toEqual([300, 3600])
})

test('does not cache provider errors and allows a later attempt', async () => {
  let attempts = 0
  const model = new ChatOpenAI({
    model: 'retrieval',
    apiKey: 'offline',
    maxRetries: 0,
    configuration: {
      fetch: async () => {
        attempts++
        return Response.json(
          { error: { message: 'Unavailable', type: 'invalid_request_error' } },
          { status: 400 }
        )
      },
    },
  })
  const redis = new InMemoryRedis()
  const writes = vi.spyOn(redis, 'setex')
  const retrieval = new ChatRetrieval(model, redis.asRedis())
  await expect(
    retrieval.retrieve('search', 'topic', 'private:1')
  ).rejects.toThrow()
  await expect(
    retrieval.retrieve('search', 'topic', 'private:1')
  ).rejects.toThrow()
  expect(attempts).toBe(2)
  expect(writes).not.toHaveBeenCalled()
})
