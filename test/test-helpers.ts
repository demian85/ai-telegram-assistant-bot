import logger from '../src/lib/logger.js'

type SortedSetEntry = {
  member: string
  score: number
}

export type CapturedLogRecord = {
  level: 'debug' | 'info' | 'warn' | 'error'
  context: Record<string, unknown>
  message?: string
}

export class InMemoryRedis {
  private readonly values = new Map<string, string>()
  private readonly lists = new Map<string, string[]>()
  private readonly sets = new Map<string, Set<string>>()
  private readonly sortedSets = new Map<string, SortedSetEntry[]>()

  asRedis<T>(): T {
    return this as unknown as T
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async set(key: string, value: string, mode?: 'NX'): Promise<'OK' | null> {
    if (mode === 'NX' && this.values.has(key)) return null
    this.values.set(key, value)
    return 'OK'
  }

  async setex(key: string, _ttlSeconds: number, value: string): Promise<'OK'> {
    await this.set(key, value)
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0

    for (const key of keys) {
      deleted += Number(this.values.delete(key))
      deleted += Number(this.lists.delete(key))
      deleted += Number(this.sets.delete(key))
      deleted += Number(this.sortedSets.delete(key))
    }

    return deleted
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>()
    let added = 0

    for (const member of members) {
      const sizeBefore = set.size
      set.add(member)
      if (set.size > sizeBefore) {
        added += 1
      }
    }

    this.sets.set(key, set)

    return added
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []).sort()
  }

  async lpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? []
    list.unshift(value)
    this.lists.set(key, list)
    return list.length
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? []
    const normalizedStop = stop < 0 ? list.length + stop + 1 : stop + 1
    return list.slice(start, normalizedStop)
  }

  async llen(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const entries = this.sortedSets.get(key) ?? []
    const existing = entries.find((entry) => entry.member === member)

    if (existing) {
      existing.score = score
    } else {
      entries.push({ member, score })
    }

    this.sortedSets.set(key, entries)

    return 1
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const entries = this.getSortedEntries(key)
    return this.sliceEntries(entries, start, stop).map((entry) => entry.member)
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    const entries = this.getSortedEntries(key).reverse()
    return this.sliceEntries(entries, start, stop).map((entry) => entry.member)
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<string[]> {
    const minVal = min === '-inf' ? -Infinity : Number(min)
    const maxVal = max === '+inf' ? Infinity : Number(max)
    return this.getSortedEntries(key)
      .filter((entry) => entry.score >= minVal && entry.score <= maxVal)
      .map((entry) => entry.member)
  }

  async zrem(key: string, member: string): Promise<number> {
    const entries = this.sortedSets.get(key) ?? []
    const nextEntries = entries.filter((entry) => entry.member !== member)

    this.sortedSets.set(key, nextEntries)

    return entries.length - nextEntries.length
  }

  async disconnect(): Promise<void> {}

  private getSortedEntries(key: string): SortedSetEntry[] {
    return [...(this.sortedSets.get(key) ?? [])].sort(
      (left, right) =>
        left.score - right.score || left.member.localeCompare(right.member)
    )
  }

  private sliceEntries(
    entries: SortedSetEntry[],
    start: number,
    stop: number
  ): SortedSetEntry[] {
    const normalizedStop = stop < 0 ? entries.length + stop + 1 : stop + 1
    return entries.slice(start, normalizedStop)
  }
}

type TestReply = {
  text: string
  extra?: Record<string, unknown>
}

type TestMessage = {
  message_id: number
  date: number
  chat: {
    id: number
    type: 'private' | 'group' | 'supergroup'
    username?: string
    title?: string
  }
  from: {
    id: number
    is_bot: boolean
    first_name?: string
    username?: string
  }
  text?: string
  caption?: string
  entities?: Array<{ type: string; offset: number; length: number }>
  caption_entities?: Array<{ type: string; offset: number; length: number }>
  photo?: Array<{
    file_id: string
    file_unique_id: string
    width: number
    height: number
  }>
}

