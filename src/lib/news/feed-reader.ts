import { extract } from '@extractus/feed-extractor'
import logger from '@lib/logger.js'
import type { NewsItem } from './types.js'

export interface FeedEntry {
  title?: string
  description?: string
  link?: string
  published?: string
  content?: string
}

export class FeedReader {
  private readonly seenUrls: Set<string> = new Set()

  async fetchFeed(url: string, signal?: AbortSignal): Promise<NewsItem[]> {
    signal?.throwIfAborted()
    logger.trace(
      { event: 'news.feed.fetch.start', feedUrl: url },
      'Starting feed fetch'
    )
    const startTime = Date.now()

    try {
      const feed = await extract(url, {}, { signal })
      signal?.throwIfAborted()
      const items: NewsItem[] = []
      const now = new Date()
      const entries = feed?.entries ?? []

      for (const entry of entries) {
        const feedEntry = entry as unknown as FeedEntry
        const link = feedEntry.link || ''

        if (this.seenUrls.has(link)) {
          continue
        }

        const item: NewsItem = {
          id: link,
          source: feed.title || link,
          feedUrl: link,
          title: feedEntry.title || 'Untitled',
          description: feedEntry.description,
          content: undefined,
          url: link,
          publishedAt: feedEntry.published
            ? new Date(feedEntry.published)
            : now,
          fetchedAt: now,
        }

        items.push(item)
        this.seenUrls.add(link)
      }

      const duration = Date.now() - startTime
      logger.debug(
        {
          event: 'news.feed.fetch.success',
          feedUrl: url,
          itemCount: items.length,
          durationMs: duration,
        },
        'Fetched news feed'
      )
      logger.trace(
        {
          event: 'news.feed.fetch.complete',
          feedUrl: url,
          durationMs: duration,
          itemCount: items.length,
        },
        'Feed fetch completed'
      )

      return items
    } catch (error) {
      signal?.throwIfAborted()
      logger.error(
        {
          event: 'news.feed.fetch.error',
          feedUrl: url,
          itemCount: 0,
          error: error instanceof Error ? error.message : String(error),
          err: error,
        },
        'Failed to fetch news feed'
      )

      return []
    }
  }

  async fetchAllFeeds(
    urls: string[],
    signal?: AbortSignal
  ): Promise<NewsItem[]> {
    signal?.throwIfAborted()
    const results = await Promise.all(
      urls.map((url) => this.fetchFeed(url, signal))
    )
    const items = results
      .flat()
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())

    logger.debug(
      {
        event: 'news.feed.fetch.aggregate',
        feedCount: urls.length,
        itemCount: items.length,
      },
      'Fetched all news feeds'
    )

    return items
  }

  markSeen(url: string): void {
    this.seenUrls.add(url)
  }

  isSeen(url: string): boolean {
    return this.seenUrls.has(url)
  }
}
