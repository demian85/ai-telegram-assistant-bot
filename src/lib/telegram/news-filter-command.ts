import logger from '@lib/logger.js'
import {
  NewsPreferenceStore,
  preferenceDescriptionSchema,
  type NewsPreferenceGenerator,
} from '@lib/news/preferences.js'
import type { TelegramContext } from './types.js'

export class NewsFilterCommand {
  private readonly pending = new Set<string>()

  constructor(
    private readonly preferences: NewsPreferenceStore,
    private readonly generator?: Pick<NewsPreferenceGenerator, 'generate'>
  ) {}

  async handle(
    ctx: TelegramContext,
    request: { readonly chatId: string; readonly args: string }
  ): Promise<void> {
    const { chatId, args } = request
    if (this.pending.has(chatId)) {
      await ctx.reply(
        'Your news filter is still being updated. Please try again shortly.'
      )
      return
    }
    this.pending.add(chatId)
    try {
      if (!args) {
        const active = await this.preferences.resolve(chatId)
        if (active.preference) {
          await ctx.reply(`Your description:\n${active.preference.description}`)
        }
        const label = active.preference
          ? 'version' in active.preference
            ? 'Compiled selection rules'
            : 'Active filter (using your original preferences)'
          : 'Default selection rules'
        await ctx.reply(
          `${label}:\n${active.instruction}\n\nYour original preferences take precedence. Use /newsfilter <what you like and dislike> to replace them, or /newsfilter reset for defaults.`
        )
        return
      }
      if (args.trim().toLowerCase() === 'reset') {
        await this.preferences.reset(chatId)
        await ctx.reply(
          'News filter reset to the configured defaults. Subscription and delivery interval are unchanged.'
        )
        return
      }
      const parsed = preferenceDescriptionSchema.safeParse(args)
      if (!parsed.success) {
        await ctx.reply(
          'Please describe your news preferences in 1-3000 characters.'
        )
        return
      }
      if (!this.generator) {
        await ctx.reply(
          'News preference generation is unavailable. Your existing filter is unchanged.'
        )
        return
      }
      await ctx.sendChatAction('typing')
      const preference = await this.generator.generate(parsed.data)
      await this.preferences.save(chatId, preference)
      await ctx.reply(
        `News filter saved:\n${preference.instruction}\n\nThis replaces your previous preferences. Use /newsfilter to view them or /newsfilter reset for configured defaults.`
      )
    } catch (error) {
      logger.error(
        {
          event: 'news.preferences.error',
          chatId,
          err: error instanceof Error ? error : new Error(String(error)),
        },
        'Failed to process news preferences'
      )
      await ctx.reply(
        'Could not finish processing your news filter. Use /newsfilter to check the active settings, then try again.'
      )
    } finally {
      this.pending.delete(chatId)
    }
  }
}
