import { test, expect, vi, afterEach } from 'vitest'
import {
  NewsPreferenceStore,
  type NewsPreferenceGenerator,
} from '../src/lib/news/preferences.js'
import { preference, filterHarness, article } from './news-filter-helpers.js'
import type { Config } from '../src/lib/types.js'
import { Bot } from '../src/lib/telegram/index.js'
import {
  ChatSubscriptionStore,
  NewsQueryService,
  NewsStore,
} from '../src/lib/news/index.js'
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
  readonly purposes: Array<'chat' | 'summary'> = []
  readonly chatTypes: Array<'private' | 'group'> = []
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
    input: Record<string, unknown>,
    chatType: 'private' | 'group',
    purpose: 'chat' | 'summary' = 'chat'
  ): Promise<string> {
    this.chatTypes.push(chatType)
    this.purposes.push(purpose)
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
    response?: string
    newsQueryService?: NewsQueryService
    generator?: Pick<NewsPreferenceGenerator, 'generate'>
    allowedGroupIds?: string[]
    whitelistedUsers?: string[]
  } = {}
) {
  const redis = new InMemoryRedis()
  const telegraf = new FakeTelegraf()
  const subscriptions = new ChatSubscriptionStore(redis.asRedis())
  const preferences = new NewsPreferenceStore(
    redis.asRedis(),
    'AI and technology'
  )
  const agentService = new StubAgentService(
    options.imageSupport ?? true,
    options.response
  )
  const allowedGroupIds =
    'allowedGroupIds' in options ? options.allowedGroupIds : ['-100']
  const config: Config = {
    telegram: {
      botUsername: 'bot',
      whitelistedUsers: options.whitelistedUsers ?? [],
      ...(allowedGroupIds === undefined ? {} : { allowedGroupIds }),
    },
    news: {
      defaultFilter: 'AI and technology',
      relevanceThreshold: 70,
    },
  }

  const bot = new Bot(
    config,
    {
      agentModel: {} as never,
      summarizerModel: {} as never,
      chatSystemPrompts: { private: 'private-test', group: 'group-test' },
      summarizerSystemPrompt: '{{period}}',
      supportsVision: options.imageSupport ?? true,
    },
    {
      telegraf: telegraf as never,
      richMessageApi: telegraf.richMessageApi,
      redis: redis.asRedis(),
      agentService: agentService as never,
      chatSubscriptionStore: subscriptions,
      newsPreferences: preferences,
      newsPreferenceGenerator: options.generator,
      newsQueryService: options.newsQueryService,
    }
  )

  return { bot, redis, telegraf, subscriptions, agentService, preferences }
}

test.each([
  { allowedGroupIds: undefined },
  { allowedGroupIds: [] },
  { allowedGroupIds: ['-200'] },
])(
  'silently ignores group mentions when the allowlist is $allowedGroupIds',
  async ({ allowedGroupIds }) => {
    // Given a group that is not allowed, even with a whitelisted sender.
    const { telegraf, agentService } = createBotHarness({
      allowedGroupIds,
      whitelistedUsers: ['alice'],
    })

    // When the sender explicitly mentions the bot.
    const ctx = await telegraf.dispatch(
      createTextUpdate({
        chatId: -100,
        chatType: 'group',
        username: 'alice',
        text: '@bot help me',
        entities: [{ type: 'mention', offset: 0, length: 4 }],
      })
    )

    // Then ingress stops before parsing, persistence, invocation, or replies.
    expect(ctx.parsedMessageText).toBeUndefined()
    expect(ctx.isMention).toBeUndefined()
    expect(agentService.persisted).toEqual([])
    expect(agentService.invocations).toEqual([])
    expect(ctx.replyLog).toEqual([])
    expect(ctx.chatActions).toEqual([])
  }
)

test.each(['group', 'supergroup'] as const)(
  'silently ignores photos in an unlisted %s before resolving files',
  async (chatType) => {
    // Given an unlisted group with a photo and an explicit mention.
    const { telegraf, agentService } = createBotHarness()
    const getFileLink = vi.spyOn(telegraf.telegram, 'getFileLink')

    // When its photo update is dispatched.
    const ctx = await telegraf.dispatch(
      createPhotoUpdate({
        chatId: -200,
        chatType,
        username: 'alice',
        caption: '@bot describe it',
        captionEntities: [{ type: 'mention', offset: 0, length: 4 }],
        fileIds: ['denied-photo'],
      })
    )

    // Then no file lookup, model call, persistence, or response occurs.
    expect(getFileLink).not.toHaveBeenCalled()
    expect(ctx.parsedMessageText).toBeUndefined()
    expect(agentService.persisted).toEqual([])
    expect(agentService.invocations).toEqual([])
    expect(ctx.replyLog).toEqual([])
    expect(ctx.chatActions).toEqual([])
  }
)

