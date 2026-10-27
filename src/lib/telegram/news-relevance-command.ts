import logger from '@lib/logger.js'
import type { NewsPreferenceStore } from '@lib/news/preferences.js'
import { relevanceThresholdSchema } from '@lib/news/preference-schema.js'
import type { TelegramContext } from './types.js'

export class NewsRelevanceCommand {
  constructor(
    private readonly preferences: NewsPreferenceStore,
    private readonly defaultThreshold: number
  ) {}

  async handle(
    ctx: Pick<TelegramContext, 'reply'>,
    request: { readonly chatId: string; readonly args: string }
  ): Promise<void> {
    const args = request.args.trim()
    const reset = args.toLowerCase() === 'reset'
    const parsed = relevanceThresholdSchema.safeParse(
      /^\d+(?:\.\d+)?$/.test(args) ? Number(args) : NaN
    )
    if (args && !reset && !parsed.success) {
      await ctx.reply(
        'Use /relevance <0-100> to set a coverage threshold, /relevance to view it, or /relevance reset for the configured default.'
      )
      return
    }
    try {
      if (reset) {
        await this.preferences.setRelevanceThreshold(request.chatId, null)
      } else if (parsed.success) {
        await this.preferences.setRelevanceThreshold(
          request.chatId,
          parsed.data
        )
      }
      const filter = await this.preferences.resolve(request.chatId)
      const threshold = filter.relevanceThreshold ?? this.defaultThreshold
      await ctx.reply(
        [
          `News relevance threshold: ${threshold}/100 (${filter.relevanceThreshold === undefined ? 'configured default' : 'custom for this chat'}).`,
          'Higher values require stronger coverage of your interests. 60 allows partial substantive coverage; 70 is balanced; 80 requires direct coverage; 100 requires a central focus.',
          'Eligibility, exclusions, and confidence checks still apply at every threshold.',
          'Use /relevance <0-100> to change it or /relevance reset for the configured default.',
        ].join('\n')
      )
    } catch (error) {
      logger.error(
        {
          event: 'news.relevance.error',
          chatId: request.chatId,
          err: error instanceof Error ? error : new Error(String(error)),
        },
        'Failed to process news relevance threshold'
      )
      await ctx.reply(
        'Could not finish processing your relevance threshold. Use /relevance to check the active setting, then try again.'
      )
    }
  }
}
