import { ChatOpenAI } from '@langchain/openai'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentService } from '../src/lib/agent/index.js'
import { InMemoryRedis } from './test-helpers.js'

afterEach(() => vi.restoreAllMocks())

test.each(['chat', 'memory'] as const)(
  'cancels a slow %s call without persisting late output and accepts the next turn',
  async (phase) => {
    const controller = new AbortController()
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let requestSignal: AbortSignal | null | undefined
    let requests = 0
    const model = new ChatOpenAI({
      model: 'offline',
      apiKey: 'offline',
      maxRetries: 0,
      configuration: {
        fetch: async (_url, init) => {
          requests++
          if (requests === 1) {
            requestSignal = init?.signal
            started.resolve()
            await release.promise
            requestSignal?.throwIfAborted()
          }
          return Response.json({
            id: 'offline',
            object: 'chat.completion',
            created: 0,
            model: 'offline',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'Next turn works' },
              },
            ],
          })
        },
      },
    })
    const redis = new InMemoryRedis()
    if (phase === 'memory') {
      for (let i = 0; i < 4; i++)
        await redis.lpush(
          'conversation:private:1',
          JSON.stringify({
            role: 'user',
            content: `Earlier message ${i}`,
            timestamp: Date.now() - 1000 + i,
          })
        )
    }
    const service = new AgentService({
      redis: redis.asRedis(),
      agentModel: model,
      summarizerModel: model,
      supportsVision: false,
      tools: [],
      systemPrompts: { private: 'private', group: 'group' },
      summarizerSystemPrompt: '{{period}}',
    })
    await service.initialize()

    const invocation = service
      .invokeLive(
        'private:1',
        { text: 'show me top trending news from x' },
        'private'
      )
      .catch((error: unknown) => error)
    await started.promise
    controller.abort(new DOMException('Request took too long', 'TimeoutError'))
    release.resolve()

    expect(await invocation).toMatchObject({ name: 'TimeoutError' })
    expect(requestSignal?.aborted).toBe(true)
    expect(
      (await service.getHistory('private:1')).map((entry) => entry.role)
    ).not.toContain('assistant')
    expect(
      await redis.zrevrange('memory:summary:private:1:daily', 0, -1)
    ).toEqual([])
    timeout.mockRestore()
    await expect(
      service.invokeLive('private:1', { text: 'hello' }, 'private')
    ).resolves.toBe('Next turn works')
  }
)
