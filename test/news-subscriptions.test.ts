import { test, expect } from 'vitest'
import {
  ChatSubscriptionStore,
  NewsDeliveryStore,
  NewsScheduler,
  NewsStore,
  RelevanceDetector,
  defaultNewsIntervalSeconds,
  minNewsIntervalSeconds,
  type NewsItem,
} from '../src/lib/news/index.js'
import {
  InMemoryRedis,
  captureLoggerRecords,
  createNoopQueue,
  createNoopWorker,
} from './test-helpers.js'

function createMockRelevanceDetector() {
  return {
    detectRelevance: async () => ({ score: 90, isRelevant: true }),
    batchDetectRelevance: async (items: NewsItem[]) => {
      const results = new Map<string, { score: number; isRelevant: boolean }>()
      for (const item of items) {
        results.set(item.id, { score: 90, isRelevant: true })
      }
      return results
    },
  } as unknown as RelevanceDetector
}

function createNewsItem(input: {
  id: string
  title: string
  fetchedAt: string
  score?: number
}): NewsItem {
  return {
    id: input.id,
    source: 'test-source',
    feedUrl: 'https://feeds.test/rss.xml',
    title: input.title,
    description: `${input.title} description`,
    url: `https://news.test/${input.id}`,
    publishedAt: new Date(input.fetchedAt),
    fetchedAt: new Date(input.fetchedAt),
    relevanceScore: input.score ?? 90,
    isRelevant: true,
  }
}

const defaultNewsConfig = {
  feeds: [],
  pollIntervalMinutes: 5,
  deliveryCheckIntervalSeconds: 60,
  relevanceThreshold: 70,
  maxArticlesPerPoll: 10,
  defaultFilter: 'news interests',
}

async function overwriteSubscription(
  redis: InMemoryRedis,
  subscription: Awaited<ReturnType<ChatSubscriptionStore['getSubscription']>>
) {
  expect(subscription).toBeTruthy()
  if (!subscription) throw new Error('Missing subscription')
  await redis.set(
    `news:chat-subscription:${subscription.chatId}`,
    JSON.stringify(subscription)
  )
}

function getEventRecords(
  records: Array<{ context: Record<string, unknown> }>,
  event: string
) {
  return records.filter((record) => record.context.event === event)
}

test('subscription defaults are disabled, use the default interval, and reject invalid intervals', async () => {
  const redis = new InMemoryRedis()
  const store = new ChatSubscriptionStore(redis.asRedis())
  const now = new Date('2026-04-11T10:00:00.000Z')

  const subscription = await store.getOrCreateSubscription('chat-1', now)

  expect(subscription.enabled).toBe(false)
  expect(subscription.intervalSeconds).toBe(defaultNewsIntervalSeconds)
  expect(subscription.deliverAfter.toISOString()).toBe(now.toISOString())

  await expect(
    store.setIntervalSeconds(
      'chat-1',
      minNewsIntervalSeconds - 1,
      new Date('2026-04-11T10:05:00.000Z')
    )
  ).rejects.toThrow(/News interval must be an integer between/)
})

test('unsubscribe and resubscribe preserve the interval while resetting future delivery gating', async () => {
  const redis = new InMemoryRedis()
  const store = new ChatSubscriptionStore(redis.asRedis())

  await store.subscribe('chat-1', new Date('2026-04-11T10:00:00.000Z'))
  await store.setIntervalSeconds(
    'chat-1',
    900,
    new Date('2026-04-11T10:10:00.000Z')
  )
  const unsubscribed = await store.unsubscribe(
    'chat-1',
    new Date('2026-04-11T10:20:00.000Z')
  )
  const resubscribed = await store.subscribe(
    'chat-1',
    new Date('2026-04-11T10:30:00.000Z')
  )

  expect(unsubscribed.enabled).toBe(false)
  expect(resubscribed.enabled).toBe(true)
  expect(resubscribed.intervalSeconds).toBe(900)
  expect(resubscribed.deliverAfter.toISOString()).toBe(
    '2026-04-11T10:30:00.000Z'
  )
  expect(resubscribed.unsubscribedAt).toBeUndefined()
})

