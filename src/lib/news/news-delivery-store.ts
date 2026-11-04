import type { Redis } from 'ioredis'
import type { NewsDeliveryRecord, NewsItem } from './types.js'
import { NewsStore } from './news-store.js'

export class NewsDeliveryStore {
  private readonly keyPrefix = 'news:chat-delivery:'
  private readonly indexPrefix = 'news:chat-deliveries:'
  private readonly ttlSeconds = 30 * 24 * 60 * 60

  constructor(private readonly redis: Redis) {}

  async getDelivery(
    chatId: string,
    itemId: string
  ): Promise<NewsDeliveryRecord | null> {
    const data = await this.redis.get(this.getKey(chatId, itemId))

    if (!data) {
      return null
    }

    return this.parseDelivery(data)
  }

  async hasDelivered(chatId: string, itemId: string): Promise<boolean> {
    const delivery = await this.getDelivery(chatId, itemId)
    return delivery !== null
  }

  async markDelivered(
    chatId: string,
    itemId: string,
    sentAt: Date = new Date()
  ): Promise<NewsDeliveryRecord> {
    const delivery: NewsDeliveryRecord = {
      chatId,
      itemId,
      sentAt,
    }

    const key = this.getKey(chatId, itemId)

    await this.redis.setex(key, this.ttlSeconds, JSON.stringify(delivery))
    await this.redis.zadd(this.getIndexKey(chatId), sentAt.getTime(), itemId)

    return delivery
  }

  async unmarkDelivered(chatId: string, itemId: string): Promise<void> {
    await this.redis.del(this.getKey(chatId, itemId))
    await this.redis.zrem(this.getIndexKey(chatId), itemId)
  }

  async getDeliveredItemIds(chatId: string): Promise<string[]> {
    return this.redis.zrange(this.getIndexKey(chatId), 0, -1)
  }

  async getRecentArticles(chatId: string, since: Date): Promise<NewsItem[]> {
    const ids = await this.redis.zrangebyscore(
      this.getIndexKey(chatId),
      since.getTime(),
      '+inf'
    )
    const store = new NewsStore(this.redis)
    const articles = await Promise.all(
      ids.slice(-100).map(async (id) => {
        if (!(await this.hasDelivered(chatId, id))) return null
        return store.getItem(id)
      })
    )
    return articles.filter((article) => article !== null)
  }

  private parseDelivery(data: string): NewsDeliveryRecord {
    const delivery = JSON.parse(data) as Omit<NewsDeliveryRecord, 'sentAt'> & {
      sentAt: string
    }

    return {
      ...delivery,
      sentAt: new Date(delivery.sentAt),
    }
  }

  private getKey(chatId: string, itemId: string): string {
    return `${this.keyPrefix}${chatId}:${itemId}`
  }

  private getIndexKey(chatId: string): string {
    return `${this.indexPrefix}${chatId}`
  }
}
