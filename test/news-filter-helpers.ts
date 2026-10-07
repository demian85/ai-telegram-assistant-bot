import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { renderCriteria } from '../src/lib/news/preference-schema.js'
import { ChatNewsFilter } from '../src/lib/news/chat-news-filter.js'
import {
  NewsPreferenceStore,
  type NewsPreference,
} from '../src/lib/news/preferences.js'
import { RelevanceDetector } from '../src/lib/news/relevance-detector.js'
import type { NewsItem } from '../src/lib/news/types.js'
import { VeniceDecisionModel } from '../src/lib/llm/decision-model.js'
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
  titleRulesSatisfied: true,
  score: 95,
  reason: 'direct match',
}

export const decisionRequestSchema = z.object({
  model: z.string(),
  state: z.object({
    preferences: z.object({ original: z.string(), compiled: z.string() }),
    article: z.object({
      title: z.string(),
      description: z.string().optional(),
      content: z.string().optional(),
    }),
  }),
  questions: z.record(
    z.object({
      type: z.enum(['choice', 'score']),
      instructions: z.string(),
      criteria: z.union([z.record(z.string()), z.array(z.string())]),
    })
  ),
})
export type DecisionRequest = z.infer<typeof decisionRequestSchema>

export function decisionResponse(decision: {
  readonly matchesInterest: boolean
  readonly excluded: boolean
  readonly titleRulesSatisfied?: boolean
  readonly score: number
}) {
  const choice = (yes: boolean) => ({
    type: 'choice',
    choice: yes ? 'yes' : 'no',
    confidence: 0.98,
    probabilities: { yes: yes ? 0.99 : 0.01, no: yes ? 0.01 : 0.99 },
  })
  return {
    model: 'jev-latest',
    answers: {
      interest: choice(decision.matchesInterest),
      exclusion: choice(decision.excluded),
      title: choice(decision.titleRulesSatisfied ?? true),
      relevance: {
        type: 'score',
        score: decision.score / 20,
        confidence: 0.98,
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

export function decisionModel(respond: (request: DecisionRequest) => unknown) {
  return new VeniceDecisionModel({
    apiKey: 'offline-test-key',
    baseURL: 'https://api.venice.ai/api/v1',
    model: 'jev-latest',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const request = decisionRequestSchema.parse(
        JSON.parse(String(init?.body))
      )
      const output = await respond(request)
      const decision = z
        .object({
          matchesInterest: z.boolean(),
          excluded: z.boolean(),
          titleRulesSatisfied: z.boolean().optional(),
          score: z.number(),
        })
        .safeParse(output)
      return new Response(
        JSON.stringify(
          decision.success ? decisionResponse(decision.data) : output
        ),
        {
          headers: { 'content-type': 'application/json' },
        }
      )
    },
  })
}

export function preference(instruction = 'interest-a'): NewsPreference {
  return {
    mode: 'custom',
    version: 2,
    description: instruction,
    criteria: {
      interests: [{ rule: instruction, sourceText: instruction }],
      exclusions: [],
      titleRules: [],
    },
    instruction: renderCriteria({
      interests: [{ rule: instruction, sourceText: instruction }],
      exclusions: [],
      titleRules: [],
    }),
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
  respond: (request: DecisionRequest) => unknown = () => acceptedDecision
) {
  const redis = new InMemoryRedis()
  const model = decisionModel(respond)
  const preferences = new NewsPreferenceStore(redis.asRedis(), 'default-topic')
  const detector = new RelevanceDetector(model, {
    relevanceThreshold: 80,
    systemPrompt: 'scoring-role',
  })
  const filter = new ChatNewsFilter(redis.asRedis(), preferences, detector)
  return { redis, model, preferences, detector, filter }
}
