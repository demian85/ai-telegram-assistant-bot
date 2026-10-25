import { ChatOpenAI } from '@langchain/openai'
import type { Redis } from 'ioredis'
import { expect, test, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { loadAppConfig } from '../src/lib/config/load-config.js'
import { createLlmRoleModels } from '../src/lib/llm/model.js'
import { AgentService } from '../src/lib/agent/index.js'
import { citedResponse } from '../src/lib/llm/response.js'
import { createAgentTools } from '../src/lib/agent/tools.js'
import { InMemoryRedis } from './test-helpers.js'
import { NewsQueryService } from '../src/lib/news/news-query-service.js'
import { filterHarness } from './news-filter-helpers.js'
import {
  assertChatCapabilities,
  providerOptions,
  noSearch,
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
  const config = loadAppConfig()
  return new ChatOpenAI({
    model,
    modelKwargs: providerOptions(
      config,
      model === 'summary'
        ? noSearch
        : (config.llm.roles.chat.search ?? noSearch)
    ),
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
              message: {
                role: 'assistant',
                content: 'evidence [1]',
              },
            },
          ],
          venice_parameters: {
            web_search_citations: [
              {
                url: 'https://example.com/article',
                title: 'Article',
                content: 'Retrieved article evidence.',
              },
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
  'uses native search without retrieval tools and isolates summary calls in %s chat',
  async (chatType) => {
    const requests: z.infer<typeof requestSchema>[] = []
    const chat = recordingModel('chat', requests)
    const summary = recordingModel('summary', requests)
    const redis = new InMemoryRedis().asRedis<Redis>()
    const tools = createAgentTools()
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
      { text: 'show me top trending news from x' },
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
    const turns = requests.filter((request) => request.prompt_cache_key)
    expect(
      turns
        .slice(0, 3)
        .map((request) => request.tools?.map((entry) => entry.function.name))
    ).toEqual(
      Array.from({ length: 3 }, () => ['calculator', 'help', 'current_time'])
    )
    expect(turns).toHaveLength(4)
    expect(turns[0]?.venice_parameters).toMatchObject({
      enable_web_search: 'auto',
      enable_x_search: true,
    })
    expect(turns[3]?.venice_parameters).toMatchObject({
      enable_web_search: 'off',
      enable_x_search: false,
      enable_web_scraping: false,
    })
    expect(turns[3]?.model).toBe('summary')
    expect(turns[3]?.tools ?? []).toEqual([])
    expect(turns[0]?.prompt_cache_key).toBeTruthy()
    expect(turns[0]?.prompt_cache_key).toBe(turns[1]?.prompt_cache_key)
    expect(turns[0]?.prompt_cache_key).not.toBe(turns[2]?.prompt_cache_key)
    expect(answer.includes('Sources:')).toBe(chatType === 'private')
    if (chatType === 'group') expect(answer).toBe('evidence [1]')
    else expect(answer).toContain('https://example.com/article')
  }
)

test('confines provider-native search options to the chat role', () => {
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
  expect(createAgentTools().map((entry) => entry.name)).toEqual([
    'calculator',
    'help',
    'current_time',
  ])
})

test('retains personalized RSS retrieval when native search is enabled', () => {
  const harness = filterHarness()
  const query = new NewsQueryService({
    redis: harness.redis.asRedis(),
    filter: harness.filter,
  })
  expect(
    createAgentTools({ newsQueryService: query }).map((entry) => entry.name)
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

test.each([true, false])(
  'preserves native citation markers with source list enabled=%s',
  (includeSourceList) => {
    const content =
      'Claim.^2^ Another claim [1]. Existing [link](https://example.com).'
    const response = citedResponse(
      {
        content,
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
      },
      { includeSourceList }
    )
    if (includeSourceList)
      expect(response).toBe(
        `${content}\n\nSources:\n- [Source 1](<https://one.example/a>)\n- [Source 2](<https://two.example/b>)`
      )
    else expect(response).toBe(content)
  }
)

test.each(['Sources:', '## References', '**Fuentes**:'])(
  'preserves a native trailing %s list without adding another list in groups',
  (heading) => {
    const content = `Claim [1].\n\n${heading}\n1. [Article](https://example.com/article)`
    expect(
      citedResponse(
        { content, additional_kwargs: {} },
        { includeSourceList: false }
      )
    ).toBe(content)
    expect(citedResponse({ content, additional_kwargs: {} })).toBe(content)
  }
)

test('preserves source headings inside code and substantive text after a source heading', () => {
  for (const content of [
    '```markdown\nSources:\n- [Article](https://example.com/article)\n```',
    'Sources:\nThis paragraph explains the evidence.\n\n## Conclusion\nKeep this conclusion.',
    'Claim [1](https://example.com/article).',
  ]) {
    expect(
      citedResponse(
        { content, additional_kwargs: {} },
        { includeSourceList: false }
      )
    ).toBe(content)
  }
})
