import { expect, test, vi } from 'vitest'
import { NewsPreferenceStore } from '../src/lib/news/preferences.js'
import { ChatSubscriptionStore } from '../src/lib/news/chat-subscription-store.js'
import {
  article,
  filterHarness,
  preference,
  decisionResponse,
} from './news-filter-helpers.js'

test('persists a chat threshold independently of preferences and subscriptions', async () => {
  const { redis, preferences } = filterHarness()
  const custom = preference()
  await preferences.save('a', custom)
  const subscriptions = new ChatSubscriptionStore(redis.asRedis())
  const subscription = await subscriptions.subscribe('a')

  await preferences.setRelevanceThreshold('a', 65.5)

  const reopened = new NewsPreferenceStore(redis.asRedis(), 'default-topic')
  expect((await reopened.resolve('a')).relevanceThreshold).toBe(65.5)
  expect((await reopened.resolve('a')).preference).toEqual(custom)
  expect((await reopened.resolve('b')).relevanceThreshold).toBeUndefined()
  expect(await subscriptions.getSubscription('a')).toEqual(subscription)
})

test.each([-1, 101, NaN, Infinity])(
  'rejects invalid persisted threshold %s without replacing the saved value',
  async (threshold) => {
    const { preferences } = filterHarness()
    await preferences.setRelevanceThreshold('a', 75)

    await expect(
      preferences.setRelevanceThreshold('a', threshold)
    ).rejects.toThrow()

    expect((await preferences.resolve('a')).relevanceThreshold).toBe(75)
  }
)

test('preserves a chat threshold when preferences are replaced or reset', async () => {
  const { preferences } = filterHarness()
  await preferences.setRelevanceThreshold('a', 90)

  await preferences.save('a', preference())
  await preferences.reset('a')

  expect(await preferences.resolve('a')).toMatchObject({
    source: 'default',
    relevanceThreshold: 90,
  })
})

test('applies changed thresholds to fresh and cached decisions and restores the global fallback', async () => {
  const respond = vi.fn(() => ({ eligible: true, score: 75 }))
  const { filter, preferences } = filterHarness(respond)
  const item = article()
  const evaluate = async (chatId: string) =>
    filter.evaluate({ chatId, filter: await preferences.resolve(chatId) }, item)
  await evaluate('a')
  await preferences.setRelevanceThreshold('a', 70)

  const fresh = await evaluate('a')
  const cached = await evaluate('a')
  const otherChat = await evaluate('b')
  await preferences.setRelevanceThreshold('a', null)
  const reset = await evaluate('a')

  expect(fresh?.isRelevant).toBe(true)
  expect(cached?.isRelevant).toBe(true)
  expect(otherChat?.isRelevant).toBe(false)
  expect(reset?.isRelevant).toBe(false)
  expect(respond).toHaveBeenCalledTimes(3)
})

test.each([
  { threshold: 0, score: 100, eligible: false, expected: false },
  { threshold: 70, score: 69.8, eligible: true, expected: false },
  { threshold: 70, score: 70, eligible: true, expected: true },
  { threshold: 100, score: 99.9, eligible: true, expected: false },
  { threshold: 100, score: 100, eligible: true, expected: true },
])('enforces per-chat coverage and eligibility gates: %j', async (scenario) => {
  const { filter, preferences } = filterHarness(() => scenario)
  await preferences.setRelevanceThreshold('a', scenario.threshold)

  const result = await filter.evaluate(
    { chatId: 'a', filter: await preferences.resolve('a') },
    article()
  )

  expect(result?.isRelevant).toBe(scenario.expected)
})

test('withholds uncertain eligibility even at the lowest chat threshold', async () => {
  const response = decisionResponse({ eligible: true, score: 100 })
  response.answers.eligibility.confidence = 0.79
  const { filter, preferences } = filterHarness(() => response)
  await preferences.setRelevanceThreshold('a', 0)

  const result = await filter.evaluate(
    { chatId: 'a', filter: await preferences.resolve('a') },
    article()
  )

  expect(result).toBeNull()
})
