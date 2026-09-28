import { test, expect, describe } from 'vitest'
import { SummaryStore } from '../src/lib/memory/summary-store.js'
import { InMemoryRedis } from './test-helpers.js'
import type { MemorySummary } from '../src/lib/memory/types.js'

describe('SummaryStore', () => {
  function createStore() {
    const redis = new InMemoryRedis()
    return { store: new SummaryStore(redis.asRedis()), redis }
  }

  function createSummary(
    overrides: Partial<MemorySummary> & {
      chatId: string
      level: MemorySummary['level']
    }
  ): MemorySummary {
    return {
      startTime: 1000,
      endTime: 2000,
      summary: 'Test summary content',
      messageCount: 10,
      keyTopics: ['topic1', 'topic2'],
      createdAt: 3000,
      ...overrides,
    }
  }

  test('saves and retrieves summaries', async () => {
    const { store } = createStore()

    const summary = createSummary({
      chatId: 'chat-1',
      level: 'daily',
      summary: 'Daily summary for chat 1',
    })

    await store.saveSummary(summary)

    const summaries = await store.getSummaries('chat-1', 'daily')

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual(summary)
  })

  test('retrieves summaries in reverse chronological order', async () => {
    const { store } = createStore()

    const summary1 = createSummary({
      chatId: 'chat-1',
      level: 'daily',
      endTime: 1000,
      summary: 'Older summary',
    })
    const summary2 = createSummary({
      chatId: 'chat-1',
      level: 'daily',
      endTime: 2000,
      summary: 'Newer summary',
    })
    const summary3 = createSummary({
      chatId: 'chat-1',
      level: 'daily',
      endTime: 1500,
      summary: 'Middle summary',
    })

    await store.saveSummary(summary1)
    await store.saveSummary(summary2)
    await store.saveSummary(summary3)

    const summaries = await store.getSummaries('chat-1', 'daily')
    const summaryTexts = summaries.map((s) => s.summary)

    expect(summaryTexts).toEqual([
      'Older summary',
      'Middle summary',
      'Newer summary',
    ])
  })

  test('limits number of returned summaries', async () => {
    const { store } = createStore()

    for (let i = 1; i <= 5; i++) {
      await store.saveSummary(
        createSummary({
          chatId: 'chat-1',
          level: 'daily',
          endTime: i * 1000,
          summary: `Summary ${i}`,
        })
      )
    }

    const summaries = await store.getSummaries('chat-1', 'daily', 3)
    const summaryTexts = summaries.map((s) => s.summary)

    expect(summaries).toHaveLength(3)
    expect(summaryTexts).toEqual(['Summary 3', 'Summary 4', 'Summary 5'])
  })

  test('isolates summaries by chat ID', async () => {
    const { store } = createStore()

    await store.saveSummary(
      createSummary({
        chatId: 'chat-a',
        level: 'daily',
        summary: 'Summary for A',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-b',
        level: 'daily',
        summary: 'Summary for B',
      })
    )

    const summariesA = await store.getSummaries('chat-a', 'daily')
    const summariesB = await store.getSummaries('chat-b', 'daily')

    expect(summariesA).toHaveLength(1)
    expect(summariesA[0]?.summary).toBe('Summary for A')
    expect(summariesB).toHaveLength(1)
    expect(summariesB[0]?.summary).toBe('Summary for B')
  })

  test('isolates summaries by level', async () => {
    const { store } = createStore()

    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        summary: 'Daily summary',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'weekly',
        summary: 'Weekly summary',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'monthly',
        summary: 'Monthly summary',
      })
    )

    const daily = await store.getSummaries('chat-1', 'daily')
    const weekly = await store.getSummaries('chat-1', 'weekly')
    const monthly = await store.getSummaries('chat-1', 'monthly')

    expect(daily[0]?.summary).toBe('Daily summary')
    expect(weekly[0]?.summary).toBe('Weekly summary')
    expect(monthly[0]?.summary).toBe('Monthly summary')
  })

  test('returns empty array for unknown chat', async () => {
    const { store } = createStore()

    const summaries = await store.getSummaries('unknown-chat', 'daily')

    expect(summaries).toEqual([])
  })

  test('getSummariesInRange returns summaries within time range', async () => {
    const { store } = createStore()

    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        startTime: 500,
        endTime: 1000,
        summary: 'Too early',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        startTime: 1000,
        endTime: 2000,
        summary: 'In range',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        startTime: 2000,
        endTime: 3000,
        summary: 'Also in range',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        startTime: 3000,
        endTime: 4000,
        summary: 'Too late',
      })
    )

    const summaries = await store.getSummariesInRange(
      'chat-1',
      'daily',
      1000,
      3000
    )

    expect(summaries).toHaveLength(3)
    expect(summaries.map((s) => s.summary)).toContain('In range')
    expect(summaries.map((s) => s.summary)).toContain('Also in range')
  })

  test('getLastSummary returns most recent summary', async () => {
    const { store } = createStore()

    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        endTime: 1000,
        summary: 'Older',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        endTime: 3000,
        summary: 'Newest',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        endTime: 2000,
        summary: 'Middle',
      })
    )

    const lastSummary = await store.getLastSummary('chat-1', 'daily')

    expect(lastSummary?.summary).toBe('Newest')
  })

  test('getLastSummary returns null when no summaries exist', async () => {
    const { store } = createStore()

    const lastSummary = await store.getLastSummary('chat-1', 'daily')

    expect(lastSummary).toBeNull()
  })

  test('shouldGenerateSummary returns true when no previous summary', async () => {
    const { store } = createStore()

    const shouldGenerate = await store.shouldGenerateSummary(
      'chat-1',
      'daily',
      86400000 // 24 hours
    )

    expect(shouldGenerate).toBe(true)
  })

  test('shouldGenerateSummary returns true when interval has passed', async () => {
    const { store } = createStore()

    const now = Date.now()
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        endTime: now - 90000, // 90 seconds ago
        summary: 'Old summary',
      })
    )

    const shouldGenerate = await store.shouldGenerateSummary(
      'chat-1',
      'daily',
      60000 // 60 seconds interval
    )

    expect(shouldGenerate).toBe(true)
  })

  test('shouldGenerateSummary returns false when interval has not passed', async () => {
    const { store } = createStore()

    const now = Date.now()
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        endTime: now - 30000, // 30 seconds ago
        summary: 'Recent summary',
      })
    )

    const shouldGenerate = await store.shouldGenerateSummary(
      'chat-1',
      'daily',
      60000 // 60 seconds interval
    )

    expect(shouldGenerate).toBe(false)
  })

  test('clearSummaries removes all summaries for chat', async () => {
    const { store } = createStore()

    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        summary: 'Daily',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'weekly',
        summary: 'Weekly',
      })
    )

    await store.clearSummaries('chat-1')

    expect(await store.getSummaries('chat-1', 'daily')).toEqual([])
    expect(await store.getSummaries('chat-1', 'weekly')).toEqual([])
  })

  test('clearSummaries only affects target chat', async () => {
    const { store } = createStore()

    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        summary: 'Chat 1 summary',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-2',
        level: 'daily',
        summary: 'Chat 2 summary',
      })
    )

    await store.clearSummaries('chat-1')

    expect(await store.getSummaries('chat-1', 'daily')).toEqual([])
    const chat2Summaries = await store.getSummaries('chat-2', 'daily')
    expect(chat2Summaries).toHaveLength(1)
    expect(chat2Summaries[0]?.summary).toBe('Chat 2 summary')
  })

  test('clearSummaries with specific levels only clears those levels', async () => {
    const { store } = createStore()

    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        summary: 'Daily',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'weekly',
        summary: 'Weekly',
      })
    )
    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'monthly',
        summary: 'Monthly',
      })
    )

    await store.clearSummaries('chat-1', ['daily', 'weekly'])

    expect(await store.getSummaries('chat-1', 'daily')).toEqual([])
    expect(await store.getSummaries('chat-1', 'weekly')).toEqual([])
    const monthlySummaries = await store.getSummaries('chat-1', 'monthly')
    expect(monthlySummaries).toHaveLength(1)
  })

  test('clearSummaries with empty array does nothing', async () => {
    const { store } = createStore()

    await store.saveSummary(
      createSummary({
        chatId: 'chat-1',
        level: 'daily',
        summary: 'Daily',
      })
    )

    await store.clearSummaries('chat-1', [])

    const summaries = await store.getSummaries('chat-1', 'daily')
    expect(summaries).toHaveLength(1)
  })

  test('getMessageCountSince counts messages after timestamp', async () => {
    const { store, redis } = createStore()

    const messages = [
      { role: 'user', content: 'Old message', timestamp: 500 },
      { role: 'user', content: 'Recent 1', timestamp: 1500 },
      { role: 'assistant', content: 'Recent 2', timestamp: 2000 },
      { role: 'user', content: 'Recent 3', timestamp: 2500 },
    ]

    for (const msg of messages) {
      await redis.lpush('conversation:chat-1', JSON.stringify(msg))
    }

    const count = await store.getMessageCountSince('chat-1', 1000)

    expect(count).toBe(3)
  })

  test('getMessageCountSince excludes system messages', async () => {
    const { store, redis } = createStore()

    const messages = [
      { role: 'system', content: 'System prompt', timestamp: 1500 },
      { role: 'user', content: 'User message', timestamp: 2000 },
    ]

    for (const msg of messages) {
      await redis.lpush('conversation:chat-1', JSON.stringify(msg))
    }

    const count = await store.getMessageCountSince('chat-1', 1000)

    expect(count).toBe(1)
  })

  test('getMessageCountSince handles invalid JSON gracefully', async () => {
    const { store, redis } = createStore()

    await redis.lpush(
      'conversation:chat-1',
      JSON.stringify({
        role: 'user',
        content: 'Valid',
        timestamp: 1500,
      })
    )
    await redis.lpush('conversation:chat-1', 'invalid json')

    const count = await store.getMessageCountSince('chat-1', 1000)

    expect(count).toBe(1)
  })

  test('getMessageCountSince returns 0 for unknown chat', async () => {
    const { store } = createStore()

    const count = await store.getMessageCountSince('unknown-chat', 1000)

    expect(count).toBe(0)
  })
})
