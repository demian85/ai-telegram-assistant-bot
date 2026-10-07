import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import logger from '@lib/logger.js'
import { NewsPreferenceStore, type NewsFilter } from './preferences.js'
import {
  relevanceDecisionSchema,
  type RelevanceDetector,
  type RelevanceResult,
} from './relevance-detector.js'
import type { NewsItem } from './types.js'

const decisionTtlSeconds = 14 * 24 * 60 * 60
const retryDelaysMs = [15 * 60 * 1000, 60 * 60 * 1000] as const
const maxAttempts = retryDelaysMs.length + 1
const retrySchema = z.object({
  attempts: z.number().int().min(1).max(maxAttempts),
  nextRetryAt: z.number().int().nonnegative(),
})

export class ChatNewsFilter {
  private readonly pending = new Map<string, Promise<RelevanceResult | null>>()

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
    const pending = this.pending.get(key)
    if (pending) return pending
    const evaluation = this.evaluateDecision(context, item, key)
    this.pending.set(key, evaluation)
    try {
      return await evaluation
    } finally {
      this.pending.delete(key)
    }
  }

  private async evaluateDecision(
    context: { readonly chatId: string; readonly filter: NewsFilter },
    item: NewsItem,
    key: string
  ): Promise<RelevanceResult | null> {
    const logContext = { chatId: context.chatId, itemId: item.id }
    const cached = await this.redis.get(key)
    if (cached !== null) {
      logger.debug(
        { ...logContext, event: 'news.decision.cache_hit' },
        'Reused cached news decision'
      )
      return this.detector.result(
        relevanceDecisionSchema.parse(JSON.parse(cached))
      )
    }
    const retryKey = `${key}:retry`
    const retryRaw = await this.redis.get(retryKey)
    const retry =
      retryRaw === null ? null : retrySchema.parse(JSON.parse(retryRaw))
    if (
      retry &&
      (retry.attempts >= maxAttempts || retry.nextRetryAt > Date.now())
    ) {
      logger.debug(
        {
          ...logContext,
          event: 'news.decision.retry_skip',
          attempts: retry.attempts,
          nextRetryAt: retry.nextRetryAt,
        },
        'Deferred unresolved news evaluation'
      )
      return null
    }
    const attempt = (retry?.attempts ?? 0) + 1
    logger.info(
      { ...logContext, event: 'news.decision.request', attempt },
      'Requesting news decision from provider'
    )
    const result = await this.detector.detectRelevance(item, context.filter)
    if (result !== null) {
      await this.redis.setex(key, decisionTtlSeconds, JSON.stringify(result))
      if (retry) await this.redis.del(retryKey)
    } else {
      const delay = retryDelaysMs[attempt - 1]
      const nextRetryAt = Date.now() + (delay ?? decisionTtlSeconds * 1000)
      await this.redis.setex(
        retryKey,
        decisionTtlSeconds,
        JSON.stringify({ attempts: attempt, nextRetryAt })
      )
      logger.info(
        {
          ...logContext,
          event: 'news.decision.retry_deferred',
          attempts: attempt,
          exhausted: attempt >= maxAttempts,
          nextRetryAt,
        },
        'Withheld unresolved article and deferred further evaluation'
      )
    }
    return result
  }
}
