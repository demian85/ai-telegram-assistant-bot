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
    chatId: string
  ): Promise<RecentNewsItem[]> {
    const candidates = await this.newsStore.getRecentItems({ limit: 50 })
    return this.selectForChat(candidates, { limit, chatId })
  }

  async getRecentNewsLast24HoursForChat(
    limit: number,
    chatId: string
  ): Promise<RecentNewsItem[]> {
    const candidates = await this.newsStore.getItemsSince(
      new Date(Date.now() - 24 * 60 * 60 * 1000)
    )
    return this.selectForChat(candidates.reverse().slice(0, 50), {
      limit,
      chatId,
    })
  }

  async fetchAndGetRecentNewsForChat(
    limit: number,
    chatId: string
  ): Promise<RecentNewsItem[]> {
    if (this.config.feeds?.length) {
      try {
        const items = await this.feedReader.fetchAllFeeds(this.config.feeds)
        for (const item of items.slice(0, 20)) {
          await this.newsStore.storeItem(item)
        }
      } catch (error) {
        logger.warn(
          {
            event: 'news.fetch_ondemand_error',
            err: error instanceof Error ? error : new Error(String(error)),
          },
          'Failed to fetch fresh news; filtering cached articles'
        )
      }
    }
    return this.getRecentNewsForChat(limit, chatId)
  }

  private async selectForChat(
    items: NewsItem[],
    request: { readonly limit: number; readonly chatId: string }
  ): Promise<RecentNewsItem[]> {
    const { filter } = this.config
    const preference = await filter.preferences.resolve(request.chatId)
    const context = {
      chatId: request.chatId,
      filter: preference,
      budget: new NewsEvaluationBudget(50),
    }
    const selected: RecentNewsItem[] = []
    const limit = Math.max(1, Math.min(10, request.limit))
    for (const item of items) {
      const result = await filter.evaluate(context, item)
      if (result?.isRelevant) {
        selected.push({ ...item, relevanceScore: Math.round(result.score) })
        if (selected.length >= limit) break
      }
    }
    const current = await filter.preferences.resolve(request.chatId)
    return current.revision === preference.revision ? selected : []
  }
}
