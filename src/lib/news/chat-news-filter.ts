import { createHash } from 'node:crypto'
import { addAbortListener } from 'node:events'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import logger from '@lib/logger.js'
import { DecisionRateLimitError } from '@lib/llm/decision-model.js'
import type { NewsEvaluationBudget } from './evaluation-budget.js'
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
const cooldownSchema = z.number().int().nonnegative()

type EvaluationContext = {
  readonly chatId: string
  readonly filter: NewsFilter
  readonly budget?: NewsEvaluationBudget
  readonly signal?: AbortSignal
}

type PendingEvaluation = {
  readonly promise: Promise<RelevanceResult | null>
  readonly controller: AbortController
  consumers: number
}

export class ChatNewsFilter {
  private readonly pending = new Map<string, PendingEvaluation>()
  private evaluationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly redis: Redis,
    readonly preferences: NewsPreferenceStore,
    private readonly detector: RelevanceDetector
  ) {}

  async evaluate(
    context: EvaluationContext,
    item: NewsItem
  ): Promise<RelevanceResult | null> {
    context.signal?.throwIfAborted()
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          context.filter.revision,
          context.filter.description,
          this.detector.cacheVersion,
          item.title.slice(0, 1000),
          item.description?.slice(0, 3000),
        ])
      )
      .digest('hex')
    const key = `news:chat-decision:${context.chatId}:${item.id}:${fingerprint}`
    let pending = this.pending.get(key)
    if (!pending) {
      const controller = new AbortController()
      const promise = this.evaluateDecision(
        { ...context, signal: controller.signal },
        item,
        key
      ).finally(() => {
        if (this.pending.get(key)?.controller === controller)
          this.pending.delete(key)
      })
      pending = { promise, controller, consumers: 0 }
      this.pending.set(key, pending)
    }
    pending.consumers++
    const signal = context.signal
    let listener: Disposable | undefined
    try {
      if (!signal) return await pending.promise
      return await Promise.race([
        pending.promise,
        new Promise<never>((_, reject) => {
          listener = addAbortListener(signal, () => reject(signal.reason))
        }),
      ])
    } finally {
      listener?.[Symbol.dispose]()
      pending.consumers--
      if (pending.consumers === 0 && this.pending.get(key) === pending) {
        this.pending.delete(key)
        pending.controller.abort(signal?.reason)
      }
    }
  }

  private async evaluateDecision(
    context: EvaluationContext,
    item: NewsItem,
    key: string
  ): Promise<RelevanceResult | null> {
    const logContext = { chatId: context.chatId, itemId: item.id }
    const cached = await this.redis.get(key)
    context.signal?.throwIfAborted()
    if (cached !== null) {
      logger.debug(
        { ...logContext, event: 'news.decision.cache_hit' },
        'Reused cached news decision'
      )
      return this.detector.result(
        relevanceDecisionSchema.parse(JSON.parse(cached)),
        context.filter.relevanceThreshold
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
    const previous = this.evaluationTail
    let releaseEvaluation!: () => void
    const promise = new Promise<void>((resolve) => {
      releaseEvaluation = resolve
    })
    this.evaluationTail = promise
    await previous
    try {
      context.signal?.throwIfAborted()
      return await this.requestDecision(context, item, key, retry)
    } finally {
      releaseEvaluation()
    }
  }

  private async requestDecision(
    context: EvaluationContext,
    item: NewsItem,
    key: string,
    retry: z.infer<typeof retrySchema> | null
  ): Promise<RelevanceResult | null> {
    context.signal?.throwIfAborted()
    const logContext = { chatId: context.chatId, itemId: item.id }
    const cooldownKey = `news:provider-cooldown:${this.detector.providerKey}`
    const cooldownRaw = await this.redis.get(cooldownKey)
    context.signal?.throwIfAborted()
    if (
      cooldownRaw !== null &&
      cooldownSchema.parse(JSON.parse(cooldownRaw)) > Date.now()
    ) {
      logger.debug(
        { ...logContext, event: 'news.decision.provider_deferred' },
        'Deferred news evaluation during provider cooldown'
      )
      return null
    }
    if (context.budget && !context.budget.take()) {
      logger.debug(
        { ...logContext, event: 'news.decision.budget_skip' },
        'Deferred news evaluation after request budget was spent'
      )
      return null
    }
    const attempt = (retry?.attempts ?? 0) + 1
    logger.info(
      { ...logContext, event: 'news.decision.request', attempt },
      'Requesting news decision from provider'
    )
    let result: RelevanceResult | null
    try {
      result = await this.detector.detectRelevance(
        item,
        context.filter,
        context.signal
      )
      context.signal?.throwIfAborted()
    } catch (error) {
      context.signal?.throwIfAborted()
      if (!(error instanceof DecisionRateLimitError)) throw error
      const delayMs = Math.ceil(Math.max(1000, error.retryAfterMs))
      const nextRetryAt = Date.now() + delayMs
      await this.redis.setex(
        cooldownKey,
        Math.ceil(delayMs / 1000),
        JSON.stringify(nextRetryAt)
      )
      logger.warn(
        {
          ...logContext,
          event: 'news.decision.provider_cooldown',
          nextRetryAt,
          retryAfterMs: delayMs,
        },
        'Paused news decisions after provider rate limit'
      )
      return null
    }
    const retryKey = `${key}:retry`
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
