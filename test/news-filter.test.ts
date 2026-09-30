import { expect, test, vi } from 'vitest'
import {
  NewsPreferenceGenerator,
  NewsPreferenceStore,
} from '../src/lib/news/preferences.js'
import { ChatSubscriptionStore } from '../src/lib/news/chat-subscription-store.js'
import { RelevanceDetector } from '../src/lib/news/relevance-detector.js'
import { ChatNewsFilter } from '../src/lib/news/chat-news-filter.js'
import {
  acceptedDecision,
  article,
  filterHarness,
  preference,
  structuredModel,
} from './news-filter-helpers.js'

test.each([
  { matchesInterest: true, excluded: true, score: 100, expected: false },
  { matchesInterest: false, excluded: false, score: 100, expected: false },
  { matchesInterest: true, excluded: false, score: 79, expected: false },
  { matchesInterest: true, excluded: false, score: 80, expected: true },
])(
  'enforces match, exclusion, and threshold gates: %j',
  async ({ expected, ...decision }) => {
    // Given
    const { detector } = filterHarness(() => ({ ...decision, reason: 'test' }))
    // When
    const result = await detector.detectRelevance(
      article(),
      preference('interest-a')
    )
    // Then
    expect(result?.isRelevant).toBe(expected)
  }
)

test('persists original preferences across store instances without changing subscriptions', async () => {
  // Given
  const { redis, preferences } = filterHarness()
  const subscriptions = new ChatSubscriptionStore(redis.asRedis())
  await subscriptions.subscribe('a')
  const before = await subscriptions.setIntervalSeconds('a', 900)
  const custom = preference()
  // When
  await preferences.save('a', custom)
  // Then
  const reopened = new NewsPreferenceStore(redis.asRedis(), 'default-topic')
  expect((await reopened.resolve('a')).preference).toEqual(custom)
  expect((await reopened.resolve('b')).source).toBe('default')
  expect(await subscriptions.getSubscription('a')).toEqual(before)
})

test('reset restores configured defaults instead of old custom topics', async () => {
  // Given
  const { redis, preferences } = filterHarness()
  await redis.set(
    'news:chat-subscription:a',
    JSON.stringify({ topics: ['legacy-topic'] })
  )
  expect((await preferences.resolve('a')).source).toBe('custom')
  await preferences.save('a', preference())
  // When
  await preferences.reset('a')
  // Then
  const current = await preferences.resolve('a')
  expect(current.source).toBe('default')
  expect(current.preference).toBeUndefined()
  expect(current.instruction).toBe((await preferences.resolve('b')).instruction)
})

test('caches the exclusion decision even when its score is high', async () => {
  // Given
  const respond = vi.fn(() => ({ ...acceptedDecision, excluded: true }))
  const { filter, preferences } = filterHarness(respond)
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  const item = article()
  await filter.evaluate(context, item)
  // When
  const cached = await filter.evaluate(context, item)
  // Then
  expect(cached).toMatchObject({ score: 95, excluded: true, isRelevant: false })
  expect(respond).toHaveBeenCalledTimes(1)
})

test('invalidates decisions after preference replacement and isolates chats', async () => {
  // Given
  const respond = vi.fn(() => acceptedDecision)
  const { filter, preferences } = filterHarness(respond)
  const item = article()
  await filter.evaluate(
    { chatId: 'a', filter: await preferences.resolve('a') },
    item
  )
  await preferences.save('a', preference())
  // When
  await filter.evaluate(
    { chatId: 'a', filter: await preferences.resolve('a') },
    item
  )
  await filter.evaluate(
    { chatId: 'b', filter: await preferences.resolve('b') },
    item
  )
  // Then
  expect(respond).toHaveBeenCalledTimes(3)
})

test('invalidates cached decisions when scoring configuration changes', async () => {
  // Given
  const respond = vi.fn(() => acceptedDecision)
  const { filter, preferences, redis, model } = filterHarness(respond)
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  const item = article()
  await filter.evaluate(context, item)
  const changed = new ChatNewsFilter(
    redis.asRedis(),
    preferences,
    new RelevanceDetector(model, {
      relevanceThreshold: 99,
      systemPrompt: 'changed-role',
    })
  )
  // When
  const result = await changed.evaluate(context, item)
  // Then
  expect(result?.isRelevant).toBe(false)
  expect(respond).toHaveBeenCalledTimes(2)
})

test('retries scoring after a failed provider response instead of caching rejection', async () => {
  // Given
  const respond = vi
    .fn<() => unknown>()
    .mockRejectedValueOnce(new Error('provider unavailable'))
    .mockReturnValue(acceptedDecision)
  const { filter, preferences } = filterHarness(respond)
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  const item = article()
  expect(await filter.evaluate(context, item)).toBeNull()
  // When
  const result = await filter.evaluate(context, item)
  // Then
  expect(result?.isRelevant).toBe(true)
  expect(respond).toHaveBeenCalledTimes(2)
})

test('generates validated preferences with the configured role and preserves original input', async () => {
  // Given
  const criteria = {
    interests: [{ rule: 'user-input', sourceText: 'user-input' }],
    exclusions: [],
    titleRules: [],
  }
  const respond = vi.fn(() => criteria)
  const generator = new NewsPreferenceGenerator(structuredModel(respond), {
    model: 'generator-model',
    supportsVision: false,
    systemPrompt: 'generator-role',
  })
  // When
  const result = await generator.generate('  user-input  ')
  // Then
  expect(result).toMatchObject({
    description: 'user-input',
    criteria,
    model: 'generator-model',
  })
  expect(respond).toHaveBeenCalledTimes(1)
})

test.each([
  { instruction: '' },
  { instruction: 'x'.repeat(3001) },
  { wrong: 'shape' },
])('rejects invalid generated instructions: %j', async (output) => {
  // Given
  const generator = new NewsPreferenceGenerator(
    structuredModel(() => output),
    {
      model: 'generator-model',
      supportsVision: false,
      systemPrompt: 'generator-role',
    }
  )
  // When / Then
  await expect(generator.generate('user-input')).rejects.toThrow()
})
