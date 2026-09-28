import { Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'
import type { ChatOpenAI } from '@langchain/openai'
import type { Redis } from 'ioredis'
import type { StructuredTool } from '@langchain/core/tools'
import logger from '@lib/logger.js'
import { AgentService } from '@lib/agent/index.js'
import {
  ChatSubscriptionStore,
  defaultNewsIntervalSeconds,
  maxNewsIntervalSeconds,
  minNewsIntervalSeconds,
  type NewsChatSubscription,
  NewsQueryService,
  type NewsItem,
  type RecentNewsItem,
  normalizeTopics,
  formatTopics,
} from '@lib/news/index.js'
import { getRedisClient } from '@lib/redis/index.js'
import { getContextChatScope } from './scope.js'
import {
  MessageContext,
  PhotoMessageContext,
  TelegramContext,
  type MessageEntity,
} from './types.js'
import { Config } from '@lib/types.js'
import {
  formatTelegramMarkdownReply,
  escapeHtml,
  createHtmlLink,
  formatNewsArticles,
  type NewsArticle,
} from './util.js'

export interface BotModels {
  agentModel: ChatOpenAI
  summarizerModel: ChatOpenAI
  chatSystemPrompt: string
  supportsVision: boolean
  supportsWebSearch?: boolean
}

export interface BotNewsArticle {
  articleId: string
  title: string
  url: string
  description?: string
  relevanceScore: number
}

interface NormalizedTelegramIngress {
  text: string
  imageUrl?: string
  shouldInvoke: boolean
}

type BotCommandHandler = (ctx: TelegramContext) => Promise<void> | void

interface BotRuntime {
  telegram: {
    setMyCommands(
      commands: ReadonlyArray<{ command: string; description: string }>
    ): Promise<unknown>
    getFileLink(fileId: string): Promise<URL>
    sendMessage(
      chatId: string,
      text: string,
      extra?: Record<string, unknown>
    ): Promise<unknown>
    getChatMember(chatId: number, userId: number): Promise<{ status: string }>
  }
  use(
    middleware: (
      ctx: TelegramContext,
      next: () => Promise<void>
    ) => Promise<unknown>
  ): void
  on(updateType: unknown, handler: (ctx: any) => Promise<unknown>): void
  start(handler: BotCommandHandler): void
  command(command: string, handler: BotCommandHandler): void
  launch(callback?: () => void): Promise<unknown>
  stop(reason?: string): void
}

export interface BotDependencies {
  telegraf?: BotRuntime
  redis?: Redis
  agentService?: AgentService
  chatSubscriptionStore?: ChatSubscriptionStore
  newsQueryService?: NewsQueryService
  tools?: StructuredTool[]
}

export class Bot {
  private config
  private bot: BotRuntime
  private agentService: AgentService | null = null
  private readonly chatSubscriptionStore: ChatSubscriptionStore
  private readonly newsQueryService: NewsQueryService | null = null

  private readonly registeredCommands = [
    {
      command: 'start',
      description: 'Show bot overview and status',
    },
    {
      command: 'help',
      description: 'Show operational commands',
    },
    {
      command: 'abort',
      description: 'Abort the current operation',
    },
    {
      command: 'clear',
      description: 'Clear this chat history',
    },
    {
      command: 'info',
      description: 'Show chat and subscription status',
    },
    {
      command: 'news',
      description: 'Get recent news (1-10 articles)',
    },
    {
      command: 'subscribe',
      description: 'Enable news delivery',
    },
    {
      command: 'unsubscribe',
      description: 'Disable news delivery',
    },
    {
      command: 'interval',
      description: 'Show or set news interval',
    },
    {
      command: 'topics',
      description: 'Show or set news topics',
    },
    {
      command: 'summary',
      description: 'Summarize recent news (last 24h)',
    },
  ] as const

  constructor(
    config: Config,
    models: BotModels,
    dependencies: BotDependencies = {}
  ) {
    this.config = config

    this.bot =
      dependencies.telegraf ??
      new Telegraf<TelegramContext>(process.env.TELEGRAM_BOT_TOKEN!)

    const redisClient = dependencies.redis ?? getRedisClient()

    this.agentService =
      dependencies.agentService ??
      new AgentService({
        redis: redisClient,
        agentModel: models.agentModel,
        summarizerModel: models.summarizerModel,
        supportsVision: models.supportsVision,
        supportsWebSearch: models.supportsWebSearch,
        tools: dependencies.tools ?? [],
        systemPrompt: models.chatSystemPrompt,
      })
    this.chatSubscriptionStore =
      dependencies.chatSubscriptionStore ??
      new ChatSubscriptionStore(redisClient)
    this.newsQueryService = dependencies.newsQueryService ?? null

    this.bot.use(async (ctx, next) => {
      const scope = getContextChatScope(ctx)

      if (!scope) {
        throw new Error('Chat type not supported')
      }

      ctx.chatType = scope.chatType
      ctx.chatScope = scope.chatScope

      const whitelistedUsers = this.config.telegram.whitelistedUsers
      const privateChat = ctx.chat?.type === 'private' ? ctx.chat : null

      if (
        privateChat &&
        (!privateChat.username ||
          (whitelistedUsers.length > 0 &&
            !whitelistedUsers.includes(privateChat.username)))
      ) {
        try {
          await ctx.reply('Forbidden: username is not whitelisted')
        } catch (error) {
          const telegramError = error as {
            response?: { error_code?: number; description?: string }
          }
          const errorCode = telegramError.response?.error_code
          const errorDescription = telegramError.response?.description

          if (errorCode === 403) {
            logger.warn(
              { chatId: privateChat.id, errorDescription },
              'Blocked or inaccessible user tried to contact the bot'
            )
          } else {
            logger.error(
              { error, chatId: privateChat.id },
              'Failed to send whitelist rejection message'
            )
          }
        }
        return
      }

      ctx.isMention = this.isMentioned(ctx)
      ctx.parsedMessageText = this.getParsedMessageText(ctx)

      logger.trace(
        {
          message: ctx.message,
          update: ctx.update,
          updateType: ctx.updateType,
          chatType: ctx.chatType,
          chatScope: ctx.chatScope,
          isMention: ctx.isMention,
          parsedMessageText: ctx.parsedMessageText,
        },
        'Middleware call'
      )

      return next()
    })

    this.buildCommands()

    this.bot.on(message('text'), async (ctx) => {
      if (!ctx.message.text.trim()) {
        return ctx.reply('/help')
      }

      const isCommand =
        ctx.message.entities?.find(
          (entity: MessageEntity) => entity.type === 'bot_command'
        )?.offset === 0

      if (isCommand) {
        return ctx.reply('Unknown command. /help')
      }

      await this.handleIncomingMessage(ctx)
    })

    this.bot.on(message('photo'), async (ctx) => {
      await this.handleIncomingMessage(ctx)
    })

    this.bot.on('inline_query', async (ctx) => {
      await ctx.answerInlineQuery([])
    })

    process.once('SIGINT', () => this.gracefulShutdown('SIGINT'))
    process.once('SIGTERM', () => this.gracefulShutdown('SIGTERM'))
    process.on('uncaughtException', (error) => {
      logger.error({ error }, 'Uncaught exception - shutting down')
      this.gracefulShutdown('uncaughtException')
    })
    process.on('unhandledRejection', (reason) => {
      logger.error({ reason }, 'Unhandled rejection')
    })
  }

  async init() {
    await this.bot.telegram.setMyCommands(this.registeredCommands)
    await this.agentService?.initialize()

    // Start bot in background - launch() blocks until shutdown
    this.bot
      .launch(() => {
        logger.info({ config: this.config }, 'Telegram bot is up and running')
      })
      .catch((error: any) => {
        if (error?.response?.error_code === 409) {
          logger.error(
            { error: error.message },
            'Another bot instance is already running (409 Conflict). Kill all node processes and try again.'
          )
          throw new Error(
            'Telegram bot 409 Conflict: Another instance is already running. Run: pkill -f "ai-telegram-assistant-bot.*tsx" && sleep 2'
          )
        }
        throw error
      })
  }

  private gracefulShutdown(signal: string): void {
    logger.info({ signal }, 'Shutting down bot gracefully...')
    this.bot.stop(signal)
    process.exit(0)
  }

  async sendNewsArticle(
    chatId: string,
    article: BotNewsArticle
  ): Promise<void> {
    const lines = [
      `<b>${escapeHtml(article.title)}</b>`,
      createHtmlLink('Read more', article.url),
      `\nRelevance score: ${article.relevanceScore}`,
    ]

    if (article.description && article.description.split(/\s+/).length > 1) {
      lines.splice(2, 0, escapeHtml(article.description))
    }

    const logContext = {
      event: 'news.telegram.send.start',
      chatId,
      articleId: article.articleId,
      articleTitle: article.title,
      articleUrl: article.url,
      score: article.relevanceScore,
    }

    logger.debug(logContext, 'Starting Telegram news delivery')

    try {
      await this.bot.telegram.sendMessage(chatId, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: {
          is_disabled: false,
        },
      })

      logger.debug(
        {
          ...logContext,
          event: 'news.telegram.send.success',
        },
        'Telegram news delivery succeeded'
      )
    } catch (error) {
      const telegramError = error as {
        response?: { error_code?: number; description?: string }
      }
      const errorCode = telegramError.response?.error_code
      const errorDescription = telegramError.response?.description

      const isChatDeleted =
        errorCode === 403 &&
        (errorDescription?.includes('group chat was deleted') ||
          errorDescription?.includes('the group chat was deleted') ||
          errorDescription?.includes('bot was kicked') ||
          errorDescription?.includes('bot is not a member') ||
          errorDescription?.includes('bot was blocked by the user'))

      if (isChatDeleted) {
        logger.warn(
          {
            ...logContext,
            event: 'news.telegram.send.chat_deleted',
            errorCode,
            errorDescription,
          },
          'Chat no longer accessible, removing subscription'
        )

        await this.chatSubscriptionStore.deleteSubscription(chatId)

        logger.info(
          {
            ...logContext,
            event: 'news.telegram.send.subscription_removed',
          },
          'Removed news subscription for deleted/inaccessible chat'
        )

        return
      }

      logger.error(
        {
          ...logContext,
          event: 'news.telegram.send.error',
          err: error,
        },
        'Telegram news delivery failed'
      )
      throw error
    }
  }

  private buildCommands() {
    const commands: Record<string, BotCommandHandler> = {
      help: async (ctx) => {
        await ctx.reply(await this.buildHelpMessage(ctx))
      },
      abort: async (ctx) => {
        await ctx.reply('No interactive operation is running.')
      },
      clear: async (ctx) => {
        await this.agentService?.clearHistory(ctx.chatScope)
        await ctx.reply('Chat history deleted. Starting a new chat...')
      },
      info: async (ctx) => {
        await ctx.reply(await this.buildInfoMessage(ctx))
      },
      debugnews: async (ctx) => {
        if (!this.newsQueryService) {
          await ctx.reply('News service not configured')
          return
        }
        try {
          await ctx.sendChatAction('typing')
          const raw = await this.newsQueryService.getRecentNewsRaw(10)
          const lines = [
            `<b>Debug News Info</b>`,
            ``,
            `Total articles in store: ${raw.length}`,
            ``,
          ]
          if (raw.length > 0) {
            lines.push(`Latest articles (no filter):`)
            raw.slice(0, 5).forEach((a, i) => {
              lines.push(`${i + 1}. ${escapeHtml(a.title)}`)
              lines.push(
                `   Score: ${a.relevanceScore ?? 'unscored'} | Source: ${escapeHtml(a.source)}`
              )
            })
          } else {
            lines.push(
              `No articles found. The news scheduler may not be running or feeds are empty.`
            )
          }
          await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
        } catch (error) {
          logger.error({ error }, 'Debug news command failed')
          await ctx.reply('Error: ' + String(error))
        }
      },
      news: async (ctx) => {
        if (!this.newsQueryService) {
          await ctx.reply(
            'News retrieval is not configured. Please try again later.'
          )
          return
        }

        const args = this.getCommandArguments(ctx)
        let count = 5

        if (args) {
          const parsedCount = Number(args)
          if (
            !Number.isInteger(parsedCount) ||
            parsedCount < 1 ||
            parsedCount > 10
          ) {
            await ctx.reply(
              'Please specify a number between 1 and 10. Example: /news 5'
            )
            return
          }
          count = parsedCount
        }

        try {
          await ctx.sendChatAction('typing')
          const chatId = this.getSubscriptionChatId(ctx)
          const topics = await this.chatSubscriptionStore.getTopics(
            chatId,
            this.config.news.topics
          )
          const articles =
            await this.newsQueryService.fetchAndGetRecentNewsForChat(
              count,
              topics
            )

          if (articles.length === 0) {
            await ctx.reply(
              "I don't have any relevant news articles right now for your topics. News is collected periodically from configured sources. Try again in a few minutes!"
            )
            return
          }

          const header = `<b>📰 Recent AI News (${articles.length} article${articles.length === 1 ? '' : 's'})</b>\n`
          const formatted = formatNewsArticles(articles as NewsArticle[], {
            mode: 'html',
            includeDescription: true,
            descriptionMaxLength: 200,
            includeRelevance: true,
            includeDate: true,
            numbered: true,
          })

          await ctx.reply(header + formatted, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          })
        } catch (error) {
          logger.error(
            { error, chatId: ctx.chat?.id },
            'Failed to retrieve news'
          )
          await ctx.reply(
            "Sorry, I couldn't retrieve news right now. Please try again later."
          )
        }
      },
      subscribe: async (ctx) => {
        if (!(await this.ensureSubscriptionCommandAccess(ctx, 'subscribe'))) {
          return
        }

        const subscription = await this.chatSubscriptionStore.subscribe(
          this.getSubscriptionChatId(ctx)
        )

        await ctx.reply(
          this.buildSubscriptionMutationMessage(
            'News subscription enabled.',
            subscription
          )
        )
      },
      unsubscribe: async (ctx) => {
        if (!(await this.ensureSubscriptionCommandAccess(ctx, 'unsubscribe'))) {
          return
        }

        const subscription = await this.chatSubscriptionStore.unsubscribe(
          this.getSubscriptionChatId(ctx)
        )

        await ctx.reply(
          this.buildSubscriptionMutationMessage(
            'News subscription disabled.',
            subscription
          )
        )
      },
      interval: async (ctx) => {
        if (!(await this.ensureSubscriptionCommandAccess(ctx, 'interval'))) {
          return
        }

        const args = this.getCommandArguments(ctx)

        if (!args) {
          const subscription = await this.getSubscriptionStatus(
            this.getSubscriptionChatId(ctx)
          )

          await ctx.reply(
            [
              `Current news interval: ${this.getSubscriptionIntervalSeconds(subscription)} seconds.`,
              `Subscription status: ${this.getSubscriptionEnabledLabel(subscription)}.`,
              `Use /interval <seconds> to change it (${minNewsIntervalSeconds}-${maxNewsIntervalSeconds}).`,
            ].join('\n')
          )
          return
        }

        const intervalSeconds = Number(args)

        if (!Number.isInteger(intervalSeconds)) {
          await ctx.reply(
            `News interval must be an integer between ${minNewsIntervalSeconds} and ${maxNewsIntervalSeconds} seconds.`
          )
          return
        }

        try {
          const subscription =
            await this.chatSubscriptionStore.setIntervalSeconds(
              this.getSubscriptionChatId(ctx),
              intervalSeconds
            )

          await ctx.reply(
            this.buildSubscriptionMutationMessage(
              `News interval updated to ${subscription.intervalSeconds} seconds.`,
              subscription
            )
          )
        } catch (error) {
          await ctx.reply(
            error instanceof Error
              ? error.message
              : 'Failed to update the news interval.'
          )
        }
      },
      topics: async (ctx) => {
        if (!(await this.ensureSubscriptionCommandAccess(ctx, 'topics'))) {
          return
        }

        const args = this.getCommandArguments(ctx)
        const chatId = this.getSubscriptionChatId(ctx)

        if (!args) {
          const subscription = await this.getSubscriptionStatus(chatId)
          const currentTopics = subscription?.topics?.length
            ? formatTopics(subscription.topics)
            : formatTopics(this.config.news.topics)

          await ctx.reply(
            [
              `Current topics: ${currentTopics}`,
              `Use /topics <comma-separated list> to customize.`,
              `Example: /topics AI, developer tools, automation`,
            ].join('\n')
          )
          return
        }

        const normalizedTopics = normalizeTopics(args)

        if (normalizedTopics.length === 0) {
          await ctx.reply(
            'Please provide at least one topic. Example: /topics AI, developer tools'
          )
          return
        }

        const subscription = await this.chatSubscriptionStore.setTopics(
          chatId,
          normalizedTopics
        )

        await ctx.reply(
          this.buildSubscriptionMutationMessage(
            `Topics updated to: ${formatTopics(normalizedTopics)}`,
            subscription
          )
        )
      },
      summary: async (ctx) => {
        if (!this.newsQueryService) {
          await ctx.reply(
            'News retrieval is not configured. Please try again later.'
          )
          return
        }

        try {
          await ctx.sendChatAction('typing')
          const chatId = this.getSubscriptionChatId(ctx)
          const topics = await this.chatSubscriptionStore.getTopics(
            chatId,
            this.config.news.topics
          )
          const articles =
            await this.newsQueryService.getRecentNewsLast24HoursForChat(
              10,
              topics
            )

          if (articles.length === 0) {
            await ctx.reply(
              "I don't have any news articles from the last 24 hours matching your topics. News is collected periodically from configured sources. Try again later!"
            )
            return
          }

          const newsContext = formatNewsArticles(articles as NewsArticle[], {
            mode: 'plain',
            includeDescription: true,
            descriptionMaxLength: 0,
            includeRelevance: true,
            includeDate: false,
            numbered: true,
          })

          const prompt = `Summarize the most relevant and important news from the following articles collected in the last 24 hours. Focus on the key developments and trends. Present your summary in a clear, concise format highlighting the most significant items:\n\n${newsContext}`

          const response = await this.agentService?.invokeLive(ctx.chatScope, {
            text: prompt,
          })

          await ctx.reply(
            formatTelegramMarkdownReply(
              response || 'Sorry, I could not generate a summary at this time.'
            ),
            {
              parse_mode: 'Markdown',
            }
          )
        } catch (error) {
          logger.error(
            { error, chatId: ctx.chat?.id },
            'Failed to generate news summary'
          )
          await ctx.reply(
            "Sorry, I couldn't generate a summary right now. Please try again later."
          )
        }
      },
    }

    this.bot.start(async (ctx) => {
      await ctx.reply(await this.buildStartMessage(ctx))
    })

    Object.entries(commands).forEach(([cmd, handler]) => {
      this.bot.command(cmd, handler)
    })
  }

  private async handleAgentTextCompletion(ctx: TelegramContext): Promise<void> {
    if (!this.agentService) {
      return
    }

    const normalizedMessage = await this.normalizeIncomingMessage(ctx)

    if (!normalizedMessage) {
      return
    }

    if (!normalizedMessage.shouldInvoke) {
      await this.agentService.persistUserMessage(
        ctx.chatScope,
        normalizedMessage
      )
      return
    }

    if (normalizedMessage.imageUrl && !this.agentService.supportsImageInput()) {
      await this.agentService.persistUserMessage(
        ctx.chatScope,
        normalizedMessage
      )
      await ctx.reply(
        "This bot's main model cannot inspect images yet. I saved your message context, but I cannot answer about the attached image right now."
      )
      return
    }

    await ctx.sendChatAction(
      normalizedMessage.imageUrl ? 'upload_photo' : 'typing'
    )

    try {
      const response = await this.agentService.invokeLive(
        ctx.chatScope,
        normalizedMessage
      )
      await ctx.reply(formatTelegramMarkdownReply(response), {
        parse_mode: 'Markdown',
      })
    } catch (error) {
      logger.error(
        { error, chatScope: ctx.chatScope },
        'Agent completion error'
      )
      await ctx.reply('Sorry, I encountered an error. Please try again.')
    }
  }

  private async handleIncomingMessage(
    ctx: MessageContext | PhotoMessageContext
  ): Promise<void> {
    await this.handleAgentTextCompletion(ctx)
  }

  private getParsedMessageText(ctx: TelegramContext): string | undefined {
    if (ctx.updateType !== 'message' || !ctx.message) {
      return undefined
    }

    const rawMessageText = this.getRawMessageText(ctx)

    if (!rawMessageText) {
      return undefined
    }

    const withoutCommand = this.stripLeadingCommand(
      rawMessageText,
      this.getMessageEntities(ctx)
    )
    const normalizedText = this.stripExplicitBotMentions(withoutCommand)

    if (!normalizedText) {
      return undefined
    }

    if (ctx.chatType !== 'group') {
      return normalizedText
    }

    const userName =
      ctx.message.from.first_name ?? ctx.message.from.username ?? 'User'

    return `${userName}: ${normalizedText}`
  }

  private getRawMessageText(ctx: TelegramContext): string {
    if (ctx.updateType !== 'message' || !ctx.message) {
      return ''
    }

    if ('text' in ctx.message && typeof ctx.message.text === 'string') {
      return ctx.message.text.trim()
    }

    if ('caption' in ctx.message && typeof ctx.message.caption === 'string') {
      return ctx.message.caption.trim()
    }

    return ''
  }

  private getMessageEntities(ctx: TelegramContext): MessageEntity[] {
    if (ctx.updateType !== 'message' || !ctx.message) {
      return []
    }

    if ('entities' in ctx.message && Array.isArray(ctx.message.entities)) {
      return ctx.message.entities
    }

    if (
      'caption_entities' in ctx.message &&
      Array.isArray(ctx.message.caption_entities)
    ) {
      return ctx.message.caption_entities
    }

    return []
  }

  private isMentioned(ctx: TelegramContext): boolean {
    const rawMessageText = this.getRawMessageText(ctx)

    if (!rawMessageText || ctx.chatType !== 'group') {
      return false
    }

    const expectedMention = `@${this.config.telegram.botUsername}`

    return this.getMessageEntities(ctx).some(
      (entity) =>
        entity.type === 'mention' &&
        rawMessageText.substring(
          entity.offset,
          entity.offset + entity.length
        ) === expectedMention
    )
  }

  private stripLeadingCommand(text: string, entities: MessageEntity[]): string {
    const commandEntity = entities.find(
      (item) => item.type === 'bot_command' && item.offset === 0
    )

    return commandEntity ? text.substring(commandEntity.length).trim() : text
  }

  private stripExplicitBotMentions(text: string): string {
    if (!this.config.telegram.botUsername) {
      return text.trim()
    }

    const escapedBotUsername = this.config.telegram.botUsername.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    )

    return text
      .replace(new RegExp(`@${escapedBotUsername}`, 'g'), ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private async normalizeIncomingMessage(
    ctx: TelegramContext
  ): Promise<NormalizedTelegramIngress | null> {
    if (ctx.updateType !== 'message' || !ctx.message) {
      return null
    }

    const text = ctx.parsedMessageText?.trim() ?? ''
    const shouldInvoke = ctx.chatType === 'private' || ctx.isMention

    if ('photo' in ctx.message && Array.isArray(ctx.message.photo)) {
      const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1]

      if (!largestPhoto) {
        return text ? { text, shouldInvoke } : null
      }

      const imageUrl = (
        await ctx.telegram.getFileLink(largestPhoto.file_id)
      ).toString()

      return {
        text,
        imageUrl,
        shouldInvoke,
      }
    }

    if (!text) {
      return null
    }

    return {
      text,
      shouldInvoke,
    }
  }

  private async buildStartMessage(ctx: TelegramContext): Promise<string> {
    const subscription = await this.getSubscriptionStatus(
      this.getSubscriptionChatId(ctx)
    )

    return [
      'The bot is ready.',
      this.getIngressSummary(ctx),
      this.getSubscriptionSummary(subscription),
      'Use /help for the operational command list.',
    ].join('\n\n')
  }

  private async buildHelpMessage(ctx: TelegramContext): Promise<string> {
    const subscription = await this.getSubscriptionStatus(
      this.getSubscriptionChatId(ctx)
    )
    const adminScopeNote =
      ctx.chatType === 'group'
        ? 'In groups, /subscribe, /unsubscribe, /interval, and /topics require an admin.'
        : 'In private chats, /subscribe, /unsubscribe, /interval, and /topics are self-service.'

    return [
      'Operational commands:',
      '/start - show a quick overview for this chat',
      '/help - show commands, ingress behavior, and news status',
      '/abort - abort the current interactive operation',
      '/clear - clear stored conversation history for this chat scope',
      '/info - show chat scope and subscription details',
      '/news [count] - get recent news (1-10 articles, default: 5)',
      '/summary - summarize the most relevant news from the last 24 hours',
      '/subscribe - enable relevant news delivery for this chat',
      '/unsubscribe - disable relevant news delivery for this chat',
      `/interval [seconds] - show or set the news cadence (${minNewsIntervalSeconds}-${maxNewsIntervalSeconds})`,
      '/topics [list] - show or set news topics (comma-separated)',
      '',
      this.getIngressSummary(ctx),
      adminScopeNote,
      this.getSubscriptionSummary(subscription),
    ].join('\n')
  }

  private async buildInfoMessage(ctx: TelegramContext): Promise<string> {
    const subscription = await this.getSubscriptionStatus(
      this.getSubscriptionChatId(ctx)
    )

    return [
      `Chat scope: ${ctx.chatScope}`,
      `Chat type: ${ctx.chatType}`,
      this.getIngressSummary(ctx),
      this.getSubscriptionSummary(subscription),
      `Interval limits: ${minNewsIntervalSeconds}-${maxNewsIntervalSeconds} seconds.`,
    ].join('\n')
  }

  private getIngressSummary(ctx: TelegramContext): string {
    return ctx.chatType === 'private'
      ? 'Ingress: private chats invoke the agent directly on each text or photo message.'
      : 'Ingress: group text and photo messages are persisted for shared memory, and the agent only replies when the bot is explicitly mentioned.'
  }

  private getSubscriptionSummary(
    subscription: NewsChatSubscription | null
  ): string {
    return [
      `News subscription: ${this.getSubscriptionEnabledLabel(subscription)}.`,
      `News interval: ${this.getSubscriptionIntervalSeconds(subscription)} seconds.`,
    ].join('\n')
  }

  private buildSubscriptionMutationMessage(
    heading: string,
    subscription: NewsChatSubscription
  ): string {
    return [heading, this.getSubscriptionSummary(subscription)].join('\n')
  }

  private async ensureSubscriptionCommandAccess(
    ctx: TelegramContext,
    command: 'subscribe' | 'unsubscribe' | 'interval' | 'topics'
  ): Promise<boolean> {
    if (ctx.chatType === 'private') {
      return true
    }

    const chatId = ctx.chat?.id
    const userId = ctx.from?.id

    if (chatId === undefined || userId === undefined) {
      await ctx.reply(`Only group admins can use /${command} in groups.`)
      return false
    }

    try {
      const member = await ctx.telegram.getChatMember(chatId, userId)

      if (member.status === 'administrator' || member.status === 'creator') {
        return true
      }
    } catch (error) {
      logger.warn(
        { error, chatId, userId, command },
        'Failed to verify Telegram admin access'
      )
      await ctx.reply(
        `I could not verify admin access for /${command}. Please try again.`
      )
      return false
    }

    await ctx.reply(`Only group admins can use /${command} in groups.`)
    return false
  }

  private getSubscriptionChatId(ctx: TelegramContext): string {
    return String(ctx.chat?.id)
  }

  private async getSubscriptionStatus(
    chatId: string
  ): Promise<NewsChatSubscription | null> {
    return await this.chatSubscriptionStore.getSubscription(chatId)
  }

  private getSubscriptionEnabledLabel(
    subscription: NewsChatSubscription | null
  ): 'enabled' | 'disabled' {
    return subscription?.enabled ? 'enabled' : 'disabled'
  }

  private getSubscriptionIntervalSeconds(
    subscription: NewsChatSubscription | null
  ): number {
    return subscription?.intervalSeconds ?? defaultNewsIntervalSeconds
  }

  private getCommandArguments(ctx: TelegramContext): string {
    return this.stripExplicitBotMentions(
      this.stripLeadingCommand(
        this.getRawMessageText(ctx),
        this.getMessageEntities(ctx)
      )
    )
  }

  private async getRecentNewsLast24Hours(
    maxCount: number
  ): Promise<RecentNewsItem[]> {
    if (!this.newsQueryService) {
      return []
    }

    const redis = (this.newsQueryService as any).redis as Redis
    const keyPrefix = 'news:'
    const now = Date.now()
    const oneDayAgo = now - 24 * 60 * 60 * 1000

    const ids = await redis.zrevrangebyscore(
      `${keyPrefix}items`,
      '+inf',
      oneDayAgo
    )

    const items: RecentNewsItem[] = []
    for (const id of ids.slice(0, maxCount)) {
      const data = await redis.get(`${keyPrefix}item:${id}`)
      if (!data) continue

      const item = JSON.parse(data) as Omit<
        NewsItem,
        'publishedAt' | 'fetchedAt' | 'legacyBroadcastedAt'
      > & {
        publishedAt: string
        fetchedAt: string
        legacyBroadcastedAt?: string
      }

      items.push({
        id: item.id,
        title: item.title,
        url: item.url,
        source: item.source,
        publishedAt: new Date(item.publishedAt),
        fetchedAt: new Date(item.fetchedAt),
        relevanceScore: item.relevanceScore,
        description: item.description,
      })
    }

    return items
  }
}
