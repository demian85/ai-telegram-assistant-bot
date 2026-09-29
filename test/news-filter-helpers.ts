import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { ChatNewsFilter } from '../src/lib/news/chat-news-filter.js'
import {
  NewsPreferenceStore,
  type NewsPreference,
} from '../src/lib/news/preferences.js'
import { RelevanceDetector } from '../src/lib/news/relevance-detector.js'
import type { NewsItem } from '../src/lib/news/types.js'
import { InMemoryRedis } from './test-helpers.js'

const requestSchema = z.object({
  messages: z.array(
    z.object({ role: z.string(), content: z.string().nullable() })
  ),
  response_format: z.object({ type: z.literal('json_schema') }),
})
export type ModelRequest = z.infer<typeof requestSchema>

export function structuredModel(respond: (request: ModelRequest) => unknown) {
  return new ChatOpenAI({
    apiKey: 'offline-test-key',
    model: 'offline-model',
    maxRetries: 0,
    configuration: {
      fetch: async (_url, init) => {
        const request = requestSchema.parse(JSON.parse(String(init?.body)))
        const output = await respond(request)
        return new Response(
          JSON.stringify({
            id: 'completion-test',
            object: 'chat.completion',
            created: 0,
            model: 'offline-model',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify(output),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      },
    },
  })
}

export const acceptedDecision = {
  matchesInterest: true,
  excluded: false,
  score: 95,
  reason: 'direct match',
}

export function preference(instruction = 'interest-a'): NewsPreference {
  return {
    mode: 'custom',
    description: 'description-a',
    instruction,
    revision: randomUUID(),
    generatedAt: '2026-09-29T00:00:00.000Z',
    model: 'preference-model',
  }
}

export function article(id = 'article-1'): NewsItem {
  return {
    id,
    title: id,
    description: 'article description',
    content: 'article body',
    source: 'test',
    feedUrl: 'https://example.test/feed',
    url: `https://example.test/${id}`,
    fetchedAt: new Date(),
    publishedAt: new Date(),
  }
}

export function filterHarness(
  respond: (request: ModelRequest) => unknown = () => acceptedDecision
) {
  const redis = new InMemoryRedis()
  const model = structuredModel(respond)
  const preferences = new NewsPreferenceStore(redis.asRedis(), [
    'default-topic',
  ])
  const detector = new RelevanceDetector(model, {
    topics: [],
    relevanceThreshold: 80,
    systemPrompt: 'scoring-role',
  })
  const filter = new ChatNewsFilter(redis.asRedis(), preferences, detector)
  return { redis, model, preferences, detector, filter }
}