type TestUpdate = {
  update_id: number
  message?: TestMessage
  inline_query?: {
    id: string
    from: TestMessage['from']
    query: string
    offset: string
  }
}

type TestContext = {
  update: TestUpdate
  updateType: string
  message?: TestMessage
  chat?: TestMessage['chat']
  from?: TestMessage['from']
  telegram: FakeTelegraf['telegram']
  replyLog: TestReply[]
  chatActions: string[]
  inlineQueryAnswers: unknown[]
  reply(text: string, extra?: Record<string, unknown>): Promise<TestReply>
  sendChatAction(action: string): Promise<void>
  answerInlineQuery(results: unknown[]): Promise<void>
  [key: string]: unknown
}

type Middleware = (
  ctx: TestContext,
  next: () => Promise<void>
) => Promise<unknown> | unknown

type Handler = (ctx: TestContext) => Promise<unknown> | unknown

export class FakeTelegraf {
  readonly sentMessages: Array<{
    chatId: string
    text: string
    extra?: Record<string, unknown>
  }> = []

  readonly telegram = {
    setMyCommands: async () => undefined,
    getFileLink: async (fileId: string) =>
      new URL(`https://files.test/${fileId}`),
    sendMessage: async (
      chatId: string,
      text: string,
      extra?: Record<string, unknown>
    ) => {
      this.sentMessages.push({ chatId, text, extra })
    },
    getChatMember: async () => ({ status: 'member' }),
  }

  private readonly middlewares: Middleware[] = []
  private startHandler: Handler | null = null
  private readonly commandHandlers = new Map<string, Handler>()
  private textHandler: Handler | null = null
  private photoHandler: Handler | null = null
  private inlineQueryHandler: Handler | null = null

  use(middleware: Middleware): void {
    this.middlewares.push(middleware)
  }

  on(_filter: unknown, handler: Handler): void {
    if (!this.textHandler) {
      this.textHandler = handler
      return
    }

    if (!this.photoHandler) {
      this.photoHandler = handler
      return
    }

    this.inlineQueryHandler = handler
  }

  start(handler: Handler): void {
    this.startHandler = handler
  }

  command(command: string, handler: Handler): void {
    this.commandHandlers.set(command, handler)
  }

  async launch(callback?: () => void): Promise<void> {
    callback?.()
  }

  stop(): void {}

  async dispatch(update: TestUpdate): Promise<TestContext> {
    const ctx: TestContext = {
      update,
      updateType: update.inline_query
        ? 'inline_query'
        : update.message
          ? 'message'
          : 'unknown',
      message: update.message,
      chat: update.message?.chat,
      from: update.message?.from ?? update.inline_query?.from,
      telegram: this.telegram,
      replyLog: [],
      chatActions: [],
      inlineQueryAnswers: [],
      reply: async (text: string, extra?: Record<string, unknown>) => {
        const reply = { text, extra }
        ctx.replyLog.push(reply)
        return reply
      },
      sendChatAction: async (action: string) => {
        ctx.chatActions.push(action)
      },
      answerInlineQuery: async (results: unknown[]) => {
        ctx.inlineQueryAnswers = results
      },
    }

    await this.runMiddlewares(ctx, 0)

    return ctx
  }

  private async runMiddlewares(ctx: TestContext, index: number): Promise<void> {
    const middleware = this.middlewares[index]

    if (!middleware) {
      await this.dispatchHandler(ctx)
      return
    }

    await middleware(ctx, async () => {
      await this.runMiddlewares(ctx, index + 1)
    })
  }

