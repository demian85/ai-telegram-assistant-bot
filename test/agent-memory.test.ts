import { test, expect } from 'vitest'
import { AgentService } from '../src/lib/agent/index.js'
import { SummaryStore } from '../src/lib/memory/index.js'
import { buildPersistedTextShadow } from '../src/lib/agent/content.js'
import { InMemoryRedis } from './test-helpers.js'

function createStubModel(modelName: string) {
  return {
    modelName,
    invoke: async () => ({ content: 'summary text' }),
  } as never
}

test('non-vision role wiring falls back to text-shadow input for live and persisted memory', async () => {
  const redis = new InMemoryRedis()
  const agentInvocations: unknown[] = []
  const service = new AgentService({
    redis: redis.asRedis(),
    agentModel: createStubModel('gpt-5.4-nano'),
    summarizerModel: createStubModel('gpt-5.4-nano'),
    systemPrompts: { private: 'private-test', group: 'group-test' },
    summarizerSystemPrompt: '{{period}}',
    supportsVision: false,
    tools: [],
  })

  ;(
    service as never as {
      agent: { invoke(payload: unknown): Promise<unknown> }
    }
  ).agent = {
    invoke: async (payload) => {
      agentInvocations.push(payload)
      return {
        messages: [{ content: 'text-only reply' }],
      }
    },
  }

  expect(service.supportsImageInput()).toBe(false)
  expect(
    buildPersistedTextShadow({ imageUrl: 'https://images.test/only.png' })
  ).toBe('[image attached]')

  await service.invokeLive(
    'private:2',
    {
      text: 'What is in this image?',
      imageUrl: 'https://images.test/only.png',
    },
    'private'
  )
  await service.persistUserMessage('private:2', {
    imageUrl: 'https://images.test/follow-up.png',
  })

  const payload = agentInvocations[0] as {
    messages: Array<{ role: string; content: unknown }>
  }

  expect(payload.messages.at(-1)).toEqual({
    role: 'user',
    content: '[image attached]\nCaption: What is in this image?',
  })

  const history = await service.getHistory('private:2')
  expect(
    history.map((message: { content: string }) => message.content).sort()
  ).toEqual(
    [
      '[image attached]',
      '[image attached]\nCaption: What is in this image?',
      'text-only reply',
    ].sort()
  )
})

test('clearHistory deletes summaries and only clears the targeted chat scope', async () => {
  const redis = new InMemoryRedis()
  const service = new AgentService({
    redis: redis.asRedis(),
    agentModel: createStubModel('gpt-5.4-mini'),
    summarizerModel: createStubModel('gpt-5.4-nano'),
    systemPrompts: { private: 'private-test', group: 'group-test' },
    summarizerSystemPrompt: '{{period}}',
    supportsVision: true,
    tools: [],
  })
  const summaryStore = new SummaryStore(redis.asRedis())

  await service.persistUserMessage('group:1', { text: 'alpha' })
  await service.persistUserMessage('group:2', { text: 'beta' })
  await summaryStore.saveSummary({
    level: 'daily',
    chatId: 'group:1',
    startTime: 1,
    endTime: 2,
    summary: 'group one daily',
    messageCount: 1,
    keyTopics: ['alpha'],
    createdAt: 3,
  })
  await summaryStore.saveSummary({
    level: 'monthly',
    chatId: 'group:1',
    startTime: 1,
    endTime: 4,
    summary: 'group one monthly',
    messageCount: 1,
    keyTopics: ['alpha'],
    createdAt: 5,
  })
  await summaryStore.saveSummary({
    level: 'daily',
    chatId: 'group:2',
    startTime: 1,
    endTime: 2,
    summary: 'group two daily',
    messageCount: 1,
    keyTopics: ['beta'],
    createdAt: 3,
  })

  await service.clearHistory('group:1')

  expect(await service.getHistory('group:1')).toEqual([])
  expect((await summaryStore.getSummaries('group:1', 'daily')).length).toBe(0)
  expect((await summaryStore.getSummaries('group:1', 'monthly')).length).toBe(0)

  const preservedHistory = await service.getHistory('group:2')
  expect(preservedHistory.length).toBe(1)
  expect(preservedHistory[0]?.content).toBe('beta')
  expect((await summaryStore.getSummaries('group:2', 'daily')).length).toBe(1)
})
