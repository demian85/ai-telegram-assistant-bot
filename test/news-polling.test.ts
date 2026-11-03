import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, test } from 'vitest'
import { FeedReader } from '../src/lib/news/feed-reader.js'
import { NewsScheduler } from '../src/lib/news/scheduler.js'
import { NewsStore } from '../src/lib/news/news-store.js'
import { NewsQueryService } from '../src/lib/news/news-query-service.js'
import { filterHarness } from './news-filter-helpers.js'
import { createNoopQueue, createNoopWorker } from './test-helpers.js'

test.each(['scheduler', 'query'] as const)(
  '%s retains overflow articles across polls and restarts',
  async (path) => {
    const harness = filterHarness()
    const store = new NewsStore(harness.redis.asRedis())
    const urls = Array.from(
      { length: 23 },
      (_, index) => `https://example.test/article-${index}`
    )
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(`<rss version="2.0"><channel><title>News</title>
        <link>https://example.test</link><description>Updates</description>
        ${urls.map((url) => `<item><title>AI release</title><link>${url}</link></item>`).join('')}
        </channel></rss>`)
    })
    server.listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new TypeError('Expected HTTP server address')
      const feedUrl = `http://127.0.0.1:${address.port}/rss`
      const createPoller = () => {
        if (path === 'query') {
          const query = new NewsQueryService({
            redis: harness.redis.asRedis(),
            feeds: [feedUrl],
            filter: harness.filter,
          })
          return () => query.fetchAndGetRecentNewsForChat(1, 'a')
        }
        const scheduler = new NewsScheduler(
          {
            redis: harness.redis.asRedis(),
            model: harness.model,
            newsConfig: {
              feeds: [feedUrl],
              pollIntervalMinutes: 5,
              deliveryCheckIntervalSeconds: 60,
              maxArticlesPerPoll: 10,
              relevanceThreshold: 70,
              defaultFilter: 'AI',
            },
          },
          {
            feedReader: new FeedReader(),
            queue: createNoopQueue(),
            worker: createNoopWorker(),
          }
        )
        return () => scheduler['pollFeeds']()
      }
      const poll = createPoller()
      await poll()
      expect(await store.getRecentItems({ limit: 50 })).toHaveLength(
        path === 'scheduler' ? 10 : 20
      )
      await poll()
      expect(await store.getRecentItems({ limit: 50 })).toHaveLength(
        path === 'scheduler' ? 20 : 23
      )
      await createPoller()()
      expect(
        (await store.getRecentItems({ limit: 50 }))
          .map((item) => item.url)
          .sort()
      ).toEqual([...urls].sort())
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
)
