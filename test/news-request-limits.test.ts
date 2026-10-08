import { expect, test, vi } from 'vitest'
import { NewsScheduler } from '../src/lib/news/scheduler.js'
import { NewsQueryService } from '../src/lib/news/news-query-service.js'
import { NewsStore } from '../src/lib/news/news-store.js'
import { ChatSubscriptionStore } from '../src/lib/news/chat-subscription-store.js'
import { NewsEvaluationBudget } from '../src/lib/news/evaluation-budget.js'
import {
  acceptedDecision,
  article,
  filterHarness,
  preference,
} from './news-filter-helpers.js'
import type { DecisionRequest } from './news-filter-helpers.js'
import { createNoopQueue, createNoopWorker } from './test-helpers.js'

async function backlog(count = 25) {
  const evaluated: string[] = []
  const respond = vi.fn((request: DecisionRequest) => {
    evaluated.push(request.state.article.title)
    return { ...acceptedDecision, eligible: false }
  })
  const harness = filterHarness(respond)
  await harness.preferences.save('a', preference('topic-a'))
  await harness.preferences.save('b', preference('topic-b'))
  const store = new NewsStore(harness.redis.asRedis())
  const subscriptions = new ChatSubscriptionStore(harness.redis.asRedis())
  await subscriptions.subscribe('a', new Date(Date.now() - 60_000))
  await subscriptions.subscribe('b', new Date(Date.now() - 60_000))
  for (let index = 0; index < count; index++) {
    await store.storeItem(article(`item-${String(index).padStart(2, '0')}`))
  }
  return { ...harness, store, subscriptions, respond, evaluated }
}

test('limits fresh delivery decisions across chats while progressing through a cold backlog', async () => {
  // Given a cold backlog larger than the cycle budget and two subscribed chats.
  const harness = await backlog()
  const scheduler = new NewsScheduler(
    {
      redis: harness.redis.asRedis(),
      model: harness.model,
      newsConfig: {
        feeds: [],
        pollIntervalMinutes: 15,
        deliveryCheckIntervalSeconds: 300,
        maxArticlesPerPoll: 5,
        relevanceThreshold: 80,
        defaultFilter: 'default-topic',
      },
    },
    {
      filter: harness.filter,
      newsStore: harness.store,
      chatSubscriptionStore: harness.subscriptions,
      queue: createNoopQueue(),
      worker: createNoopWorker(),
    }
  )
  const send = vi.fn(async () => undefined)

  // When consecutive cycles evaluate the backlog without finding a match.
  await scheduler['deliverRelevantArticles'](send)
  expect(harness.respond).toHaveBeenCalledTimes(10)
  await scheduler['deliverRelevantArticles'](send)
  expect(
    harness.respond.mock.calls
      .slice(10)
      .map(([request]) => request.state.preferences)
  ).toEqual(Array.from({ length: 10 }, () => 'topic-b'))
  expect(harness.respond).toHaveBeenCalledTimes(20)
  await scheduler['deliverRelevantArticles'](send)

  // Then both chats receive evaluations and cached rejections let later cycles advance.
  expect(harness.respond).toHaveBeenCalledTimes(30)
  expect(new Set(harness.evaluated).size).toBe(20)
  expect(send).not.toHaveBeenCalled()
})

test('bounds manual queries to fifty candidates and reuses cached decisions', async () => {
  // Given a manual query with more than fifty candidates and no matching decisions.
  const harness = await backlog(60)
  const query = new NewsQueryService({
    redis: harness.redis.asRedis(),
    filter: harness.filter,
  })

  // When the user queries twice against the same backlog.
  const first = await query.getRecentNewsForChat(10, 'a')
  expect(harness.respond).toHaveBeenCalledTimes(50)
  const second = await query.getRecentNewsForChat(10, 'a')

  // Then the repeated query uses cached decisions and never scans past fifty candidates.
  expect([first, second]).toEqual([[], []])
  expect(harness.respond).toHaveBeenCalledTimes(50)
})

test('serves cached decisions with an exhausted budget and leaves skipped articles eligible', async () => {
  // Given a cached acceptance and an exhausted evaluation budget.
  const respond = vi.fn(() => acceptedDecision)
  const { filter, preferences } = filterHarness(respond)
  const context = { chatId: 'a', filter: await preferences.resolve('a') }
  const cached = article('cached')
  await filter.evaluate(context, cached)

  // When a cached and fresh article are evaluated without a request budget.
  const exhausted = { ...context, budget: new NewsEvaluationBudget(0) }
  const hit = await filter.evaluate(exhausted, cached)
  const skip = await filter.evaluate(exhausted, article('fresh'))
  expect(respond).toHaveBeenCalledTimes(1)
  const fresh = await filter.evaluate(
    { ...context, budget: new NewsEvaluationBudget(1) },
    article('fresh')
  )

  // Then the cache is available and the skipped article has no retry penalty.
  expect(hit?.isRelevant).toBe(true)
  expect(skip).toBeNull()
  expect(fresh?.isRelevant).toBe(true)
  expect(respond).toHaveBeenCalledTimes(2)
})