test.each([
  '/start',
  '/help',
  '/abort',
  '/clear',
  '/info',
  '/news',
  '/summary',
  '/subscribe',
  '/unsubscribe',
  '/interval 900',
  '/newsfilter replacement',
  '/newsfilter reset',
  '/debugnews',
])('silently ignores %s in an unlisted group', async (text) => {
  // Given an unlisted group whose sender is an administrator.
  const generate = vi.fn(async () => preference())
  const { telegraf, redis, subscriptions, preferences, agentService } =
    createBotHarness({ generator: { generate } })
  const getChatMember = vi
    .spyOn(telegraf.telegram, 'getChatMember')
    .mockResolvedValue({ status: 'administrator' })
  const previousSubscription = await subscriptions.subscribe('-200')
  const previousPreference = preference('original')
  await preferences.save('-200', previousPreference)
  const set = vi.spyOn(redis, 'set')
  const del = vi.spyOn(redis, 'del')

  // When the command is dispatched.
  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: -200,
      chatType: 'supergroup',
      username: 'alice',
      text,
    })
  )

  // Then command handlers cannot read authorization or mutate stored state.
  expect(ctx.parsedMessageText).toBeUndefined()
  expect(ctx.replyLog).toEqual([])
  expect(ctx.chatActions).toEqual([])
  expect(getChatMember).not.toHaveBeenCalled()
  expect(generate).not.toHaveBeenCalled()
  expect(set).not.toHaveBeenCalled()
  expect(del).not.toHaveBeenCalled()
  expect(agentService.clearedScopes).toEqual([])
  expect(agentService.persisted).toEqual([])
  expect(agentService.invocations).toEqual([])
  expect(await subscriptions.getSubscription('-200')).toEqual(
    previousSubscription
  )
  expect((await preferences.resolve('-200')).preference).toEqual(
    previousPreference
  )
})

test.each(['group', 'supergroup'] as const)(
  'allows administrator subscriptions in a listed %s',
  async (chatType) => {
    // Given a listed group whose sender is not privately whitelisted.
    const { telegraf, subscriptions } = createBotHarness({
      whitelistedUsers: ['bob'],
    })
    telegraf.telegram.getChatMember = async () => ({
      status: 'administrator',
    })

    // When its administrator subscribes.
    const ctx = await telegraf.dispatch(
      createTextUpdate({
        chatId: -100,
        chatType,
        username: 'alice',
        text: '/subscribe@bot',
      })
    )

    // Then group authorization is independent of the private whitelist.
    expect((await subscriptions.getSubscription('-100'))?.enabled).toBe(true)
    expect(ctx.replyLog.length + telegraf.sentRichMessages.length).toBe(1)
  }
)

test.each([
  { username: 'alice', whitelistedUsers: [], allowed: true },
  { username: 'alice', whitelistedUsers: ['alice'], allowed: true },
  { username: 'bob', whitelistedUsers: ['alice'], allowed: false },
  { username: undefined, whitelistedUsers: [], allowed: false },
])(
  'preserves private access for $username with whitelist $whitelistedUsers',
  async ({ username, whitelistedUsers, allowed }) => {
    // Given an empty group allowlist and the existing private whitelist.
    const { telegraf, agentService } = createBotHarness({
      allowedGroupIds: [],
      whitelistedUsers,
    })

    // When a private message arrives.
    const ctx = await telegraf.dispatch(
      createTextUpdate({
        chatId: 100,
        chatType: 'private',
        username,
        text: 'Hello',
      })
    )

    // Then private username authorization still controls invocation.
    expect(agentService.invocations).toHaveLength(allowed ? 1 : 0)
    expect(ctx.chatActions).toEqual(allowed ? ['typing'] : [])
    expect(ctx.replyLog.length + telegraf.sentRichMessages.length).toBe(1)
  }
)

