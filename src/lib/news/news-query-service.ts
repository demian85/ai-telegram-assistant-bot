import type { Redis } from 'ioredis'
import type { NewsItem } from './types.js'
import { FeedReader } from './feed-reader.js'
import { NewsStore } from './news-store.js'
import type { ChatNewsFilter } from './chat-news-filter.js'
import logger from '@lib/logger.js'
import { NewsEvaluationBudget } from './evaluation-budget.js'

export type RecentNewsItem = Omit<NewsItem, 'feedUrl'>

export interface NewsQueryServiceConfig {
  readonly redis: Redis
  readonly feeds?: string[]
  readonly filter: ChatNewsFilter
}

export class NewsQueryService {
  private readonly feedReader = new FeedReader()
  private readonly newsStore: NewsStore

  constructor(private readonly config: NewsQueryServiceConfig) {
    this.newsStore = new NewsStore(config.redis)
  }

  async getRecentNewsRaw(limit: number): Promise<RecentNewsItem[]> {
    return this.newsStore.getRecentItems({
      limit: Math.max(1, Math.min(10, limit)),
    })
  }

  async getRecentNewsForChat(
    limit: number,
    chatId: string,
    signal?: AbortSignal
  ): Promise<RecentNewsItem[]> {
    signal?.throwIfAborted()
    const candidates = await this.newsStore.getRecentItems({ limit: 50 })
    return this.selectForChat(candidates, { limit, chatId, signal })
  }

  async getRecentNewsLast24HoursForChat(
    limit: number,
    chatId: string,
    signal?: AbortSignal
  ): Promise<RecentNewsItem[]> {
    signal?.throwIfAborted()
    const candidates = await this.newsStore.getItemsSince(
      new Date(Date.now() - 24 * 60 * 60 * 1000)
    )
    return this.selectForChat(candidates.reverse().slice(0, 50), {
      limit,
      chatId,
      signal,
    })
  }

  async fetchAndGetRecentNewsForChat(
    limit: number,
    chatId: string,
    signal?: AbortSignal
  ): Promise<RecentNewsItem[]> {
    signal?.throwIfAborted()
    if (this.config.feeds?.length) {
      try {
        const items = await this.feedReader.fetchAllFeeds(
          this.config.feeds,
          signal
        )
        for (const item of items.slice(0, 20)) {
          signal?.throwIfAborted()
          await this.newsStore.storeItem(item)
        }
      } catch (error) {
        signal?.throwIfAborted()
        logger.warn(
          {
            event: 'news.fetch_ondemand_error',
            err: error instanceof Error ? error : new Error(String(error)),
          },
          'Failed to fetch fresh news; filtering cached articles'
        )
      }
    }
    return this.getRecentNewsForChat(limit, chatId, signal)
  }

  private async selectForChat(
    items: NewsItem[],
    request: {
      readonly limit: number
      readonly chatId: string
      readonly signal?: AbortSignal
    }
  ): Promise<RecentNewsItem[]> {
    const { signal } = request
    signal?.throwIfAborted()
    const { filter } = this.config
    const preference = await filter.preferences.resolve(request.chatId)
    const context = {
      chatId: request.chatId,
      filter: preference,
      budget: new NewsEvaluationBudget(50),
      signal,
    }
    const selected: RecentNewsItem[] = []
    const limit = Math.max(1, Math.min(10, request.limit))
    for (const item of items) {
      signal?.throwIfAborted()
      const result = await filter.evaluate(context, item)
      signal?.throwIfAborted()
      if (result?.isRelevant) {
        selected.push({ ...item, relevanceScore: Math.round(result.score) })
        if (selected.length >= limit) break
      }
    }
    const current = await filter.preferences.resolve(request.chatId)
    signal?.throwIfAborted()
    return current.revision === preference.revision ? selected : []
  }
}
