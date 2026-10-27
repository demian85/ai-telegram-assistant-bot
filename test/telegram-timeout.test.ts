import { Telegraf } from 'telegraf'
import { afterEach, expect, test, vi } from 'vitest'
import { Bot } from '../src/lib/telegram/index.js'
import type { TelegramContext, Update } from '../src/lib/telegram/types.js'
import { InMemoryRedis } from './test-helpers.js'

const listeners = {
  uncaughtException: new Set(process.listeners('uncaughtException')),
  unhandledRejection: new Set(process.listeners('unhandledRejection')),
  SIGINT: new Set(process.listeners('SIGINT')),
  SIGTERM: new Set(process.listeners('SIGTERM')),
}
afterEach(() => {
  for (const listener of process.listeners('uncaughtException'))
    if (!listeners.uncaughtException.has(listener))
      process.removeListener('uncaughtException', listener)
  for (const listener of process.listeners('unhandledRejection'))
    if (!listeners.unhandledRejection.has(listener))
      process.removeListener('unhandledRejection', listener)
  for (const listener of process.listeners('SIGINT'))
    if (!listeners.SIGINT.has(listener))
      process.removeListener('SIGINT', listener)
  for (const listener of process.listeners('SIGTERM'))
    if (!listeners.SIGTERM.has(listener))
      process.removeListener('SIGTERM', listener)
  vi.restoreAllMocks()
})

test.each(['private', 'group'] as const)(
  'handles a real Telegraf %s timeout without unsolicited replies and processes the next update',
  async (chatType) => {
    const telegraf = new Telegraf<TelegramContext>('offline', {
      handlerTimeout: 20,
    })
    telegraf.botInfo = {
      id: 42,
      is_bot: true,
      first_name: 'Bot',
      username: 'bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    }
    const reply = vi.fn().mockResolvedValue({})
    telegraf.context.reply = reply
    telegraf.context.sendChatAction = vi.fn().mockResolvedValue(true)
    const never = new Promise<string>(() => {})
    const invokeLive = vi.fn().mockResolvedValue('Still running')
    if (chatType === 'private') invokeLive.mockReturnValueOnce(never)
    const persistUserMessage = vi.fn().mockReturnValue(never)
    const sendRichMessage = vi.fn().mockResolvedValue({})
    new Bot(
      {
        telegram: {
          botUsername: 'bot',
          whitelistedUsers: [],
          allowedGroupIds: ['-100'],
        },
        news: { defaultFilter: 'AI', relevanceThreshold: 70 },
      },
      {
        agentModel: {} as never,
        summarizerModel: {} as never,
        supportsVision: false,
        chatSystemPrompts: { private: 'private', group: 'group' },
        summarizerSystemPrompt: '{{period}}',
      },
      {
        telegraf,
        redis: new InMemoryRedis().asRedis(),
        richMessageApi: { sendRichMessage },
        agentService: { invokeLive, persistUserMessage } as never,
      }
    )
    const update: Update.MessageUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 1, is_bot: false, first_name: 'Dem', username: 'dem' },
        chat:
          chatType === 'private'
            ? { id: 1, type: 'private', first_name: 'Dem', username: 'dem' }
            : { id: -100, type: 'group', title: 'Group' },
        date: 0,
        text: 'show me top trending news from x',
      },
    }

    await expect(telegraf.handleUpdate(update)).resolves.toBeUndefined()
    if (chatType === 'private')
      expect(reply).toHaveBeenCalledWith(
        expect.stringContaining('took too long'),
        undefined
      )
    else expect(reply).not.toHaveBeenCalled()
    await telegraf.handleUpdate({
      ...update,
      update_id: 2,
      message: {
        ...update.message,
        chat: { id: 1, type: 'private', first_name: 'Dem', username: 'dem' },
        message_id: 2,
        text: 'hello',
      },
    })

    expect(invokeLive).toHaveBeenCalledTimes(chatType === 'private' ? 2 : 1)
    expect(sendRichMessage).toHaveBeenCalledOnce()
  }
)
