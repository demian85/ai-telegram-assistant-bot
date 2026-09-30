import { test, expect, vi, afterEach } from 'vitest'
import {
  NewsPreferenceStore,
  type NewsPreferenceGenerator,
} from '../src/lib/news/preferences.js'
import { preference } from './news-filter-helpers.js'
import type { Config } from '../src/lib/types.js'
import { Bot } from '../src/lib/telegram/index.js'
import { ChatSubscriptionStore } from '../src/lib/news/index.js'
import {
  FakeTelegraf,
  InMemoryRedis,
  createPhotoUpdate,
  createTextUpdate,
} from './test-helpers.js'

const originalListeners = {
  uncaughtException: new Set(process.listeners('uncaughtException')),
  unhandledRejection: new Set(process.listeners('unhandledRejection')),
  SIGINT: new Set(process.listeners('SIGINT')),
  SIGTERM: new Set(process.listeners('SIGTERM')),
}
afterEach(() => {
  for (const listener of process.listeners('uncaughtException')) {
    if (!originalListeners.uncaughtException.has(listener))
      process.removeListener('uncaughtException', listener)
  }
  for (const listener of process.listeners('unhandledRejection')) {
    if (!originalListeners.unhandledRejection.has(listener))
      process.removeListener('unhandledRejection', listener)
  }
  for (const listener of process.listeners('SIGINT')) {
    if (!originalListeners.SIGINT.has(listener))
      process.removeListener('SIGINT', listener)
  }
  for (const listener of process.listeners('SIGTERM')) {
    if (!originalListeners.SIGTERM.has(listener))
      process.removeListener('SIGTERM', listener)
  }
})

class StubAgentService {
  readonly persisted: Array<{
    chatId: string
    input: Record<string, unknown>
  }> = []
  readonly invocations: Array<{
    chatId: string
    input: Record<string, unknown>
  }> = []
  readonly clearedScopes: string[] = []

  constructor(
    private readonly imageSupport: boolean,
    private readonly response: string = 'agent reply'
  ) {}

  async initialize(): Promise<void> {}

  supportsImageInput(): boolean {
    return this.imageSupport
  }

  async persistUserMessage(
    chatId: string,
    input: Record<string, unknown>
  ): Promise<void> {
    this.persisted.push({ chatId, input })
  }

  async invokeLive(
    chatId: string,
    input: Record<string, unknown>
  ): Promise<string> {
    this.invocations.push({ chatId, input })
    return this.response
  }

  async clearHistory(chatScope: string): Promise<void> {
    this.clearedScopes.push(chatScope)
  }
}

function createBotHarness(
  options: {
    imageSupport?: boolean
    generator?: Pick<NewsPreferenceGenerator, 'generate'>
  } = {}
) {
  const redis = new InMemoryRedis()
  const telegraf = new FakeTelegraf()
  const subscriptions = new ChatSubscriptionStore(redis.asRedis())
  const preferences = new NewsPreferenceStore(
    redis.asRedis(),
    'AI and technology'
  )
  const agentService = new StubAgentService(options.imageSupport ?? true)
  const config: Config = {
    telegram: {
      botUsername: 'bot',
      whitelistedUsers: [],
    },
    news: {
      defaultFilter: 'AI and technology',
    },
  }

  const bot = new Bot(
    config,
    {
      agentModel: {} as never,
      summarizerModel: {} as never,
      chatSystemPrompt: 'You are a helpful assistant',
      supportsVision: options.imageSupport ?? true,
    },
    {
      telegraf: telegraf as never,
      redis: redis.asRedis(),
      agentService: agentService as never,
      chatSubscriptionStore: subscriptions,
      newsPreferences: preferences,
      newsPreferenceGenerator: options.generator,
    }
  )

  return { bot, redis, telegraf, subscriptions, agentService, preferences }
}