test('delivery stays isolated per chat and chooses the oldest eligible undelivered article first', async () => {
  const redis = new InMemoryRedis()
  const subscriptionStore = new ChatSubscriptionStore(redis.asRedis())
  const deliveryStore = new NewsDeliveryStore(redis.asRedis())
  const newsStore = new NewsStore(redis.asRedis())

  await subscriptionStore.subscribe(
    'chat-a',
    new Date('2026-04-11T09:00:00.000Z')
  )
  await subscriptionStore.subscribe(
    'chat-b',
    new Date('2026-04-11T09:00:00.000Z')
  )
  await newsStore.storeItem(
    createNewsItem({
      id: 'item-1',
      title: 'First relevant story',
      fetchedAt: '2026-04-11T09:01:00.000Z',
    })
  )
  await newsStore.storeItem(
    createNewsItem({
      id: 'item-2',
      title: 'Second relevant story',
      fetchedAt: '2026-04-11T09:02:00.000Z',
    })
  )

  const scheduler = new NewsScheduler(
    {
      redis: redis.asRedis(),
      model: {} as never,
      newsConfig: defaultNewsConfig,
    },
    {
      chatSubscriptionStore: subscriptionStore,
      newsDeliveryStore: deliveryStore,
      newsStore,
      relevanceDetector: createMockRelevanceDetector(),
      queue: createNoopQueue(),
      worker: createNoopWorker(),
    }
  )

  const firstPass: Array<{ chatId: string; title: string }> = []
  const { records: firstPassRecords } = await captureLoggerRecords(async () => {
    await (
      scheduler as never as {
        deliverRelevantArticles(
          callback: (delivery: {
            chatId: string
            article: { title: string }
          }) => Promise<void>
        ): Promise<void>
      }
    ).deliverRelevantArticles(async (delivery) => {
      firstPass.push({ chatId: delivery.chatId, title: delivery.article.title })
    })
  })

  expect(firstPass).toEqual([
    { chatId: 'chat-a', title: 'First relevant story' },
    { chatId: 'chat-b', title: 'First relevant story' },
  ])

  expect(getEventRecords(firstPassRecords, 'news.delivery.tick').length).toBe(1)

  const scoreRecords = getEventRecords(
    firstPassRecords,
    'news.delivery.chat.score'
  )
  expect(scoreRecords.length).toBe(2)
  expect(scoreRecords.map((record) => record.context.chatId)).toEqual([
    'chat-a',
    'chat-b',
  ])
  expect(scoreRecords.map((record) => record.context.itemId)).toEqual([
    'item-1',
    'item-1',
  ])

  const sendStartRecords = getEventRecords(
    firstPassRecords,
    'news.telegram.send.start'
  )
  expect(sendStartRecords.length).toBe(2)
  expect(
    sendStartRecords.map((record) => record.context.deliveryState)
  ).toEqual(['marked_delivered', 'marked_delivered'])

  const sendSuccessRecords = getEventRecords(
    firstPassRecords,
    'news.telegram.send.success'
  )
  expect(sendSuccessRecords.length).toBe(2)
  expect(
    sendSuccessRecords.map((record) => record.context.deliveryState)
  ).toEqual(['marked_sent', 'marked_sent'])
  console.log(
    JSON.stringify({
      scenario: 'happy_delivery',
      events: [
        ...scoreRecords.map((record) => ({
          event: record.context.event,
          chatId: record.context.chatId,
          itemId: record.context.itemId,
        })),
        ...sendStartRecords.map((record) => ({
          event: record.context.event,
          chatId: record.context.chatId,
          articleId: record.context.articleId,
          deliveryState: record.context.deliveryState,
        })),
        ...sendSuccessRecords.map((record) => ({
          event: record.context.event,
          chatId: record.context.chatId,
          articleId: record.context.articleId,
          deliveryState: record.context.deliveryState,
        })),
      ],
    })
  )

  expect(await deliveryStore.hasDelivered('chat-a', 'item-1')).toBe(true)
  expect(await deliveryStore.hasDelivered('chat-b', 'item-1')).toBe(true)

  const expiredCooldownA = await subscriptionStore.getSubscription('chat-a')
  const expiredCooldownB = await subscriptionStore.getSubscription('chat-b')
  expect(expiredCooldownA).toBeTruthy()
  expect(expiredCooldownB).toBeTruthy()
  if (!expiredCooldownA || !expiredCooldownB)
    throw new Error('Missing cooldown subscriptions')
  expiredCooldownA.lastSentAt = new Date('2026-04-11T08:00:00.000Z')
  expiredCooldownB.lastSentAt = new Date('2026-04-11T08:00:00.000Z')
  await overwriteSubscription(redis, expiredCooldownA)
  await overwriteSubscription(redis, expiredCooldownB)

  const secondPass: Array<{ chatId: string; title: string }> = []
  await (
    scheduler as never as {
      deliverRelevantArticles(
        callback: (delivery: {
          chatId: string
          article: { title: string }
        }) => Promise<void>
      ): Promise<void>
    }
  ).deliverRelevantArticles(async (delivery) => {
    secondPass.push({ chatId: delivery.chatId, title: delivery.article.title })
  })

  expect(secondPass).toEqual([
    { chatId: 'chat-a', title: 'Second relevant story' },
    { chatId: 'chat-b', title: 'Second relevant story' },
  ])
})