test('invokes vision for a mentioned photo in a listed supergroup', async () => {
  // Given a listed supergroup and a vision-capable model.
  const { telegraf, agentService } = createBotHarness()

  // When a member mentions the bot in a photo caption.
  const ctx = await telegraf.dispatch(
    createPhotoUpdate({
      chatId: -100,
      chatType: 'supergroup',
      username: 'alice',
      firstName: 'Alice',
      caption: '@bot describe it',
      captionEntities: [{ type: 'mention', offset: 0, length: 4 }],
      fileIds: ['allowed-photo'],
    })
  )

  // Then the image reaches the agent under the normalized group scope.
  expect(agentService.chatTypes).toEqual(['group'])
  expect(agentService.invocations).toEqual([
    {
      chatId: 'group:-100',
      input: {
        text: 'Alice: describe it',
        imageUrl: 'https://files.test/allowed-photo',
        shouldInvoke: true,
      },
    },
  ])
  expect(ctx.chatActions).toEqual(['upload_photo'])
  expect(telegraf.sentRichMessages[0]?.content).toEqual({
    markdown: 'agent reply',
  })
})

test.each([
  { allowedGroupIds: undefined },
  { allowedGroupIds: [] },
  { allowedGroupIds: ['-200'] },
])(
  'rejects outbound group news when the allowlist is $allowedGroupIds',
  async ({ allowedGroupIds }) => {
    // Given a group absent from the allowlist.
    const { bot, telegraf } = createBotHarness({ allowedGroupIds })

    // When scheduled news is sent directly to that group.
    const sending = bot.sendNewsArticle('-100', {
      articleId: 'denied-news',
      title: 'Denied news',
      url: 'https://example.test/denied-news',
      relevanceScore: 90,
    })

    // Then delivery rejects without calling Telegram.
    await expect(sending).rejects.toThrow()
    expect(telegraf.sentMessages).toEqual([])
  }
)

test.each(['-100', '100'])(
  'delivers outbound news to permitted chat %s',
  async (chatId) => {
    // Given an explicitly allowed group and an unrestricted private recipient.
    const { bot, telegraf } = createBotHarness()

    // When scheduled news is sent.
    await bot.sendNewsArticle(chatId, {
      articleId: 'allowed-news',
      title: 'Allowed news',
      url: 'https://example.test/allowed-news',
      relevanceScore: 90,
    })

    // Then Telegram receives exactly one message for that chat.
    expect(telegraf.sentMessages).toHaveLength(1)
    expect(telegraf.sentMessages[0]?.chatId).toBe(chatId)
  }
)

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

test.each([0, 65.5, 100])(
  'relevance saves a private chat threshold of %s',
  async (threshold) => {
    const { telegraf, preferences, subscriptions, agentService } =
      createBotHarness()

    const ctx = await telegraf.dispatch(
      createTextUpdate({
        chatId: 100,
        chatType: 'private',
        username: 'alice',
        text: `/relevance ${threshold}`,
      })
    )

    expect((await preferences.resolve('100')).relevanceThreshold).toBe(
      threshold
    )
    expect(
      (await preferences.resolve('200')).relevanceThreshold
    ).toBeUndefined()
    expect(
      ctx.replyLog.some((reply) => reply.text.includes(`${threshold}/100`))
    ).toBe(true)
    expect(agentService.invocations).toEqual([])
    expect(await subscriptions.getSubscription('100')).toBeNull()
  }
)

test.each(['-1', '101', 'NaN', 'Infinity', '0x50', '80 extra', '75%'])(
  'relevance rejects invalid input %s',
  async (args) => {
    const { telegraf, preferences } = createBotHarness()
    await preferences.setRelevanceThreshold('100', 90)

    await telegraf.dispatch(
      createTextUpdate({
        chatId: 100,
        chatType: 'private',
        username: 'alice',
        text: `/relevance ${args}`,
      })
    )

    expect((await preferences.resolve('100')).relevanceThreshold).toBe(90)
  }
)

test('relevance reset displays the configured default and preserves other settings', async () => {
  const { telegraf, preferences, subscriptions } = createBotHarness()
  const custom = preference()
  await preferences.save('100', custom)
  await preferences.setRelevanceThreshold('100', 85)
  const subscription = await subscriptions.subscribe('100')

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: '/relevance reset',
    })
  )

  expect((await preferences.resolve('100')).relevanceThreshold).toBeUndefined()
  expect((await preferences.resolve('100')).preference).toEqual(custom)
  expect(await subscriptions.getSubscription('100')).toEqual(subscription)
  expect(ctx.replyLog.some((reply) => reply.text.includes('70/100'))).toBe(true)
})

