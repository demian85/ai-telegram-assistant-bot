import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { NewsStore } from '../src/lib/news/news-store.js'
import type { NewsItem } from '../src/lib/news/types.js'
import { InMemoryRedis } from './test-helpers.js'

const now = new Date('2026-10-08T12:00:00.000Z')
const oldDate = new Date('2026-09-01T12:00:00.000Z')
const freshDate = new Date('2026-10-08T11:00:00.000Z')

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now.getTime())
})

afterEach(() => vi.restoreAllMocks())

function article(id: string, fetchedAt: Date): NewsItem {
  return {
    id,
    source: 'test',
    feedUrl: 'https://feeds.test/news',
    title: id,
    url: `https://news.test/${id}`,
    publishedAt: oldDate,
    fetchedAt,
  }
}

async function seed(redis: InMemoryRedis, item: NewsItem): Promise<void> {
  await redis.setex(`news:item:${item.id}`, 604800, JSON.stringify(item))
  await redis.zadd('news:items', item.fetchedAt.getTime(), item.id)
}

test.each([false, true])(
  'storage prunes expired references while preserving retained articles when duplicate=%s',
  async (duplicate) => {
    const redis = new InMemoryRedis()
    const store = new NewsStore(redis.asRedis())
    const fresh = article('fresh', freshDate)
    const retained = article('old-live', oldDate)
    await seed(redis, retained)
    await seed(redis, article('expired', oldDate))
    await redis.del('news:item:expired')
    if (duplicate) await seed(redis, fresh)

    const stored = await store.storeItem(fresh)

    expect(stored).toBe(!duplicate)
    expect(await redis.zrange('news:items', 0, -1)).toEqual([
      'old-live',
      'fresh',
    ])
    expect(await redis.get('news:item:old-live')).toBe(JSON.stringify(retained))
    expect(await store.getItem('fresh')).toMatchObject({
      fetchedAt: freshDate,
      publishedAt: oldDate,
    })
  }
)

const queries = [
  {
    name: 'since',
    read: (store: NewsStore) => store.getItemsSince(oldDate),
    expected: ['old-live', 'fresh'],
  },
  {
    name: 'recent',
    read: (store: NewsStore) => store.getRecentItems({ limit: 3 }),
    expected: ['fresh', 'old-live'],
  },
  {
    name: 'unscored',
    read: (store: NewsStore) => store.getUnscoredItems(3),
    expected: ['fresh', 'old-live'],
  },
  {
    name: 'relevant',
    read: (store: NewsStore) => store.getRelevantItems(70),
    expected: ['old-live', 'fresh'],
  },
  {
    name: 'unforwarded',
    read: (store: NewsStore) => store.getUnforwardedRelevantItems(70),
    expected: ['old-live', 'fresh'],
  },
]

test.each(queries)(
  '$name removes missing references while preserving live articles and ordering',
  async ({ name, read, expected }) => {
    const redis = new InMemoryRedis()
    const store = new NewsStore(redis.asRedis())
    const retained = article('old-live', oldDate)
    const fresh = article('fresh', freshDate)
    if (name === 'relevant' || name === 'unforwarded') {
      retained.relevanceScore = 90
      fresh.relevanceScore = 90
    }
    await seed(redis, retained)
    await seed(redis, fresh)
    await seed(redis, article('expired-old', oldDate))
    await seed(redis, article('expired-recent', now))
    await redis.del('news:item:expired-old', 'news:item:expired-recent')

    const result = await read(store)

    expect(result.map((item) => item.id)).toEqual(expected)
    expect(await redis.zrange('news:items', 0, -1)).toEqual([
      'old-live',
      'fresh',
    ])
    expect(await redis.get('news:item:old-live')).toBe(JSON.stringify(retained))
    expect(await redis.get('news:item:fresh')).toBe(JSON.stringify(fresh))
  }
)

