import { afterEach, expect, test, vi } from 'vitest'
import { ChatOpenAI } from '@langchain/openai'
import { AgentService } from '../src/lib/agent/index.js'
import logger from '../src/lib/logger.js'
import { InMemoryRedis } from './test-helpers.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test.each(['private', 'group'] as const)(
  'sends inline photo bytes to the provider and persists only text in %s chats',
  async (chatType) => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const redis = new InMemoryRedis()
    const agentInvocations: unknown[] = []
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=',
      'base64'
    )
    const imageUrl =
      'https://api.telegram.org/file/bot-test-token/photos/file_1.jpg'
    const download = vi.fn(
      async () =>
        new Response(png, {
          headers: { 'content-type': 'application/octet-stream' },
        })
    )
    vi.stubGlobal('fetch', download)
    const model = new ChatOpenAI({
      model: 'vision-test',
      apiKey: 'offline',
      maxRetries: 0,
      configuration: {
        fetch: async (_url, init) => {
          const body = String(init?.body)
          const payload: unknown = JSON.parse(body)
          agentInvocations.push(payload)
          if (
            !body.includes(`data:image/png;base64,${png.toString('base64')}`)
          ) {
            return Response.json(
              {
                error: {
                  message: 'Supplied image did not pass validation checks.',
                },
              },
              { status: 400 }
            )
          }
          return Response.json({
            id: 'photo-test',
            object: 'chat.completion',
            created: 0,
            model: 'vision-test',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'vision reply' },
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 2,
              total_tokens: 22,
            },
          })
        },
      },
    })
    const service = new AgentService({
      redis: redis.asRedis(),
      agentModel: model,
      summarizerModel: model,
      systemPrompts: { private: 'private-test', group: 'group-test' },
      summarizerSystemPrompt: '{{period}}',
      supportsVision: true,
      tools: [],
    })

    await service.initialize()

    expect(service.supportsImageInput()).toBe(true)

    const reply = await service.invokeLive(
      `${chatType}:1`,
      {
        text: 'Describe this image',
        imageUrl,
      },
      chatType
    )

    expect(reply).toBe('vision reply')

    const payload = agentInvocations[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    const lastMessage = payload.messages.at(-1)

    expect(lastMessage).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Describe this image',
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${png.toString('base64')}`,
          },
        },
      ],
    })

    expect(download).toHaveBeenCalledWith(
      imageUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(JSON.stringify(agentInvocations)).not.toContain('bot-test-token')
    expect(JSON.stringify(debug.mock.calls)).not.toContain('base64')
    expect(JSON.stringify(debug.mock.calls)).not.toContain('bot-test-token')
    const history = await service.getHistory(`${chatType}:1`)
    expect(JSON.stringify(history)).not.toContain('base64')
    expect(JSON.stringify(history)).not.toContain('bot-test-token')
    expect(
      history
        .map((message: { role: string; content: string }) => ({
          role: message.role,
          content: message.content,
        }))
        .sort(
          (
            left: { role: string; content: string },
            right: { role: string; content: string }
          ) =>
            `${left.role}:${left.content}`.localeCompare(
              `${right.role}:${right.content}`
            )
        )
    ).toEqual(
      [
        {
          role: 'assistant',
          content: 'vision reply',
        },
        {
          role: 'user',
          content: '[image attached]\nCaption: Describe this image',
        },
      ].sort((left, right) =>
        `${left.role}:${left.content}`.localeCompare(
          `${right.role}:${right.content}`
        )
      )
    )
  }
)