test('newsfilter saves and displays preferences without invoking the chat agent', async () => {
  const generated = preference()
  const generate = vi.fn(async () => generated)
  const { telegraf, preferences, agentService, subscriptions } =
    createBotHarness({ generator: { generate } })
  const update = (text: string) =>
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text,
    })

  const saved = await telegraf.dispatch(update('/newsfilter my interests'))
  const shown = await telegraf.dispatch(update('/newsfilter'))

  expect((await preferences.resolve('100')).preference).toEqual(generated)
  expect(generate).toHaveBeenCalledWith('my interests')
  expect(
    saved.replyLog.some((reply) => reply.text.includes(generated.instruction))
  ).toBe(true)
  expect(
    shown.replyLog.some((reply) => reply.text.includes(generated.description))
  ).toBe(true)
  expect(agentService.invocations).toEqual([])
  expect(await subscriptions.getSubscription('100')).toBeNull()
})

test('does not advertise or execute the removed topics command', async () => {
  const { telegraf, bot, subscriptions } = createBotHarness()
  expect(
    bot['registeredCommands'].map((command) => command.command)
  ).not.toContain('topics')
  await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: '/topics changed',
    })
  )
  expect(await subscriptions.getSubscription('100')).toBeNull()
})

test('newsfilter keeps previous preferences when generation fails', async () => {
  const { telegraf, preferences } = createBotHarness({
    generator: {
      generate: async () => {
        throw new Error('provider unavailable')
      },
    },
  })
  const previous = preference()
  await preferences.save('100', previous)

  await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: '/newsfilter replacement',
    })
  )

  expect((await preferences.resolve('100')).preference).toEqual(previous)
})

test.each(['member', 'administrator', 'creator'])(
  'newsfilter enforces group authorization for %s',
  async (status) => {
    const generate = vi.fn(async () => preference())
    const { telegraf, preferences } = createBotHarness({
      generator: { generate },
    })
    telegraf.telegram.getChatMember = async () => ({ status })

    await telegraf.dispatch(
      createTextUpdate({
        chatId: -100,
        chatType: 'group',
        username: 'alice',
        text: '/newsfilter@bot my interests',
      })
    )

    expect(generate).toHaveBeenCalledTimes(status === 'member' ? 0 : 1)
    expect((await preferences.resolve('-100')).source).toBe(
      status === 'member' ? 'default' : 'custom'
    )
  }
)

test('newsfilter reset preserves subscription cadence and needs no generator', async () => {
  const { telegraf, preferences, subscriptions } = createBotHarness()
  await preferences.save('100', preference())
  await subscriptions.subscribe('100')
  const previous = await subscriptions.setIntervalSeconds('100', 1800)

  await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: '/newsfilter reset',
    })
  )

  expect((await preferences.resolve('100')).source).toBe('default')
  expect(await subscriptions.getSubscription('100')).toEqual(previous)
})

test('private text messages invoke the agent directly', async () => {
  const { telegraf, agentService } = createBotHarness()

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: 'Hello there',
    })
  )

  expect(agentService.invocations).toEqual([
    {
      chatId: 'private:100',
      input: {
        text: 'Hello there',
        shouldInvoke: true,
      },
    },
  ])
  expect(ctx.chatActions).toEqual(['typing'])
  expect(ctx.replyLog[0]?.text).toBe('agent reply')
})

test('group text without a mention is persisted for memory without triggering a reply', async () => {
  const { telegraf, agentService } = createBotHarness()

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: -100,
      chatType: 'group',
      username: 'alice',
      firstName: 'Alice',
      text: 'Hello team',
    })
  )

  expect(agentService.persisted).toEqual([
    {
      chatId: 'group:-100',
      input: {
        text: 'Alice: Hello team',
        shouldInvoke: false,
      },
    },
  ])
  expect(agentService.invocations).toEqual([])
  expect(ctx.replyLog).toEqual([])
})

test('group text with an explicit mention invokes the agent with sender-attributed text', async () => {
  const { telegraf, agentService } = createBotHarness()

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: -100,
      chatType: 'group',
      username: 'alice',
      firstName: 'Alice',
      text: '@bot help me',
      entities: [{ type: 'mention', offset: 0, length: 4 }],
    })
  )

  expect(agentService.invocations).toEqual([
    {
      chatId: 'group:-100',
      input: {
        text: 'Alice: help me',
        shouldInvoke: true,
      },
    },
  ])
  expect(ctx.chatActions).toEqual(['typing'])
  expect(ctx.replyLog[0]?.text).toBe('agent reply')
})