test.each(['member', 'administrator', 'creator', 'lookup-failure'])(
  'relevance enforces group access for %s',
  async (status) => {
    const { telegraf, preferences } = createBotHarness()
    telegraf.telegram.getChatMember = async () => {
      if (status === 'lookup-failure') throw new Error('Telegram unavailable')
      return { status }
    }

    await telegraf.dispatch(
      createTextUpdate({
        chatId: -100,
        chatType: 'supergroup',
        username: 'alice',
        text: '/relevance@bot 85',
      })
    )

    expect((await preferences.resolve('-100')).relevanceThreshold).toBe(
      status === 'administrator' || status === 'creator' ? 85 : undefined
    )
  }
)

test('relevance ignores commands from unlisted groups', async () => {
  const { telegraf, preferences } = createBotHarness({ allowedGroupIds: [] })
  const lookup = vi.spyOn(telegraf.telegram, 'getChatMember')

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: -100,
      chatType: 'group',
      username: 'alice',
      text: '/relevance@bot 60',
    })
  )

  expect((await preferences.resolve('-100')).relevanceThreshold).toBeUndefined()
  expect(lookup).not.toHaveBeenCalled()
  expect(ctx.replyLog).toEqual([])
})

test('relevance displays the current setting without changing it', async () => {
  const { telegraf, preferences } = createBotHarness()
  await preferences.setRelevanceThreshold('100', 82)

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: '/relevance',
    })
  )

  expect((await preferences.resolve('100')).relevanceThreshold).toBe(82)
  expect(ctx.replyLog.some((reply) => reply.text.includes('82/100'))).toBe(true)
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

  expect(agentService.chatTypes).toEqual(['private'])
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
  expect(telegraf.sentRichMessages[0]?.content).toEqual({
    markdown: 'agent reply',
  })
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
  expect(telegraf.sentRichMessages[0]?.content).toEqual({
    markdown: 'agent reply',
  })
})

const previousBotMessage = {
  message_id: 99,
  date: 1,
  chat: { id: -100, type: 'group' },
  from: {
    id: 42,
    is_bot: true,
    first_name: 'Bot',
    username: 'previous_bot_name',
  },
  text: 'agent reply',
} as const

test.each(['group', 'supergroup'] as const)(
  'includes the original message and author when mentioning the bot in a %s reply',
  async (chatType) => {
    // Given an original message that is absent from the bot's memory.
    const { telegraf, agentService } = createBotHarness()
    const original = {
      ...previousBotMessage,
      from: {
        id: 7,
        is_bot: false,
        first_name: 'Carlos',
        last_name: 'Garcia',
        username: 'carlos',
      },
      text: 'The meeting moved to Friday.\nBring the report.',
    }

    // When another member replies and mentions the bot.
    await telegraf.dispatch(
      createTextUpdate({
        chatId: -100,
        chatType,
        username: 'bob',
        firstName: 'Bob',
        text: '@bot what changed?',
        entities: [{ type: 'mention', offset: 0, length: 4 }],
        replyToMessage: original,
      })
    )

    // Then the agent receives both authors and the original unmodified text.
    expect(agentService.invocations).toEqual([
      {
        chatId: 'group:-100',
        input: {
          text: 'Bob: what changed?',
          shouldInvoke: true,
          replyContext: {
            author: 'Carlos Garcia (@carlos)',
            text: original.text,
          },
        },
      },
    ])
  }
)

test.each(['group', 'supergroup'] as const)(
  'answers an unmentioned reply to its own message in a listed %s',
  async (chatType) => {
    // Given a listed group with a previous message from this bot.
    const { telegraf, agentService } = createBotHarness()

    // When another member replies without mentioning the bot.
    const ctx = await telegraf.dispatch(
      createTextUpdate({
        chatId: -100,
        chatType,
        username: 'bob',
        firstName: 'Bob',
        text: 'Can you explain more?',
        replyToMessage: previousBotMessage,
      })
    )

    // Then the reply continues the shared group conversation.
    expect(agentService.invocations).toEqual([
      {
        chatId: 'group:-100',
        input: {
          text: 'Bob: Can you explain more?',
          shouldInvoke: true,
          replyContext: {
            author: 'Bot (@previous_bot_name)',
            text: previousBotMessage.text,
          },
        },
      },
    ])
    expect(ctx.chatActions).toEqual(['typing'])
    expect(telegraf.sentRichMessages[0]?.content).toEqual({
      markdown: 'agent reply',
    })
  }
)

