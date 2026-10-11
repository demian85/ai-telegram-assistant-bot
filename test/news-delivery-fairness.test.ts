import { expect, test, vi } from 'vitest'
import { NewsScheduler } from '../src/lib/news/scheduler.js'
import { NewsStore } from '../src/lib/news/news-store.js'
import { ChatSubscriptionStore } from '../src/lib/news/chat-subscription-store.js'
import { article, filterHarness, preference } from './news-filter-helpers.js'
import { createNoopQueue, createNoopWorker } from './test-helpers.js'

test.each([
  {
    scenario: 'a chat is inserted before the cursor',
    notDueFirst: false,
    addChat: '0',
    removeChat: undefined,
    nextTopic: 'topic-b',
  },
  {
    scenario: 'the budget-consuming chat is removed',
    notDueFirst: false,
    addChat: undefined,
    removeChat: 'a',
    nextTopic: 'topic-b',
  },
  {
    scenario: 'an earlier not-due chat is removed',
    notDueFirst: true,
    addChat: undefined,
    removeChat: 'a',
    nextTopic: 'topic-c',
  },
])(
  'keeps delivery fair when $scenario',
  async ({ notDueFirst, addChat, removeChat, nextTopic }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-11T13:00:00Z'))
    try {
      const evaluated: string[] = []
      const harness = filterHarness((request) => {
        evaluated.push(request.state.preferences)
        return { eligible: false, score: 0 }
      })
      const subscriptions = new ChatSubscriptionStore(harness.redis.asRedis())
      const store = new NewsStore(harness.redis.asRedis())
      const subscribedAt = new Date(Date.now() - 60_000)
      for (const chatId of ['a', 'b', 'c']) {
        await subscriptions.subscribe(chatId, subscribedAt)
        await harness.preferences.save(chatId, preference(`topic-${chatId}`))
      }
      if (notDueFirst) await subscriptions.markSent('a')
      for (let index = 0; index < 25; index++) {
        await store.storeItem(article(`item-${String(index).padStart(2, '0')}`))
      }
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
          newsStore: store,
          chatSubscriptionStore: subscriptions,
          queue: createNoopQueue(),
          worker: createNoopWorker(),
        }
      )
      await scheduler['deliverRelevantArticles'](async () => undefined)
      if (addChat) await subscriptions.subscribe(addChat, subscribedAt)
      if (removeChat) await subscriptions.unsubscribe(removeChat)

      await scheduler['deliverRelevantArticles'](async () => undefined)

      expect(evaluated.slice(10)).toEqual(
        Array.from({ length: 10 }, () => nextTopic)
      )
    } finally {
      vi.useRealTimers()
    }
  }
)
