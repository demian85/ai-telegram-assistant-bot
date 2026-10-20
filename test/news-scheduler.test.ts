import type { JobsOptions } from 'bullmq'
import { expect, test, vi } from 'vitest'
import { NewsScheduler } from '../src/lib/news/scheduler.js'
import { NewsStore } from '../src/lib/news/news-store.js'
import { ChatSubscriptionStore } from '../src/lib/news/chat-subscription-store.js'
import { NewsDeliveryStore } from '../src/lib/news/news-delivery-store.js'
import {
  article,
  decisionModel,
  acceptedDecision,
  filterHarness,
  preference,
} from './news-filter-helpers.js'
import {
  InMemoryRedis,
  captureLoggerRecords,
  createNoopQueue,
  createNoopWorker,
} from './test-helpers.js'

type RepeatSchedule = {
  readonly key: string
  readonly name: string
  readonly every: number
}

const newsConfig = {
  feeds: [],
  pollIntervalMinutes: 15,
  deliveryCheckIntervalSeconds: 300,
  relevanceThreshold: 70,
  maxArticlesPerPoll: 10,
  defaultFilter: 'news interests',
}

class ScheduleQueue {
  readonly schedules = new Map<string, RepeatSchedule>()
  readonly startupJobs: string[] = []

  constructor(schedules: readonly RepeatSchedule[]) {
    for (const schedule of schedules) this.schedules.set(schedule.key, schedule)
  }

  async add(name: string, _data: Record<string, never>, options?: JobsOptions) {
    if (options?.repeat?.every) {
      const key = `${name}:${options.jobId}:${options.repeat.every}`
      this.schedules.set(key, { key, name, every: options.repeat.every })
    } else {
      this.startupJobs.push(name)
    }
  }

  async getRepeatableJobs() {
    return [...this.schedules.values()]
  }

  async removeRepeatableByKey(key: string) {
    return this.schedules.delete(key)
  }

  async close() {}
}

function schedulerWithQueue(queue: ScheduleQueue) {
  const redis = new InMemoryRedis()
  return new NewsScheduler(
    {
      redis: redis.asRedis(),
      model: decisionModel(() => acceptedDecision),
      newsConfig,
    },
    { queue, worker: createNoopWorker() }
  )
}

test('startup replaces stale news repeat schedules while preserving other jobs', async () => {
  // Given stale schedules at both old and current intervals, plus another job.
  const other = { key: 'other-repeat', name: 'other-job', every: 10_000 }
  const queue = new ScheduleQueue([
    { key: 'poll-old', name: 'poll-news', every: 300_000 },
    { key: 'poll-current', name: 'poll-news', every: 900_000 },
    { key: 'delivery-old', name: 'deliver-news', every: 60_000 },
    { key: 'delivery-current', name: 'deliver-news', every: 300_000 },
    other,
  ])
  const scheduler = schedulerWithQueue(queue)

  // When startup reconciles the configured schedules.
  await scheduler.start()

  // Then only the two current news schedules remain alongside the other job.
  expect([...queue.schedules.values()]).toEqual([
    other,
    {
      key: 'poll-news:poll-news-repeat:900000',
      name: 'poll-news',
      every: 900_000,
    },
    {
      key: 'deliver-news:deliver-news-repeat:300000',
      name: 'deliver-news',
      every: 300_000,
    },
  ])
  expect(queue.startupJobs).toEqual(['poll-news', 'deliver-news'])
})

test.each(['listing', 'removal'] as const)(
  'startup enqueues no jobs when repeat schedule %s fails',
  async (stage) => {
    // Given a queue operation failure while stale news schedules exist.
    const failure = new Error(`Simulated ${stage} failure`)
    const queue = new ScheduleQueue([
      { key: 'delivery-old', name: 'deliver-news', every: 60_000 },
    ])
    if (stage === 'listing') {
      queue.getRepeatableJobs = async () => {
        throw failure
      }
    } else {
      queue.removeRepeatableByKey = async () => {
        throw failure
      }
    }
    const scheduler = schedulerWithQueue(queue)

    // When startup attempts schedule reconciliation.
    const starting = scheduler.start()

    // Then startup fails before adding immediate or repeating jobs.
    await expect(starting).rejects.toBe(failure)
    expect(queue.startupJobs).toEqual([])
    expect([...queue.schedules.keys()]).toEqual(['delivery-old'])
  }
)