test.each([
  { text: '@bot', original: { text: 'Keep the launch on Monday.' } },
  { text: '@bot explain', original: { caption: 'Launch schedule diagram' } },
  { text: '@bot explain', original: {} },
])(
  'includes reply context for $text with $original',
  async ({ text, original }) => {
    // Given a replied-to message from a member without a username.
    const { telegraf, agentService } = createBotHarness()
    const replyToMessage = {
      message_id: 99,
      date: 1,
      chat: previousBotMessage.chat,
      from: { id: 7, is_bot: false, first_name: 'Carlos' },
      ...original,
    }

    // When a member mentions the bot in a reply, possibly without other text.
    await telegraf.dispatch(
      createTextUpdate({
        chatId: -100,
        chatType: 'group',
        username: 'bob',
        text,
        entities: [{ type: 'mention', offset: 0, length: 4 }],
        replyToMessage,
      })
    )

    // Then reply content is available even without stored history or a caption.
    expect(agentService.invocations).toHaveLength(1)
    expect(agentService.invocations[0]?.input.replyContext).toEqual({
      author: 'Carlos',
      text: original.text ?? original.caption ?? '[non-text message]',
    })
  }
)

test.each(['group', 'supergroup'] as const)(
  'answers an unmentioned photo reply to its own message in a listed %s',
  async (chatType) => {
    // Given a listed group and a vision-capable model.
    const { telegraf, agentService } = createBotHarness()

    // When a member replies to this bot with a photo and no mention.
    const ctx = await telegraf.dispatch(
      createPhotoUpdate({
        chatId: -100,
        chatType,
        username: 'alice',
        caption: 'What about this?',
        fileIds: ['reply-photo'],
        replyToMessage: previousBotMessage,
      })
    )

    expect(ctx.replyLog).toEqual([])

    // Then the reply reaches the same agent image path as a mention.
    expect(agentService.invocations).toEqual([
      {
        chatId: 'group:-100',
        input: {
          text: 'Alice: What about this?',
          imageUrl: 'https://files.test/reply-photo',
          shouldInvoke: true,
          replyContext: {
            author: 'Bot (@previous_bot_name)',
            text: previousBotMessage.text,
          },
        },
      },
    ])
    expect(telegraf.sentRichMessages[0]?.content).toEqual({
      markdown: 'agent reply',
    })
  }
)

test.each([
  { id: 1, is_bot: false, first_name: 'Alice', username: 'alice' },
  { id: 43, is_bot: true, first_name: 'Other bot', username: 'bot' },
])('does not answer an unmentioned reply to $username ($id)', async (from) => {
  // Given a listed group and a message from someone other than this bot.
  const { telegraf, agentService } = createBotHarness()

  // When a member replies to that message without mentioning this bot.
  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: -100,
      chatType: 'group',
      username: 'bob',
      firstName: 'Bob',
      text: 'Tell me more',
      replyToMessage: { ...previousBotMessage, from },
    })
  )

  // Then the message is only stored as passive group context.
  expect(agentService.invocations).toEqual([])
  expect(agentService.persisted).toEqual([
    {
      chatId: 'group:-100',
      input: { text: 'Bob: Tell me more', shouldInvoke: false },
    },
  ])
  expect(ctx.replyLog).toEqual([])
})

test.each(['group', 'supergroup'] as const)(
  'ignores replies to its own messages in an unlisted %s',
  async (chatType) => {
    // Given a group absent from the allowlist.
    const { telegraf, agentService } = createBotHarness({
      allowedGroupIds: [],
    })

    // When someone replies to a previous bot message.
    const ctx = await telegraf.dispatch(
      createTextUpdate({
        chatId: -100,
        chatType,
        username: 'alice',
        text: 'Tell me more',
        replyToMessage: previousBotMessage,
      })
    )

    // Then authorization still stops ingress before any side effects.
    expect(ctx.parsedMessageText).toBeUndefined()
    expect(agentService.invocations).toEqual([])
    expect(agentService.persisted).toEqual([])
    expect(ctx.replyLog).toEqual([])
    expect(ctx.chatActions).toEqual([])
  }
)

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
  expect(telegraf.sentRichMessages[0]?.content).toEqual({
    markdown: 'agent reply',
  })
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

test.each(['', ' \t\n'])(
  'sends an explanatory reply for blank agent output %j',
  async (response) => {
    const { telegraf } = createBotHarness({ response })

    const ctx = await telegraf.dispatch(
      createTextUpdate({
        chatId: 100,
        chatType: 'private',
        username: 'alice',
        text: 'Hello',
      })
    )

    expect(ctx.replyLog.map(({ text }) => text)).toEqual([
      'Sorry, I encountered an error. Please try again.',
    ])
    expect(telegraf.sentRichMessages).toEqual([])
  }
)

