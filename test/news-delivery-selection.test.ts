import { expect, test, vi } from 'vitest'
import { NewsScheduler } from '../src/lib/news/scheduler.js'
import { NewsStore } from '../src/lib/news/news-store.js'
import { NewsDeliveryStore } from '../src/lib/news/news-delivery-store.js'
import { ChatSubscriptionStore } from '../src/lib/news/chat-subscription-store.js'
import { NewsQueryService } from '../src/lib/news/news-query-service.js'
import { NewsEvaluationBudget } from '../src/lib/news/evaluation-budget.js'
import {
  acceptedDecision,
  article,
  filterHarness,
  type DecisionRequest,
} from './news-filter-helpers.js'
import { createNoopQueue, createNoopWorker } from './test-helpers.js'

const now = new Date('2026-11-04T16:00:00Z')

test('delivery prefers original sources and accepts publications exactly 48 hours old', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  try {
    const harness = filterHarness()
    const store = new NewsStore(harness.redis.asRedis())
    await new ChatSubscriptionStore(harness.redis.asRedis()).subscribe(
      'a',
      new Date(now.getTime() - 60_000)
    )
    for (const item of [
      { ...article('stale'), publishedAt: new Date('2024-04-09T00:00:00Z') },
      { ...article('future'), publishedAt: new Date('2026-11-05T16:00:00Z') },
      {
        ...article('commentary'),
        title: 'OpenAI to acquire Pierre: Code Storage comes to Codex',
      },
      {
        ...article('original'),
        title: 'OpenAI to acquire Pierre Computer Company, Inc.',
        url: 'https://openai.com/index/pierre',
        publishedAt: new Date('2026-11-02T16:00:00Z'),
      },
    ])
      await store.storeItem(item)
    const scheduler = new NewsScheduler(
      {
        redis: harness.redis.asRedis(),
        model: harness.model,
        newsConfig: {
          feeds: [],
          defaultFilter: 'coding news',
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
    const delivered: string[] = []

    await scheduler['deliverRelevantArticles'](async ({ article }) => {
      delivered.push(article.articleId)
    })

    expect(delivered).toEqual(['original'])
  } finally {
    vi.useRealTimers()
  }
})

test('duplicate checks override cached relevance, respect budgets, and retain new developments', async () => {
  const respond = vi.fn((request: DecisionRequest) => ({
    ...acceptedDecision,
    eligible:
      !request.state.previousArticles?.length ||
      request.state.article.title === 'New release',
  }))
  const harness = filterHarness(respond)
  const context = {
    chatId: 'a',
    filter: await harness.preferences.resolve('a'),
  }
  const duplicate = article('Repeated event')
  const previous = [article('Original event')]
  await harness.filter.evaluate(context, duplicate)

  const blocked = await harness.filter.evaluateDistinct(
    { ...context, budget: new NewsEvaluationBudget(0) },
    duplicate,
    previous
  )
  const repeated = await harness.filter.evaluateDistinct(
    context,
    duplicate,
    previous
  )
  const newDevelopment = await harness.filter.evaluateDistinct(
    context,
    article('New release'),
    previous
  )

  expect([blocked, repeated?.isRelevant, newDevelopment?.isRelevant]).toEqual([
    null,
    false,
    true,
  ])
})

test('queries return one article per event without hiding later developments', async () => {
  const harness = filterHarness((request) => ({
    ...acceptedDecision,
    eligible:
      !request.state.previousArticles?.length ||
      request.state.article.title === 'Different event',
  }))
  const store = new NewsStore(harness.redis.asRedis())
  for (const [index, title] of [
    'Original event',
    'Repeated event',
    'Different event',
  ].entries()) {
    await store.storeItem({
      ...article(title),
      fetchedAt: new Date(Date.now() - index * 1000),
    })
  }
  const query = new NewsQueryService({
    redis: harness.redis.asRedis(),
    filter: harness.filter,
  })

  const result = await query.getRecentNewsForChat(10, 'a')

  expect(result.map((item) => item.id)).toEqual([
    'Original event',
    'Different event',
  ])
})

test('delivery compares against persistent per-chat history and releases stories after send rollback', async () => {
  const harness = filterHarness((request) => ({
    ...acceptedDecision,
    eligible: !request.state.previousArticles?.length,
  }))
  const store = new NewsStore(harness.redis.asRedis())
  const deliveryStore = new NewsDeliveryStore(harness.redis.asRedis())
  const subscriptions = new ChatSubscriptionStore(harness.redis.asRedis())
  const original = article('original')
  await store.storeItem(original)
  await store.storeItem(article('followup'))
  await deliveryStore.markDelivered('a', original.id)
  await subscriptions.subscribe('a', new Date(Date.now() - 60_000))
  await subscriptions.subscribe('b', new Date(Date.now() - 60_000))
  const createScheduler = () =>
    new NewsScheduler(
      {
        redis: harness.redis.asRedis(),
        model: harness.model,
        newsConfig: {
          feeds: [],
          defaultFilter: 'coding news',
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
  const delivered: string[] = []
  const failedAttempt: string[] = []

  await expect(
    createScheduler()['deliverRelevantArticles'](async ({ chatId }) => {
      failedAttempt.push(chatId)
      if (chatId === 'b') throw new Error('Telegram unavailable')
    })
  ).rejects.toThrow('Telegram unavailable')
  await createScheduler()['deliverRelevantArticles'](
    async ({ chatId, article }) => {
      delivered.push(`${chatId}:${article.articleId}`)
    }
  )

  expect({ failedAttempt, delivered }).toEqual({
    failedAttempt: ['b'],
    delivered: ['b:followup'],
  })
})

test.each([
  ['2026-11-02T15:59:59.999Z', 'older than 48 hours'],
  ['2026-11-04T16:00:00.001Z', 'in the future'],
])(
  'delivery skips publications %s (%s), even with cached acceptances',
  async (publishedAt) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    try {
      const harness = filterHarness()
      const store = new NewsStore(harness.redis.asRedis())
      const candidate = {
        ...article('a-candidate'),
        publishedAt: new Date(publishedAt),
      }
      await store.storeItem(candidate)
      await store.storeItem(article('b-fresh'))
      await harness.filter.evaluate(
        { chatId: 'a', filter: await harness.preferences.resolve('a') },
        candidate
      )
      await new ChatSubscriptionStore(harness.redis.asRedis()).subscribe(
        'a',
        new Date(now.getTime() - 60_000)
      )
      const scheduler = new NewsScheduler(
        {
          redis: harness.redis.asRedis(),
          model: harness.model,
          newsConfig: {
            feeds: [],
            defaultFilter: 'coding news',
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
      const delivered: string[] = []

      await scheduler['deliverRelevantArticles'](async ({ article }) => {
        delivered.push(article.articleId)
      })

      expect(delivered).toEqual(['b-fresh'])
    } finally {
      vi.useRealTimers()
    }
  }
)