test('delivery evaluation detail is debug level while successful delivery remains info', async () => {
  // Given a subscribed chat and a relevant article evaluated by an offline model.
  const redis = new InMemoryRedis()
  const subscriptions = new ChatSubscriptionStore(redis.asRedis())
  const newsStore = new NewsStore(redis.asRedis())
  await subscriptions.subscribe('chat-log', new Date('2026-01-01T00:00:00Z'))
  await newsStore.storeItem(article('log-item'))
  const scheduler = new NewsScheduler(
    {
      redis: redis.asRedis(),
      model: decisionModel(() => acceptedDecision),
      newsConfig,
    },
    {
      chatSubscriptionStore: subscriptions,
      newsStore,
      queue: createNoopQueue(),
      worker: createNoopWorker(),
    }
  )

  // When delivery evaluates and sends the article.
  const { records } = await captureLoggerRecords(() =>
    scheduler['deliverRelevantArticles'](async () => undefined)
  )

  // Then routine score detail does not reach the default info console stream.
  expect(
    records.find(
      (record) => record.context.event === 'news.delivery.chat.score'
    )?.level
  ).toBe('debug')
  expect(
    records.find((record) => record.context.event === 'news.delivery.success')
      ?.level
  ).toBe('info')
})

test.each([
  { allowedGroupIds: undefined, expectedChatIds: ['100'] },
  { allowedGroupIds: [], expectedChatIds: ['100'] },
  { allowedGroupIds: ['-300'], expectedChatIds: ['100'] },
  { allowedGroupIds: ['-100'], expectedChatIds: ['-100', '100'] },
])(
  'skips denied group subscriptions before scoring with allowlist $allowedGroupIds',
  async ({ allowedGroupIds, expectedChatIds }) => {
    // Given due private and group subscriptions with a fresh relevant article.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'))
    try {
      const respond = vi.fn(() => acceptedDecision)
      const harness = filterHarness(respond)
      const subscriptions = new ChatSubscriptionStore(harness.redis.asRedis())
      const newsStore = new NewsStore(harness.redis.asRedis())
      const deliveryStore = new NewsDeliveryStore(harness.redis.asRedis())
      for (const chatId of ['-100', '-200', '100']) {
        await subscriptions.subscribe(chatId, new Date('2026-10-20T11:00:00Z'))
        await harness.preferences.save(chatId, preference(`topic-${chatId}`))
      }
      const deniedSubscription = await subscriptions.getSubscription('-200')
      await newsStore.storeItem(article('allowlist-news'))
      const evaluate = vi.spyOn(harness.filter, 'evaluate')
      const resolve = vi.spyOn(harness.preferences, 'resolve')
      const scheduler = new NewsScheduler(
        {
          redis: harness.redis.asRedis(),
          model: harness.model,
          newsConfig,
          ...(allowedGroupIds === undefined ? {} : { allowedGroupIds }),
        },
        {
          filter: harness.filter,
          chatSubscriptionStore: subscriptions,
          newsStore,
          newsDeliveryStore: deliveryStore,
          queue: createNoopQueue(),
          worker: createNoopWorker(),
        }
      )
      const deliveredChatIds: string[] = []

      // When scheduled delivery processes the stored subscriptions.
      await scheduler['deliverRelevantArticles'](async ({ chatId }) => {
        deliveredChatIds.push(chatId)
      })

      // Then only allowed groups and the private chat use scoring or delivery.
      expect(evaluate.mock.calls.map(([context]) => context.chatId)).toEqual(
        expectedChatIds
      )
      expect(new Set(resolve.mock.calls.map(([chatId]) => chatId))).toEqual(
        new Set(expectedChatIds)
      )
      expect(respond).toHaveBeenCalledTimes(expectedChatIds.length)
      expect(deliveredChatIds).toEqual(expectedChatIds)
      expect(await deliveryStore.getDeliveredItemIds('-200')).toEqual([])
      expect(await subscriptions.getSubscription('-200')).toEqual(
        deniedSubscription
      )
    } finally {
      vi.useRealTimers()
    }
  }
)
