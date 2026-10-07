import { expect, test, vi } from 'vitest'
import { VeniceDecisionModel } from '../src/lib/llm/decision-model.js'
import { RelevanceDetector } from '../src/lib/news/relevance-detector.js'
import { ChatNewsFilter } from '../src/lib/news/chat-news-filter.js'
import {
  acceptedDecision,
  article,
  decisionModel,
  decisionRequestSchema,
  decisionResponse,
  filterHarness,
  preference,
} from './news-filter-helpers.js'

test('sends typed news questions to the configured decision endpoint with the reused key', async () => {
  // Given
  const requests: {
    url: string
    method?: string
    authorization: string | null
    body: unknown
  }[] = []
  const model = new VeniceDecisionModel({
    apiKey: 'reused-venice-key',
    baseURL: 'https://api.venice.ai/api/v1/',
    model: 'jev-latest',
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method,
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      })
      return new Response(JSON.stringify(decisionResponse(acceptedDecision)), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const detector = new RelevanceDetector(model, { relevanceThreshold: 80 })
  // When
  const result = await detector.detectRelevance(
    {
      ...article(),
      title: 't'.repeat(1001),
      description: 'd'.repeat(3001),
      content: 'c'.repeat(8001),
    },
    {
      description: 'Original exclusions and title rules',
    }
  )
  // Then
  expect(result).toMatchObject({
    isRelevant: true,
    score: 95,
    eligible: true,
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    url: 'https://api.venice.ai/api/v1/decisions',
    method: 'POST',
    authorization: 'Bearer reused-venice-key',
  })
  const request = decisionRequestSchema.parse(requests[0]?.body)
  expect(request.model).toBe('jev-latest')
  expect(request.state).toEqual({
    preferences: 'Original exclusions and title rules',
    article: {
      title: 't'.repeat(1000),
      description: 'd'.repeat(3000),
    },
  })
  expect(
    Object.fromEntries(
      Object.entries(request.questions).map(([key, question]) => [
        key,
        question.type,
      ])
    )
  ).toEqual({
    eligibility: 'choice',
    relevance: 'score',
  })
  expect(request).not.toHaveProperty('messages')
})

test('rejects ineligible articles even with a high substantive relevance score', async () => {
  // Given
  const { detector } = filterHarness(() => ({
    ...acceptedDecision,
    eligible: false,
  }))
  // When
  const result = await detector.detectRelevance(article(), preference())
  // Then
  expect(result).toMatchObject({
    score: 95,
    eligible: false,
    isRelevant: false,
  })
})

test('withholds uncertain decisions and defers immediate reevaluation', async () => {
  // Given
  const response = decisionResponse(acceptedDecision)
  response.answers.eligibility.confidence = 0.79
  const respond = vi.fn(() => response)
  const { filter, preferences } = filterHarness(respond)
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  await filter.evaluate(context, article())
  // When
  const result = await filter.evaluate(context, article())
  // Then
  expect(result).toBeNull()
  expect(respond).toHaveBeenCalledTimes(1)
})

test('withholds an uncertain rejection instead of caching it as final', async () => {
  // Given
  const response = decisionResponse({ ...acceptedDecision, eligible: false })
  response.answers.eligibility.confidence = 0.79
  const { detector } = filterHarness(() => response)
  // When
  const result = await detector.detectRelevance(article(), preference())
  // Then
  expect(result).toBeNull()
})

test('invalidates cached acceptance when the independent confidence threshold changes', async () => {
  // Given
  const response = decisionResponse(acceptedDecision)
  response.answers.eligibility.confidence = 0.85
  const respond = vi.fn(() => response)
  const { filter, preferences, redis, model } = filterHarness(respond)
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  await filter.evaluate(context, article())
  const changed = new ChatNewsFilter(
    redis.asRedis(),
    preferences,
    new RelevanceDetector(model, {
      relevanceThreshold: 80,
      decisionConfidenceThreshold: 0.9,
    })
  )
  // When
  const result = await changed.evaluate(context, article())
  // Then
  expect(result).toBeNull()
  expect(respond).toHaveBeenCalledTimes(2)
})

test.each([
  { answers: {} },
  {
    ...decisionResponse(acceptedDecision),
    answers: {
      ...decisionResponse(acceptedDecision).answers,
      eligibility: { type: 'choice', choice: 'yes' },
    },
  },
  {
    ...decisionResponse(acceptedDecision),
    answers: {
      ...decisionResponse(acceptedDecision).answers,
      relevance: { type: 'score', score: 6, confidence: 1 },
    },
  },
  {
    ...decisionResponse(acceptedDecision),
    answers: {
      ...decisionResponse(acceptedDecision).answers,
      eligibility: {
        type: 'choice',
        choice: 'yes',
        confidence: 1,
        probabilities: { yes: 0.1, no: 0.9 },
      },
    },
  },
])(
  'withholds malformed decision responses and defers immediate reevaluation: %j',
  async (response) => {
    // Given
    const respond = vi.fn(() => response)
    const { filter, preferences } = filterHarness(respond)
    const context = { chatId: 'a', filter: await preferences.resolve('a') }
    await filter.evaluate(context, article())
    // When
    const result = await filter.evaluate(context, article())
    // Then
    expect(result).toBeNull()
    expect(respond).toHaveBeenCalledTimes(1)
  }
)

test('retries a transient HTTP failure through the client policy before evaluating the decision', async () => {
  // Given
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('{}', { status: 503, headers: { 'retry-after-ms': '1' } })
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify(decisionResponse(acceptedDecision)), {
        headers: { 'content-type': 'application/json' },
      })
    )
  const detector = new RelevanceDetector(
    new VeniceDecisionModel({
      apiKey: 'offline-key',
      baseURL: 'https://api.venice.ai/api/v1',
      fetch,
      maxRetries: 1,
    }),
    { relevanceThreshold: 80 }
  )
  // When
  const result = await detector.detectRelevance(article(), preference())
  // Then
  expect(result?.isRelevant).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('withholds an authentication failure without attempting a chat-completion fallback', async () => {
  // Given
  const fetch = vi.fn(async () => new Response('{}', { status: 401 }))
  const detector = new RelevanceDetector(
    new VeniceDecisionModel({
      apiKey: 'offline-key',
      baseURL: 'https://api.venice.ai/api/v1',
      fetch,
    }),
    { relevanceThreshold: 80 }
  )
  // When
  const result = await detector.detectRelevance(article(), preference())
  // Then
  expect(result).toBeNull()
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('maps fractional rubric positions to coverage scores independently of confidence', async () => {
  // Given
  const response = decisionResponse(acceptedDecision)
  response.answers.relevance.score = 3.5
  response.answers.relevance.confidence = 1
  const detector = new RelevanceDetector(
    decisionModel(() => response),
    { relevanceThreshold: 80 }
  )
  // When
  const result = await detector.detectRelevance(article(), preference())
  // Then
  expect(result).toMatchObject({ score: 70, isRelevant: false })
})

test('rejects below-threshold coverage on fresh and cached evaluations', async () => {
  // Given
  const respond = vi.fn(() => ({ ...acceptedDecision, score: 79.8 }))
  const { filter, preferences } = filterHarness(respond)
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  const item = article()
  // When
  const fresh = await filter.evaluate(context, item)
  const cached = await filter.evaluate(context, item)
  // Then
  expect([fresh?.isRelevant, cached?.isRelevant]).toEqual([false, false])
  expect(respond).toHaveBeenCalledTimes(1)
})

test('retains a confident rejection when coverage confidence is low', async () => {
  // Given
  const response = decisionResponse({
    ...acceptedDecision,
    eligible: false,
  })
  response.answers.relevance.confidence = 0.1
  const detector = new RelevanceDetector(
    decisionModel(() => response),
    { relevanceThreshold: 80 }
  )
  // When
  const result = await detector.detectRelevance(article(), preference())
  // Then
  expect(result).toMatchObject({ isRelevant: false, eligible: false })
})