test('private photos use the live vision path when the model supports image input', async () => {
  const { telegraf, agentService } = createBotHarness({ imageSupport: true })

  const ctx = await telegraf.dispatch(
    createPhotoUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      caption: 'Describe it',
      fileIds: ['small-photo', 'large-photo'],
    })
  )

  expect(agentService.invocations).toEqual([
    {
      chatId: 'private:100',
      input: {
        text: 'Describe it',
        imageUrl: 'https://files.test/large-photo',
        shouldInvoke: true,
      },
    },
  ])
  expect(ctx.chatActions).toEqual(['upload_photo'])
  expect(ctx.replyLog[0]?.text).toBe('agent reply')
})

test('private photos persist context and warn when the model does not support vision', async () => {
  const { telegraf, agentService } = createBotHarness({ imageSupport: false })

  const ctx = await telegraf.dispatch(
    createPhotoUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      caption: 'What is this?',
      fileIds: ['photo-a'],
    })
  )

  expect(agentService.invocations).toEqual([])
  expect(agentService.persisted).toEqual([
    {
      chatId: 'private:100',
      input: {
        text: 'What is this?',
        imageUrl: 'https://files.test/photo-a',
        shouldInvoke: true,
      },
    },
  ])
  expect(ctx.replyLog[0]?.text ?? '').toMatch(
    /cannot inspect images yet\. I saved your message context/
  )
})

test('help surfaces the current operational command set and self-service news note', async () => {
  const { telegraf } = createBotHarness()

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: '/help',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    })
  )

  const helpText = ctx.replyLog[0]?.text ?? ''
  expect(helpText).toMatch(/Operational commands:/)
  expect(helpText).toMatch(
    /\/subscribe - enable relevant news delivery for this chat/
  )
  expect(helpText).toMatch(
    /private chats invoke the agent directly on each text or photo message/
  )
  expect(helpText).toMatch(/self-service/)
})

test('group subscription commands are rejected for non-admin users', async () => {
  const { telegraf, subscriptions } = createBotHarness()
  telegraf.telegram.getChatMember = async () => ({ status: 'member' })

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: -100,
      chatType: 'group',
      username: 'alice',
      text: '/subscribe',
      entities: [{ type: 'bot_command', offset: 0, length: 10 }],
    })
  )

  expect(ctx.replyLog[0]?.text).toBe(
    'Only group admins can use /subscribe in groups.'
  )
  expect(await subscriptions.getSubscription('-100')).toBe(null)
})

test('scheduled news with Markdown-looking RSS fields sends parseable literal text', async () => {
  const { bot, telegraf } = createBotHarness()

  await bot.sendNewsArticle('165286700', {
    articleId: 'https://huggingface.co/blog/nvidia/nemotron-diarization',
    title:
      '**Know Who Spoke When: Build Real-Time, Multi-Speaker AI with NVIDIA Nemotron 3 Diarization**',
    url: 'https://huggingface.co/blog/nvidia/nemotron-diarization?src=a&mode=1',
    description: 'NVIDIA & <partners> explain speaker "diarization"',
    relevanceScore: 75,
  })

  expect(telegraf.sentMessages).toEqual([
    {
      chatId: '165286700',
      text:
        '<b>**Know Who Spoke When: Build Real-Time, Multi-Speaker AI with NVIDIA Nemotron 3 Diarization**</b>\n' +
        '<a href="https://huggingface.co/blog/nvidia/nemotron-diarization?src=a&amp;mode=1">Read more</a>\n' +
        'NVIDIA &amp; &lt;partners&gt; explain speaker &quot;diarization&quot;\n\n' +
        'Relevance score: 75',
      extra: {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: false },
      },
    },
  ])
})
