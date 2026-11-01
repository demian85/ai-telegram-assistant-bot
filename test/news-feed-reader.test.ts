import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { extractFromXml } from '@extractus/feed-extractor'
import { expect, test } from 'vitest'
import { FeedReader } from '../src/lib/news/feed-reader.js'
import { captureLoggerRecords } from './test-helpers.js'

function rss(description: string, doctype = ''): string {
  return `<?xml version="1.0"?>${doctype}
    <rss version="2.0"><channel>
      <title>Kubernetes &amp; Cloud</title>
      <link>https://example.com/</link>
      <description>News</description>
      <item>
        <title>Clusters &amp; workloads</title>
        <link>https://example.com/article</link>
        <pubDate>Tue, 06 Oct 2026 12:00:00 GMT</pubDate>
        <description>${description}</description>
      </item>
    </channel></rss>`
}

function atom(content: string): string {
  return `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Kubernetes &amp; Cloud</title>
      <id>https://example.com/</id>
      <updated>2026-10-06T12:00:00Z</updated>
      <entry>
        <title>Clusters &amp; workloads</title>
        <link href="https://example.com/article"/>
        <id>https://example.com/article</id>
        <updated>2026-10-06T12:00:00Z</updated>
        <content type="html">${content}</content>
      </entry>
    </feed>`
}

async function withFeed(
  xml: string,
  run: (url: string, requests: IncomingMessage[]) => Promise<void>
): Promise<void> {
  const requests: IncomingMessage[] = []
  const server = createServer((req, res) => {
    requests.push(req)
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
    res.end(xml)
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new TypeError('Expected HTTP server address')
    await run(`http://127.0.0.1:${address.port}/feed.xml`, requests)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test.each([
  ['RSS', rss],
  ['Atom', atom],
] as const)(
  'reads %s feeds with more than 1,000 ordinary XML escapes',
  async (_kind, buildFeed) => {
    const xml = buildFeed(
      '&lt;p&gt;Kubernetes &amp; cloud updates&lt;/p&gt;'.repeat(500)
    )
    expect(() => extractFromXml(xml)).toThrow('Entity expansion limit exceeded')

    await withFeed(xml, async (url, requests) => {
      const reader = new FeedReader()
      const items = await reader.fetchFeed(url)

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        id: 'https://example.com/article',
        source: 'Kubernetes & Cloud',
        title: 'Clusters & workloads',
        url: 'https://example.com/article',
        publishedAt: new Date('2026-10-06T12:00:00Z'),
      })
      expect(items[0].description).toContain('Kubernetes & cloud updates')
      expect(items[0].description).not.toMatch(/&(?:lt|gt|amp);|<\/?p>/)
      expect(requests[0].headers['user-agent']).toBe('Lynx/2.9.2')
      expect(reader.isSeen('https://example.com/article')).toBe(true)
      await expect(reader.fetchFeed(url)).resolves.toEqual([])
    })
  }
)

test.each([
  {
    name: 'total expansion count',
    xml: rss('&lt;'.repeat(100_001)),
    error: 'Entity expansion limit exceeded',
  },
  {
    name: 'individual entity size',
    xml: rss(
      '&large;',
      `<!DOCTYPE rss [<!ENTITY large "${'x'.repeat(10_001)}">]>`
    ),
    error: 'exceeds maximum allowed size (10000)',
  },
  {
    name: 'total expanded content size',
    xml: rss(
      '&large;'.repeat(11),
      `<!DOCTYPE rss [<!ENTITY large "${'x'.repeat(10_000)}">]>`
    ),
    error: 'Total expanded content size exceeded',
  },
  {
    name: 'entity declaration count',
    xml: rss(
      'News',
      `<!DOCTYPE rss [${Array.from(
        { length: 101 },
        (_, i) => `<!ENTITY entity${i} "value">`
      ).join('')}]>`
    ),
    error: 'Entity count (101) exceeds maximum allowed (100)',
  },
])('retains the $name safeguard', async ({ xml, error }) => {
  await withFeed(xml, async (url) => {
    const reader = new FeedReader()
    const { result, records } = await captureLoggerRecords(() =>
      reader.fetchFeed(url)
    )

    expect(result).toEqual([])
    expect(reader.isSeen('https://example.com/article')).toBe(false)
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'error',
        context: expect.objectContaining({
          event: 'news.feed.fetch.error',
          feedUrl: url,
          error: expect.stringContaining(error),
        }),
      })
    )
  })
})
