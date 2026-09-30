import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { NewsPreferenceStore, type NewsFilter } from './preferences.js'
import {
  relevanceDecisionSchema,
  type RelevanceDetector,
  type RelevanceResult,
} from './relevance-detector.js'
import type { NewsItem } from './types.js'

export class ChatNewsFilter {
  constructor(
    private readonly redis: Redis,
    readonly preferences: NewsPreferenceStore,
    private readonly detector: RelevanceDetector
  ) {}

  async evaluate(
    context: { readonly chatId: string; readonly filter: NewsFilter },
    item: NewsItem
  ): Promise<RelevanceResult | null> {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          context.filter.revision,
          context.filter.instruction,
          context.filter.description,
          this.detector.cacheVersion,
          item.title,
          item.description,
          item.content,
        ])
      )
      .digest('hex')
    const key = `news:chat-decision:${context.chatId}:${item.id}:${fingerprint}`
    const cached = await this.redis.get(key)
    if (cached !== null) {
      return this.detector.result(
        relevanceDecisionSchema.parse(JSON.parse(cached))
      )
    }
    const result = await this.detector.detectRelevance(item, context.filter)
    if (result !== null) {
      await this.redis.setex(key, 14 * 24 * 60 * 60, JSON.stringify(result))
    }
    return result
  }
}