  private async dispatchHandler(ctx: TestContext): Promise<void> {
    if (ctx.updateType === 'inline_query') {
      await this.inlineQueryHandler?.(ctx)
      return
    }

    const text = ctx.message?.text ?? ctx.message?.caption ?? ''
    const command = this.extractCommand(text)

    if (command === 'start') {
      await this.startHandler?.(ctx)
      return
    }

    if (command) {
      await this.commandHandlers.get(command)?.(ctx)
      return
    }

    if (ctx.message?.photo) {
      await this.photoHandler?.(ctx)
      return
    }

    if (typeof ctx.message?.text === 'string') {
      await this.textHandler?.(ctx)
    }
  }

  private extractCommand(text: string): string | null {
    if (!text.startsWith('/')) {
      return null
    }

    const command = text.slice(1).split(/[\s@]/, 1)[0]
    return command || null
  }
}

export function createNoopQueue() {
  return {
    add: async () => undefined,
    close: async () => undefined,
  }
}

export function createNoopWorker() {
  return {
    close: async () => undefined,
  }
}

function normalizeLogCall(args: unknown[]): {
  context: Record<string, unknown>
  message?: string
} {
  let context: Record<string, unknown> = {}
  let message: string | undefined

  if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    context = args[0] as Record<string, unknown>
  } else if (typeof args[0] === 'string') {
    message = args[0]
  }

  if (typeof args[1] === 'string') {
    message = args[1]
  }

  return { context, message }
}

export async function captureLoggerRecords<T>(
  run: () => Promise<T> | T
): Promise<{ result: T; records: CapturedLogRecord[] }> {
  const levels = ['debug', 'info', 'warn', 'error'] as const
  const records: CapturedLogRecord[] = []
  const originals = new Map<
    (typeof levels)[number],
    | typeof logger.debug
    | typeof logger.info
    | typeof logger.warn
    | typeof logger.error
  >()

  for (const level of levels) {
    originals.set(level, logger[level])
    ;(logger as unknown as Record<string, unknown>)[level] = (
      ...args: unknown[]
    ) => {
      const { context, message } = normalizeLogCall(args)
      records.push({ level, context, message })
    }
  }

  try {
    const result = await run()
    return { result, records }
  } finally {
    for (const level of levels) {
      ;(logger as unknown as Record<string, unknown>)[level] =
        originals.get(level)
    }
  }
}

export function createTextUpdate(input: {
  updateId?: number
  messageId?: number
  chatId: number
  chatType: 'private' | 'group' | 'supergroup'
  username?: string
  firstName?: string
  text: string
  entities?: Array<{ type: string; offset: number; length: number }>
}): TestUpdate {
  return {
    update_id: input.updateId ?? 1,
    message: {
      message_id: input.messageId ?? 1,
      date: 1,
      chat: {
        id: input.chatId,
        type: input.chatType,
        username: input.username,
      },
      from: {
        id: 1,
        is_bot: false,
        first_name: input.firstName ?? 'Alice',
        username: input.username,
      },
      text: input.text,
      entities:
        input.entities ??
        (input.text.startsWith('/')
          ? [
              {
                type: 'bot_command',
                offset: 0,
                length: input.text.split(/\s/, 1)[0].length,
              },
            ]
          : undefined),
    },
  }
}

export function createPhotoUpdate(input: {
  updateId?: number
  messageId?: number
  chatId: number
  chatType: 'private' | 'group' | 'supergroup'
  username?: string
  firstName?: string
  caption?: string
  captionEntities?: Array<{ type: string; offset: number; length: number }>
  fileIds: string[]
}): TestUpdate {
  return {
    update_id: input.updateId ?? 1,
    message: {
      message_id: input.messageId ?? 1,
      date: 1,
      chat: {
        id: input.chatId,
        type: input.chatType,
        username: input.username,
      },
      from: {
        id: 1,
        is_bot: false,
        first_name: input.firstName ?? 'Alice',
        username: input.username,
      },
      caption: input.caption,
      caption_entities: input.captionEntities,
      photo: input.fileIds.map((fileId, index) => ({
        file_id: fileId,
        file_unique_id: `${fileId}-unique`,
        width: 100 + index,
        height: 100 + index,
      })),
    },
  }
}