test.each(['item', 'exists'] as const)(
  '%s removes a missing reference when reading an individual article',
  async (query) => {
    const redis = new InMemoryRedis()
    const store = new NewsStore(redis.asRedis())
    await seed(redis, article('missing', freshDate))
    await seed(redis, article('live', freshDate))
    await redis.del('news:item:missing')

    const result =
      query === 'item'
        ? await store.getItem('missing')
        : await store.checkItemExists('missing')

    expect(result).toBe(query === 'item' ? null : false)
    expect(await redis.zrange('news:items', 0, -1)).toEqual(['live'])
  }
)

test('recent reads retain the candidate limit when missing references occupy slots', async () => {
  const redis = new InMemoryRedis()
  const store = new NewsStore(redis.asRedis())
  await seed(redis, article('old-live', oldDate))
  await seed(redis, article('fresh', freshDate))
  await seed(redis, article('missing', now))
  await redis.del('news:item:missing')

  const result = await store.getRecentItems({ limit: 2 })

  expect(result.map((item) => item.id)).toEqual(['fresh'])
  expect(await redis.zrange('news:items', 0, -1)).toEqual(['old-live', 'fresh'])
})

test('historical queries batch a large expired backlog and do not rescan removed references', async () => {
  const redis = new InMemoryRedis()
  const store = new NewsStore(redis.asRedis())
  for (let index = 0; index < 14000; index++) {
    await redis.zadd('news:items', oldDate.getTime(), `expired-${index}`)
  }
  const retained: NewsItem[] = []
  for (let index = 0; index < 462; index++) {
    const item = article(
      `live-${index}`,
      new Date(freshDate.getTime() + index * 1000)
    )
    retained.push(item)
    await seed(redis, item)
  }
  const reads = vi.spyOn(redis, 'mget')
  const individualReads = vi.spyOn(redis, 'get')

  const result = await store.getItemsSince(oldDate)

  expect(result.map((item) => item.id)).toEqual(retained.map((item) => item.id))
  expect(await redis.zrange('news:items', 0, -1)).toHaveLength(462)
  expect(reads).toHaveBeenCalledTimes(58)
  expect(reads.mock.calls.every((keys) => keys.length <= 250)).toBe(true)
  expect(individualReads).not.toHaveBeenCalled()
})

test('subsequent historical queries only read retained values after expired references are pruned', async () => {
  const redis = new InMemoryRedis()
  const store = new NewsStore(redis.asRedis())
  await seed(redis, article('expired', oldDate))
  await seed(redis, article('fresh', freshDate))
  await redis.del('news:item:expired')
  await store.getItemsSince(oldDate)
  const reads = vi.spyOn(redis, 'mget')

  const result = await store.getItemsSince(oldDate)

  expect(result.map((item) => item.id)).toEqual(['fresh'])
  expect(reads.mock.calls).toEqual([['news:item:fresh']])
})

test.each(['recent', 'item', 'exists'] as const)(
  '%s preserves an article recreated between a missing read and index cleanup',
  async (query) => {
    const redis = new InMemoryRedis()
    const store = new NewsStore(redis.asRedis())
    const restored = article('recreated', now)
    await seed(redis, article('recreated', freshDate))
    await redis.del('news:item:recreated')
    if (query === 'recent') {
      const read = redis.mget.bind(redis)
      vi.spyOn(redis, 'mget').mockImplementationOnce(async (...keys) => {
        const values = await read(...keys)
        await seed(redis, restored)
        return values
      })
    } else {
      const read = redis.get.bind(redis)
      vi.spyOn(redis, 'get').mockImplementationOnce(async (key) => {
        const value = await read(key)
        await seed(redis, restored)
        return value
      })
    }

    if (query === 'recent') await store.getRecentItems({ limit: 1 })
    else if (query === 'item') await store.getItem('recreated')
    else await store.checkItemExists('recreated')

    expect(await redis.zrange('news:items', 0, -1)).toEqual(['recreated'])
    expect(await redis.get('news:item:recreated')).toBe(
      JSON.stringify(restored)
    )
  }
)