test('delivery respects cooldowns and skips items fetched before a resubscribe gate', async () => {
  const redis = new InMemoryRedis()
  const subscriptionStore = new ChatSubscriptionStore(redis.asRedis())
  const deliveryStore = new NewsDeliveryStore(redis.asRedis())
  const newsStore = new NewsStore(redis.asRedis())

  await newsStore.storeItem(
    createNewsItem({
      id: 'too-old',
      title: 'Older stored item',
      fetchedAt: '2026-04-11T09:59:00.000Z',
    })
  )
  await newsStore.storeItem(
    createNewsItem({
      id: 'eligible',
      title: 'Eligible new item',
      fetchedAt: '2026-04-11T10:01:00.000Z',
    })
  )

  await subscriptionStore.subscribe(
    'chat-1',
    new Date('2026-04-11T10:00:00.000Z')
  )
  const scheduler = new NewsScheduler(
    {
      redis: redis.asRedis(),
      model: {} as never,
      newsConfig: defaultNewsConfig,
    },
    {
      chatSubscriptionStore: subscriptionStore,
      newsDeliveryStore: deliveryStore,
      newsStore,
      relevanceDetector: createMockRelevanceDetector(),
      queue: createNoopQueue(),
      worker: createNoopWorker(),
    }
  )

  const cooldownBlocked: string[] = []
  const subscription = await subscriptionStore.getSubscription('chat-1')
  expect(subscription).toBeTruthy()
  if (!subscription) throw new Error('Missing subscription')
  subscription.lastSentAt = new Date()
  await overwriteSubscription(redis, subscription)

  const { records: cooldownBlockedRecords } = await captureLoggerRecords(
    async () => {
      await (
        scheduler as never as {
          deliverRelevantArticles(
            callback: (delivery: {
              article: { title: string }
            }) => Promise<void>
          ): Promise<void>
        }
      ).deliverRelevantArticles(async (delivery) => {
        cooldownBlocked.push(delivery.article.title)
      })
    }
  )

  const blockedRecord = cooldownBlockedRecords.find(
    (record: any) =>
      record.context.event === 'news.delivery.chat.skip' &&
      record.context.chatId === 'chat-1'
  )

  expect(blockedRecord).toBeTruthy()
  if (!blockedRecord) throw new Error('Missing blockedRecord')
  expect(blockedRecord.context.skipReason).toBe('not_due')
  expect(
    getEventRecords(cooldownBlockedRecords, 'news.telegram.send.start').length
  ).toBe(0)
  console.log(
    JSON.stringify({
      scenario: 'cooldown_blocked',
      event: {
        event: blockedRecord.context.event,
        chatId: blockedRecord.context.chatId,
        skipReason: blockedRecord.context.skipReason,
      },
    })
  )

  expect(cooldownBlocked).toEqual([])

  subscription.lastSentAt = new Date('2026-04-11T08:00:00.000Z')
  await overwriteSubscription(redis, subscription)

  const deliveredTitles: string[] = []
  await (
    scheduler as never as {
      deliverRelevantArticles(
        callback: (delivery: { article: { title: string } }) => Promise<void>
      ): Promise<void>
    }
  ).deliverRelevantArticles(async (delivery) => {
    deliveredTitles.push(delivery.article.title)
  })

  expect(deliveredTitles).toEqual(['Eligible new item'])
  expect(await deliveryStore.hasDelivered('chat-1', 'too-old')).toBe(false)
  expect(await deliveryStore.hasDelivered('chat-1', 'eligible')).toBe(true)
})

