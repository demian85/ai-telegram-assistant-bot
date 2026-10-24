import { afterEach, expect, test, vi } from 'vitest'
import { VeniceDecisionModel } from '../src/lib/llm/decision-model.js'
import { RelevanceDetector } from '../src/lib/news/relevance-detector.js'
import { ChatNewsFilter } from '../src/lib/news/chat-news-filter.js'
import { NewsQueryService } from '../src/lib/news/news-query-service.js'
import { NewsStore } from '../src/lib/news/news-store.js'
import { NewsPreferenceStore } from '../src/lib/news/preferences.js'
import { createRecentNewsTool } from '../src/lib/agent/tools.js'
import { InMemoryRedis } from './test-helpers.js'
import {
  acceptedDecision,
  article,
  decisionResponse,
} from './news-filter-helpers.js'

afterEach(() => vi.restoreAllMocks())

test.each(['decision', 'feed'] as const)(
  'closes the real %s HTTP request when the tool deadline expires',
  async (kind) => {
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const paths: string[] = []
    const server = createServer((req, res) => {
      req.resume()
      paths.push(req.url ?? '')
      res.once('close', () => closed.resolve())
      started.resolve()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new TypeError('Expected HTTP server address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      const h = harness(async (_url, init) =>
        globalThis.fetch(`${baseUrl}/decisions`, init)
      )
      for (let i = 0; i < 3; i++)
        await h.store.storeItem(article(`article-${i}`))
      const query =
        kind === 'feed'
          ? new NewsQueryService({
              redis: h.redis.asRedis(),
              filter: h.filter,
              feeds: [`${baseUrl}/feed`],
            })
          : h.query
      const tool = createRecentNewsTool(query)
      const invocation = tool
        .invoke(
          { count: 3 },
          { signal: controller.signal, configurable: { newsChatId: '1' } }
        )
        .catch((error: unknown) => error)
      await started.promise

      controller.abort(new DOMException('Turn expired', 'TimeoutError'))
      await expect(invocation).resolves.toMatchObject({ name: 'TimeoutError' })
      await closed.promise

      expect(paths).toEqual([kind === 'feed' ? '/feed' : '/decisions'])
    } finally {
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
)

function harness(
  fetch: NonNullable<
    ConstructorParameters<typeof VeniceDecisionModel>[0]['fetch']
  >
) {
  const redis = new InMemoryRedis()
  const preferences = new NewsPreferenceStore(redis.asRedis(), 'AI')
  const detector = new RelevanceDetector(
    new VeniceDecisionModel({ apiKey: 'offline', maxRetries: 0, fetch }),
    { relevanceThreshold: 80 }
  )
  const filter = new ChatNewsFilter(redis.asRedis(), preferences, detector)
  const query = new NewsQueryService({ redis: redis.asRedis(), filter })
  return {
    redis,
    preferences,
    filter,
    query,
    tool: createRecentNewsTool(query),
    store: new NewsStore(redis.asRedis()),
  }
}

test('cancels the news tool decision HTTP request and stops scanning the remaining articles', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let requestSignal: AbortSignal | null | undefined
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requestSignal = init?.signal
    started.resolve()
    await release.promise
    requestSignal?.throwIfAborted()
    return Response.json(
      decisionResponse({ ...acceptedDecision, eligible: false })
    )
  })
  const h = harness(fetch)
  const writes = vi.spyOn(h.redis, 'setex')
  for (let i = 0; i < 3; i++) await h.store.storeItem(article(`article-${i}`))
  const invocation = h.tool
    .invoke(
      { count: 3 },
      { signal: controller.signal, configurable: { newsChatId: '1' } }
    )
    .catch((error: unknown) => error)

  await started.promise
  controller.abort(new DOMException('Turn expired', 'TimeoutError'))
  release.resolve()

  expect(await invocation).toMatchObject({ name: 'TimeoutError' })
  await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true))
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(
    writes.mock.calls.filter(([key]) => key.startsWith('news:chat-decision:'))
  ).toEqual([])
  fetch.mockImplementation(async () =>
    Response.json(decisionResponse(acceptedDecision))
  )
  await expect(
    h.tool.invoke({ count: 1 }, { configurable: { newsChatId: '1' } })
  ).resolves.toContain('latest 1 relevant news')
  expect(fetch).toHaveBeenCalledTimes(2)
})

test.each(['leader', 'follower'] as const)(
  'canceling the %s leaves a shared scheduler decision running',
  async (position) => {
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let requestSignal: AbortSignal | null | undefined
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal
      started.resolve()
      await release.promise
      requestSignal?.throwIfAborted()
      return Response.json(decisionResponse(acceptedDecision))
    })
    const h = harness(fetch)
    const context = { chatId: '1', filter: await h.preferences.resolve('1') }
    const item = article()
    const cancelable = () =>
      h.filter
        .evaluate({ ...context, signal: controller.signal }, item)
        .catch((error: unknown) => error)
    const scheduled = () => h.filter.evaluate(context, item)
    const first = position === 'leader' ? cancelable() : scheduled()
    await started.promise
    const second = position === 'leader' ? scheduled() : cancelable()

    controller.abort(new DOMException('Turn expired', 'TimeoutError'))
    const canceled = position === 'leader' ? first : second
    const scheduler = position === 'leader' ? second : first
    await expect(canceled).resolves.toMatchObject({ name: 'TimeoutError' })
    expect(requestSignal?.aborted).toBe(false)
    release.resolve()

    await expect(scheduler).resolves.toMatchObject({ isRelevant: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  }
)

test('drops a canceled queued decision before HTTP and lets a later retry proceed', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fetch = vi.fn(async () => {
    started.resolve()
    await release.promise
    return Response.json(decisionResponse(acceptedDecision))
  })
  const h = harness(fetch)
  const context = { chatId: '1', filter: await h.preferences.resolve('1') }
  const active = h.filter.evaluate(context, article('active'))
  await started.promise
  await h.store.storeItem(article('queued'))
  const evaluate = vi.spyOn(h.filter, 'evaluate')
  const queued = h.query
    .getRecentNewsForChat(1, '1', controller.signal)
    .catch((error: unknown) => error)
  await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce())

  controller.abort(new DOMException('Turn expired', 'TimeoutError'))
  await expect(queued).resolves.toMatchObject({ name: 'TimeoutError' })
  release.resolve()
  await active
  const retried = await h.query.getRecentNewsForChat(1, '1')

  expect(retried.map((item) => item.id)).toEqual(['queued'])
  expect(fetch).toHaveBeenCalledTimes(2)
})

test.each([
  'getRecentNewsForChat',
  'getRecentNewsLast24HoursForChat',
  'fetchAndGetRecentNewsForChat',
] as const)(
  '%s rejects an expired query before starting downstream work',
  async (method) => {
    const fetch = vi.fn(async () =>
      Response.json(decisionResponse(acceptedDecision))
    )
    const h = harness(fetch)
    await h.store.storeItem(article())
    const signal = AbortSignal.abort(
      new DOMException('Turn expired', 'TimeoutError')
    )

    await expect(h.query[method](1, '1', signal)).rejects.toMatchObject({
      name: 'TimeoutError',
    })

    expect(fetch).not.toHaveBeenCalled()
  }
)
import { createServer } from 'node:http'
import { once } from 'node:events'
