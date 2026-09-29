import { ChatOpenAI } from '@langchain/openai'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { AgentService } from '../src/lib/agent/index.js'
import { createRecentNewsTool } from '../src/lib/agent/tools.js'
import { NewsQueryService } from '../src/lib/news/news-query-service.js'
import { filterHarness } from './news-filter-helpers.js'

test('agent invocation carries trusted chat context through the real tool graph', async () => {
  const harness = filterHarness()
  const query = new NewsQueryService({
    redis: harness.redis.asRedis(),
    filter: harness.filter,
  })
  const retrieve = vi
    .spyOn(query, 'fetchAndGetRecentNewsForChat')
    .mockResolvedValue([])
  const model = new ChatOpenAI({
    apiKey: 'offline-test',
    model: 'offline-model',
    maxRetries: 0,
    configuration: {
      fetch: async (_url, init) => {
        const request = z
          .object({ messages: z.array(z.object({ role: z.string() })) })
          .parse(JSON.parse(String(init?.body)))
        const hasResult = request.messages.some(
          (message) => message.role === 'tool'
        )
        const message = hasResult
          ? { role: 'assistant', content: 'done' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'news-call',
                  type: 'function',
                  function: {
                    name: 'get_recent_news',
                    arguments: JSON.stringify({ count: 3 }),
                  },
                },
              ],
            }
        return new Response(
          JSON.stringify({
            id: 'test',
            object: 'chat.completion',
            created: 0,
            model: 'offline-model',
            choices: [
              {
                index: 0,
                finish_reason: hasResult ? 'stop' : 'tool_calls',
                message,
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      },
    },
  })
  const agent = new AgentService({
    redis: harness.redis.asRedis(),
    agentModel: model,
    summarizerModel: model,
    supportsVision: false,
    tools: [createRecentNewsTool(query)],
  })
  await agent.initialize()

  await agent.invokeLive('group:-123', { text: 'Get recent news' })

  expect(retrieve).toHaveBeenCalledExactlyOnceWith(3, '-123')
})