test('delivery rollback unmarks an article when the send callback fails', async () => {
  const redis = new InMemoryRedis()
  const subscriptionStore = new ChatSubscriptionStore(redis.asRedis())
  const deliveryStore = new NewsDeliveryStore(redis.asRedis())
  const newsStore = new NewsStore(redis.asRedis())

  await subscriptionStore.subscribe(
    'chat-rollback',
    new Date('2026-04-11T09:00:00.000Z')
  )
  await newsStore.storeItem(
    createNewsItem({
      id: 'rollback-item',
      title: 'Rollback story',
      fetchedAt: '2026-04-11T09:01:00.000Z',
    })
  )

  const scheduler = new NewsScheduler(
    {
      redis: redis.asRedis(),
      model: {} as never,
      newsConfig: defaultNewsConfig,
    },
    {
      chatSubscriptionStore: subscriptionStore,
      newsDeliveryStore: deliveryStore,
      newsStore,
      relevanceDetector: createMockRelevanceDetector(),
      queue: createNoopQueue(),
      worker: createNoopWorker(),
    }
  )

  const { records: rollbackRecords } = await captureLoggerRecords(async () => {
    await expect(
      (
        scheduler as never as {
          deliverRelevantArticles(
            callback: (delivery: {
              chatId: string
              article: { articleId: string; title: string }
            }) => Promise<void>
          ): Promise<void>
        }
      ).deliverRelevantArticles(async (delivery) => {
        expect(delivery.chatId).toBe('chat-rollback')
        expect(delivery.article.articleId).toBe('rollback-item')
        throw new Error('Simulated Telegram send failure')
      })
    ).rejects.toThrow(/Simulated Telegram send failure/)
  })

  const scoreRollbackRecord = rollbackRecords.find(
    (record: any) =>
      record.context.event === 'news.delivery.chat.score' &&
      record.context.chatId === 'chat-rollback'
  )
  expect(scoreRollbackRecord).toBeTruthy()
  if (!scoreRollbackRecord) throw new Error('Missing scoreRollbackRecord')
  expect(scoreRollbackRecord.context.itemId).toBe('rollback-item')

  const sendStartRecord = rollbackRecords.find(
    (record: any) =>
      record.context.event === 'news.telegram.send.start' &&
      record.context.chatId === 'chat-rollback'
  )
  expect(sendStartRecord).toBeTruthy()
  if (!sendStartRecord) throw new Error('Missing sendStartRecord')
  expect(sendStartRecord.context.articleId).toBe('rollback-item')

  const sendErrorRecord = rollbackRecords.find(
    (record: any) =>
      record.context.event === 'news.telegram.send.error' &&
      record.context.chatId === 'chat-rollback'
  )
  expect(sendErrorRecord).toBeTruthy()
  if (!sendErrorRecord) throw new Error('Missing sendErrorRecord')
  expect(sendErrorRecord.context.rollbackAction).toBe('unmarkDelivered')

  const rollbackRecord = rollbackRecords.find(
    (record: any) =>
      record.context.event === 'news.delivery.rollback' &&
      record.context.chatId === 'chat-rollback'
  )
  expect(rollbackRecord).toBeTruthy()
  if (!rollbackRecord) throw new Error('Missing rollbackRecord')
  expect(rollbackRecord.context.rollbackAction).toBe('unmarkDelivered')
  expect(
    getEventRecords(rollbackRecords, 'news.telegram.send.success').length
  ).toBe(0)
  console.log(
    JSON.stringify({
      scenario: 'send_failure_rollback',
      events: [
        {
          event: scoreRollbackRecord.context.event,
          chatId: scoreRollbackRecord.context.chatId,
          itemId: scoreRollbackRecord.context.itemId,
        },
        {
          event: sendStartRecord.context.event,
          chatId: sendStartRecord.context.chatId,
          articleId: sendStartRecord.context.articleId,
        },
        {
          event: sendErrorRecord.context.event,
          chatId: sendErrorRecord.context.chatId,
          articleId: sendErrorRecord.context.articleId,
          rollbackAction: sendErrorRecord.context.rollbackAction,
        },
        {
          event: rollbackRecord.context.event,
          chatId: rollbackRecord.context.chatId,
          articleId: rollbackRecord.context.articleId,
          rollbackAction: rollbackRecord.context.rollbackAction,
        },
      ],
    })
  )

  expect(
    await deliveryStore.hasDelivered('chat-rollback', 'rollback-item')
  ).toBe(false)
})
