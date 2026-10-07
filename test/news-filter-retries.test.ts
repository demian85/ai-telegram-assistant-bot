import { expect, test, vi } from 'vitest'
import { ChatNewsFilter } from '../src/lib/news/chat-news-filter.js'
import {
  acceptedDecision,
  article,
  decisionResponse,
  filterHarness,
  preference,
} from './news-filter-helpers.js'
import { captureLoggerRecords } from './test-helpers.js'

test('persists retry cooldowns and bounds unresolved calls across filter instances', async () => {
  // Given
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-07T00:00:00Z'))
  try {
    const response = decisionResponse(acceptedDecision)
    response.answers.interest.confidence = 0.79
    const respond = vi.fn(() => response)
    const { filter, preferences, redis, detector } = filterHarness(respond)
    const context = { chatId: 'a', filter: await preferences.resolve('a') }
    const item = article()
    expect(await filter.evaluate(context, item)).toBeNull()
    const reopened = new ChatNewsFilter(redis.asRedis(), preferences, detector)
    // When
    await reopened.evaluate(context, item)
    expect(respond).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-10-07T00:15:00Z'))
    await reopened.evaluate(context, item)
    expect(respond).toHaveBeenCalledTimes(2)
    vi.setSystemTime(new Date('2026-10-07T01:14:59Z'))
    await reopened.evaluate(context, item)
    expect(respond).toHaveBeenCalledTimes(2)
    vi.setSystemTime(new Date('2026-10-07T01:15:00Z'))
    await reopened.evaluate(context, item)
    vi.setSystemTime(new Date('2026-10-08T01:15:00Z'))
    const result = await reopened.evaluate(context, item)
    // Then
    expect(result).toBeNull()
    expect(respond).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

test('preference changes and different articles receive independent retry budgets', async () => {
  // Given
  const respond = vi.fn(() => ({ answers: {} }))
  const { filter, preferences } = filterHarness(respond)
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  const item = article()
  await filter.evaluate(context, item)
  // When
  await filter.evaluate(context, item)
  await preferences.save('a', preference('changed preference'))
  await filter.evaluate(
    { chatId: 'a', filter: await preferences.resolve('a') },
    item
  )
  await filter.evaluate(context, article('different-article'))
  // Then
  expect(respond).toHaveBeenCalledTimes(3)
})

test('shares concurrent evaluations of the same article and preference', async () => {
  // Given
  const respond = vi.fn(() => acceptedDecision)
  const { filter, preferences } = filterHarness(respond)
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  const item = article()
  // When
  const results = await Promise.all([
    filter.evaluate(context, item),
    filter.evaluate(context, item),
  ])
  // Then
  expect(results.every((result) => result?.isRelevant)).toBe(true)
  expect(respond).toHaveBeenCalledTimes(1)
})

test('logs model requests separately from cached decisions', async () => {
  // Given
  const { filter, preferences } = filterHarness()
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  const item = article()
  // When
  const { records } = await captureLoggerRecords(async () => {
    await filter.evaluate(context, item)
    await filter.evaluate(context, item)
  })
  // Then
  expect(
    records.filter((record) => record.context.event === 'news.decision.request')
  ).toHaveLength(1)
  expect(
    records.filter(
      (record) => record.context.event === 'news.decision.cache_hit'
    )
  ).toMatchObject([{ level: 'debug' }])
})
