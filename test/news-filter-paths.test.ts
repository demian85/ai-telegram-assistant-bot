import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import {
  NewsQueryService,
  NewsScheduler,
  NewsStore,
  ChatSubscriptionStore,
} from '../src/lib/news/index.js'
import { createRecentNewsTool } from '../src/lib/agent/tools.js'
import {
  acceptedDecision,
  article,
  filterHarness,
  preference,
  type ModelRequest,
} from './news-filter-helpers.js'
import { createNoopQueue, createNoopWorker } from './test-helpers.js'

const scoringInput = z.object({
  preferences: z.string(),
  article: z.object({ title: z.string(), content: z.string().optional() }),
})
function input(request: ModelRequest) {
  return scoringInput.parse(
    JSON.parse(request.messages.at(-1)?.content ?? '{}')
  )
}

test('queries score beyond the first ten candidates and retain article content', async () => {
  const harness = filterHarness((request) => ({
    ...acceptedDecision,
    matchesInterest: input(request).article.content === 'qualifying-body',
  }))
  const store = new NewsStore(harness.redis.asRedis())
  for (let index = 0; index < 11; index++) {
    await store.storeItem({
      ...article(`item-${index}`),
      fetchedAt: new Date(Date.now() - index * 1000),
      content: index === 10 ? 'qualifying-body' : 'other-body',
    })
  }
  const query = new NewsQueryService({
    redis: harness.redis.asRedis(),
    filter: harness.filter,
  })

  const result = await query.getRecentNewsForChat(5, 'a')

  expect(result.map((item) => item.id)).toEqual(['item-10'])
})

test('scheduled delivery, queries, summary, and news tool share saved preferences', async () => {
  const respond = vi.fn((request: ModelRequest) => ({
    ...acceptedDecision,
    excluded: input(request).article.title === 'excluded',
  }))
  const harness = filterHarness(respond)
  await harness.preferences.save('100', preference('custom-filter'))
  const store = new NewsStore(harness.redis.asRedis())
  await store.storeItem(article('excluded'))
  await store.storeItem(article('allowed'))
  const subscriptions = new ChatSubscriptionStore(harness.redis.asRedis())
  await subscriptions.subscribe('100', new Date(Date.now() - 60_000))
  const query = new NewsQueryService({
    redis: harness.redis.asRedis(),
    filter: harness.filter,
  })
  const scheduler = new NewsScheduler(
    {
      redis: harness.redis.asRedis(),
      model: harness.model,
      newsConfig: {
        feeds: [],
        topics: ['different-default'],
        relevanceThreshold: 80,
        pollIntervalMinutes: 5,
        deliveryCheckIntervalSeconds: 60,
        maxArticlesPerPoll: 10,
      },
    },
    {
      filter: harness.filter,
      newsStore: store,
      queue: createNoopQueue(),
      worker: createNoopWorker(),
    }
  )
  const deliveries: string[] = []

  await scheduler['deliverRelevantArticles'](async (delivery) => {
    deliveries.push(delivery.article.articleId)
  })
  const recent = await query.getRecentNewsForChat(10, '100')
  const summary = await query.getRecentNewsLast24HoursForChat(10, '100')
  const toolOutput = await createRecentNewsTool(query).invoke(
    { count: 10 },
    { configurable: { newsChatId: '100' } }
  )

  expect(deliveries).toEqual(['allowed'])
  expect(recent.map((item) => item.id)).toEqual(['allowed'])
  expect(summary.map((item) => item.id)).toEqual(['allowed'])
  expect(toolOutput).toContain('https://example.test/allowed')
  expect(toolOutput).not.toContain('https://example.test/excluded')
  expect(respond).toHaveBeenCalledTimes(2)
  expect(
    respond.mock.calls.map(([request]) => input(request).preferences)
  ).toEqual(['custom-filter', 'custom-filter'])
})

test('news tool uses trusted invocation context and fails closed when absent', async () => {
  const harness = filterHarness((request) => ({
    ...acceptedDecision,
    matchesInterest: input(request).preferences === 'profile-b',
  }))
  await harness.preferences.save('a', preference('profile-a'))
  await harness.preferences.save('b', preference('profile-b'))
  await new NewsStore(harness.redis.asRedis()).storeItem(
    article('private-news')
  )
  const tool = createRecentNewsTool(
    new NewsQueryService({
      redis: harness.redis.asRedis(),
      filter: harness.filter,
    })
  )

  const [a, b, missing] = await Promise.all([
    tool.invoke(
      { count: 1, newsChatId: 'b' },
      { configurable: { newsChatId: 'a' } }
    ),
    tool.invoke({ count: 1 }, { configurable: { newsChatId: 'b' } }),
    tool.invoke({ count: 1 }),
  ])

  expect(a).not.toContain('https://example.test/private-news')
  expect(b).toContain('https://example.test/private-news')
  expect(missing).not.toContain('https://example.test/private-news')
})

test('delivery discards a result if preferences change while the model is scoring', async () => {
  const harness = filterHarness()
  await new NewsStore(harness.redis.asRedis()).storeItem(article())
  await new ChatSubscriptionStore(harness.redis.asRedis()).subscribe(
    'a',
    new Date(Date.now() - 60_000)
  )
  vi.spyOn(harness.detector, 'detectRelevance').mockImplementation(async () => {
    await harness.preferences.save('a', preference('updated-filter'))
    return { ...acceptedDecision, isRelevant: true }
  })
  const scheduler = new NewsScheduler(
    {
      redis: harness.redis.asRedis(),
      model: harness.model,
      newsConfig: {
        feeds: [],
        topics: [],
        relevanceThreshold: 80,
        pollIntervalMinutes: 5,
        deliveryCheckIntervalSeconds: 60,
        maxArticlesPerPoll: 10,
      },
    },
    {
      filter: harness.filter,
      queue: createNoopQueue(),
      worker: createNoopWorker(),
    }
  )
  const send = vi.fn(async () => {})

  await scheduler['deliverRelevantArticles'](send)

  expect(send).not.toHaveBeenCalled()
})
