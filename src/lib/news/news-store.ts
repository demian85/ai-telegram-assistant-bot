import type { Redis } from 'ioredis'
import logger from '@lib/logger.js'
import type { NewsItem } from './types.js'

const itemRetentionSeconds = 7 * 24 * 60 * 60
const itemReadBatchSize = 250
const removeMissingReferencesScript = `
local removed = 0
for index = 1, #ARGV do
  if redis.call('EXISTS', KEYS[index + 1]) == 0 then
    removed = removed + redis.call('ZREM', KEYS[1], ARGV[index])
  end
end
return removed
`

export class NewsStore {
  private readonly redis: Redis
  private readonly keyPrefix = 'news:'

  constructor(redis: Redis) {
    this.redis = redis
  }

  async storeItem(item: NewsItem): Promise<boolean> {
    await this.pruneExpiredReferences()
    const key = `${this.keyPrefix}item:${item.id}`

    const existingItem = await this.redis.get(key)
    const existedBefore = existingItem !== null

    if (existedBefore) {
      logger.debug(
        {
          event: 'news.item.duplicate_skip',
          itemId: item.id,
          itemUrl: item.url,
        },
        'Skipped duplicate news item storage'
      )

      return false
    }

    await this.writeItem(key, item)

    logger.debug(
      {
        event: 'news.item.store',
        itemId: item.id,
        itemUrl: item.url,
      },
      'Stored news item'
    )

    return true
  }

  async checkItemExists(itemId: string): Promise<boolean> {
    const key = `${this.keyPrefix}item:${itemId}`
    const existing = await this.redis.get(key)
    if (existing === null) {
      await this.removeMissingReferences([itemId])
    }
    return existing !== null
  }

  private async writeItem(key: string, item: NewsItem): Promise<void> {
    await this.redis.setex(key, itemRetentionSeconds, JSON.stringify(item))
    await this.redis.zadd(
      `${this.keyPrefix}items`,
      item.fetchedAt.getTime(),
      item.id
    )
  }

  async getItem(id: string): Promise<NewsItem | null> {
    const key = `${this.keyPrefix}item:${id}`
    const data = await this.redis.get(key)
    if (!data) {
      await this.removeMissingReferences([id])
      return null
    }
    return this.parseItem(data)
  }

  async getUnscoredItems(limit: number = 100): Promise<NewsItem[]> {
    await this.pruneExpiredReferences()
    const ids = await this.redis.zrevrange(
      `${this.keyPrefix}items`,
      0,
      limit - 1
    )
    const items = await this.readItems(ids)
    return items.filter((item) => item.relevanceScore === undefined)
  }

  async getUnforwardedRelevantItems(threshold: number): Promise<NewsItem[]> {
    await this.pruneExpiredReferences()
    const ids = await this.redis.zrevrange(`${this.keyPrefix}items`, 0, -1)
    const items = await this.readItems(ids)
    return items
      .filter(
        (item) =>
          !item.legacyBroadcastedAt && this.passesThreshold(item, threshold)
      )
      .reverse()
  }

  async getRelevantItems(threshold: number): Promise<NewsItem[]> {
    await this.pruneExpiredReferences()
    const ids = await this.redis.zrange(`${this.keyPrefix}items`, 0, -1)
    const items = await this.readItems(ids)
    return items.filter((item) => this.passesThreshold(item, threshold))
  }

  async updateRelevance(
    id: string,
    score: number,
    isRelevant: boolean
  ): Promise<void> {
    const item = await this.getItem(id)
    if (item) {
      item.relevanceScore = score
      item.isRelevant = isRelevant
      await this.writeItem(`${this.keyPrefix}item:${item.id}`, item)
    }
  }

  async markForwarded(id: string): Promise<void> {
    const item = await this.getItem(id)
    if (item) {
      item.legacyBroadcastedAt = new Date()
      await this.writeItem(`${this.keyPrefix}item:${item.id}`, item)
    }
  }

  private parseItem(data: string): NewsItem {
    const item = JSON.parse(data) as Omit<
      NewsItem,
      'publishedAt' | 'fetchedAt' | 'legacyBroadcastedAt'
    > & {
      publishedAt: string
      fetchedAt: string
      legacyBroadcastedAt?: string
    }

    return {
      ...item,
      publishedAt: new Date(item.publishedAt),
      fetchedAt: new Date(item.fetchedAt),
      legacyBroadcastedAt: item.legacyBroadcastedAt
        ? new Date(item.legacyBroadcastedAt)
        : undefined,
    }
  }

  async getRecentItems(options: {
    limit: number
    minRelevanceScore?: number
  }): Promise<NewsItem[]> {
    await this.pruneExpiredReferences()
    const { limit, minRelevanceScore } = options
    const ids = await this.redis.zrevrange(
      `${this.keyPrefix}items`,
      0,
      limit - 1
    )

    const items = await this.readItems(ids)
    return items.filter(
      (item) =>
        minRelevanceScore === undefined ||
        (item.relevanceScore !== undefined &&
          item.relevanceScore >= minRelevanceScore)
    )
  }

  async getItemsSince(since: Date): Promise<NewsItem[]> {
    await this.pruneExpiredReferences()
    const ids = await this.redis.zrangebyscore(
      `${this.keyPrefix}items`,
      since.getTime(),
      '+inf'
    )

    return this.readItems(ids)
  }

  private async pruneExpiredReferences(): Promise<void> {
    const ids = await this.redis.zrangebyscore(
      `${this.keyPrefix}items`,
      '-inf',
      Date.now() - itemRetentionSeconds * 1000
    )
    await this.readItems(ids)
  }

  private async readItems(ids: readonly string[]): Promise<NewsItem[]> {
    const items: NewsItem[] = []
    for (let offset = 0; offset < ids.length; offset += itemReadBatchSize) {
      const batch = ids.slice(offset, offset + itemReadBatchSize)
      const values = await this.redis.mget(
        ...batch.map((id) => `${this.keyPrefix}item:${id}`)
      )
      const missing: string[] = []
      batch.forEach((id, index) => {
        const value = values[index]
        if (value) items.push(this.parseItem(value))
        else missing.push(id)
      })
      if (missing.length) {
        await this.removeMissingReferences(missing)
      }
    }
    return items
  }

  private async removeMissingReferences(ids: readonly string[]): Promise<void> {
    await this.redis.eval(
      removeMissingReferencesScript,
      ids.length + 1,
      `${this.keyPrefix}items`,
      ...ids.map((id) => `${this.keyPrefix}item:${id}`),
      ...ids
    )
  }

  private passesThreshold(item: NewsItem, threshold: number): boolean {
    return item.relevanceScore !== undefined && item.relevanceScore >= threshold
  }
}