test('delivers an oversized agent reply as consecutive formatted messages', async () => {
  const response = '**A useful explanation.**\n\n'.repeat(2000)
  const { telegraf } = createBotHarness({ response })

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: 'Explain this in detail',
    })
  )

  expect(ctx.replyLog).toEqual([])
  expect(telegraf.sentRichMessages.length).toBeGreaterThan(1)
  expect(
    telegraf.sentRichMessages.map(({ content }) => content.markdown).join('')
  ).toBe(response)
  for (const { content, extra } of telegraf.sentRichMessages) {
    expect(content.markdown?.length).toBeLessThanOrEqual(32768)
    expect(extra?.reply_parameters?.message_id).toBe(ctx.message?.message_id)
  }
})

test('sends a group agent answer as native rich Markdown in the original topic', async () => {
  const response =
    '# Comparison\n\n| Model | Price |\n| --- | --- |\n| A | $10 |'
  const { telegraf } = createBotHarness({ response })
  const update = createTextUpdate({
    chatId: -100,
    chatType: 'supergroup',
    username: 'alice',
    text: '@bot compare',
    entities: [{ type: 'mention', offset: 0, length: 4 }],
  })
  if (!update.message) throw new TypeError('Expected a message update')
  update.message.message_thread_id = 77

  const ctx = await telegraf.dispatch(update)

  expect(ctx.replyLog).toEqual([])
  expect(telegraf.sentRichMessages).toEqual([
    {
      chatId: '-100',
      content: { markdown: response },
      extra: {
        message_thread_id: 77,
        reply_parameters: {
          message_id: update.message.message_id,
          allow_sending_without_reply: true,
        },
      },
    },
  ])
})

test('uses native rich Markdown for generated news summaries too', async () => {
  const news = filterHarness()
  const store = new NewsStore(news.redis.asRedis())
  await store.storeItem({
    ...article('summary-article'),
    fetchedAt: new Date(),
  })
  const newsQueryService = new NewsQueryService({
    redis: news.redis.asRedis(),
    filter: news.filter,
  })
  const response =
    '## Summary\n\n**News** with `file_name` and [details](https://example.com)'
  const { telegraf, agentService } = createBotHarness({
    response,
    newsQueryService,
  })

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: '/summary',
    })
  )

  expect(ctx.replyLog).toEqual([])
  expect(agentService.purposes).toEqual(['summary'])
  expect(telegraf.sentRichMessages[0]?.content).toEqual({ markdown: response })
})

test('sends an explanatory reply for a whitespace-only news summary', async () => {
  const news = filterHarness()
  const store = new NewsStore(news.redis.asRedis())
  await store.storeItem({
    ...article('summary-article'),
    fetchedAt: new Date(),
  })
  const newsQueryService = new NewsQueryService({
    redis: news.redis.asRedis(),
    filter: news.filter,
  })
  const { telegraf } = createBotHarness({
    response: ' \t\n',
    newsQueryService,
  })

  const ctx = await telegraf.dispatch(
    createTextUpdate({
      chatId: 100,
      chatType: 'private',
      username: 'alice',
      text: '/summary',
    })
  )

  expect(ctx.replyLog.map(({ text }) => text)).toEqual([
    "Sorry, I couldn't generate a summary right now. Please try again later.",
  ])
  expect(telegraf.sentRichMessages).toEqual([])
})

test('splits scheduled news while preserving literal RSS content and links', async () => {
  const { bot, telegraf } = createBotHarness()
  const description = 'A & <B> **C** '.repeat(800)

  await bot.sendNewsArticle('100', {
    articleId: 'large',
    title: 'Large article',
    description,
    url: 'https://example.com/?a=1&b=2',
    relevanceScore: 90,
  })

  expect(telegraf.sentMessages.length).toBeGreaterThan(1)
  expect(telegraf.sentMessages.map(({ text }) => text).join('')).toBe(
    `Large article\nRead more\n${description}\n\nRelevance score: 90`
  )
  expect(telegraf.sentMessages[0]?.extra?.entities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'text_link',
        url: 'https://example.com/?a=1&b=2',
      }),
    ])
  )
  for (const { text, extra } of telegraf.sentMessages) {
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(extra?.link_preview_options).toEqual({ is_disabled: false })
  }
})
