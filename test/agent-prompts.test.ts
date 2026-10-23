import { ChatOpenAI } from '@langchain/openai'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { AgentService } from '../src/lib/agent/index.js'
import { SummaryStore } from '../src/lib/memory/index.js'
import { renderPromptTemplate } from '../src/lib/config/prompt-template.js'
import { InMemoryRedis } from './test-helpers.js'

const requestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
})

function recordingModel() {
  const requests: z.infer<typeof requestSchema>[] = []
  const model = new ChatOpenAI({
    apiKey: 'offline-test',
    model: 'offline-model',
    maxRetries: 0,
    configuration: {
      fetch: async (_url, init) => {
        requests.push(requestSchema.parse(JSON.parse(String(init?.body))))
        return new Response(
          JSON.stringify({
            id: 'test',
            object: 'chat.completion',
            created: 0,
            model: 'offline-model',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'recorded-result' },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      },
    },
  })
  return { model, requests }
}

afterEach(() => vi.restoreAllMocks())

test.each(['private', 'group'] as const)(
  'sends the configured %s prompt through the real agent graph',
  async (chatType) => {
    // Given different configured routes, with a runtime variable in each.
    const { model, requests } = recordingModel()
    const agent = new AgentService({
      redis: new InMemoryRedis().asRedis(),
      agentModel: model,
      summarizerModel: model,
      supportsVision: false,
      tools: [],
      systemPrompts: {
        private: '{"route":"private","type":"{{chatType}}"}',
        group: '{"route":"group","type":"{{chatType}}"}',
      },
      summarizerSystemPrompt: '{{period}}',
    })
    await agent.initialize()
    // When
    await agent.invokeLive(`${chatType}:1`, { text: 'input' }, chatType)
    // Then the provider receives the selected route and rendered type.
    expect(requests).toHaveLength(1)
    const firstMessage = requests[0]?.messages[0]
    expect(firstMessage?.role).toBe('system')
    expect(JSON.parse(firstMessage?.content ?? '{}')).toEqual({
      route: chatType,
      type: chatType,
    })
  }
)

test('uses configured summary instructions and variables when persisted messages trigger memory generation', async () => {
  // Given a configured template that exercises every summary variable.
  const now = Date.parse('2026-10-23T12:00:00Z')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const redis = new InMemoryRedis()
  const { model, requests } = recordingModel()
  const agent = new AgentService({
    redis: redis.asRedis(),
    agentModel: model,
    summarizerModel: model,
    supportsVision: false,
    tools: [],
    systemPrompts: { private: 'private-test', group: 'group-test' },
    summarizerSystemPrompt:
      '{"level":"{{level}}","period":"{{period}}","count":"{{messageCount}}","start":"{{startTime}}","end":"{{endTime}}"}',
  })
  const input = [
    'Alice: first',
    'Bob: second',
    'Alice: third',
    'Bob: fourth',
    'Alice: {{period}}',
  ]
  // When five persisted messages trigger daily summarization.
  for (const [index, text] of input.entries()) {
    clock.mockReturnValue(now - 4 + index)
    await agent.persistUserMessage('group:-1', { text })
  }
  // Then the provider receives configured instructions separately from literal transcript data.
  expect(requests).toHaveLength(1)
  const messages = requests[0]?.messages ?? []
  expect(messages.map((message) => message.role)).toEqual(['system', 'user'])
  expect(JSON.parse(messages[0]?.content ?? '{}')).toEqual({
    level: 'daily',
    period: 'day',
    count: '5',
    start: '2026-10-22T12:00:00.000Z',
    end: '2026-10-23T12:00:00.000Z',
  })
  expect(messages[1]?.content).toBe(
    input.map((text) => `user: ${text}`).join('\n\n')
  )
  const summaries = await new SummaryStore(redis.asRedis()).getSummaries(
    'group:-1',
    'daily'
  )
  expect(summaries.map((summary) => summary.summary)).toEqual([
    'recorded-result',
  ])
})

test('replaces repeated variables once without interpreting inserted values or JSON braces', () => {
  // Given
  const template = '{"first":"{{ value }}","second":"{{value}}"}'
  // When
  const output = renderPromptTemplate(template, { value: '{{other}} $&' })
  // Then
  expect(JSON.parse(output)).toEqual({
    first: '{{other}} $&',
    second: '{{other}} $&',
  })
})
