import { createHash } from 'node:crypto'
import { z } from 'zod'
import { APIError, type VeniceDecisionModel } from '@lib/llm/decision-model.js'
import logger from '@lib/logger.js'
import type { NewsConfig, NewsItem } from './types.js'
import type { NewsFilter } from './preferences.js'
import { relevanceQuestions } from './relevance-questions.js'

export const relevanceDecisionSchema = z.object({
  eligible: z.boolean(),
  score: z.number().min(0).max(100),
  reason: z.string().max(2000),
})
export type RelevanceDecision = z.infer<typeof relevanceDecisionSchema>
export type RelevanceResult = RelevanceDecision & {
  readonly isRelevant: boolean
}

export class RelevanceDetector {
  readonly cacheVersion: string
  private readonly minimumConfidence: number
  constructor(
    private readonly model: VeniceDecisionModel,
    private readonly config: Pick<
      NewsConfig,
      'relevanceThreshold' | 'decisionConfidenceThreshold'
    >
  ) {
    this.minimumConfidence = config.decisionConfidenceThreshold ?? 0.8
    this.cacheVersion = createHash('sha256')
      .update(
        JSON.stringify([
          model.model,
          'venice-decisions-v2-title-description',
          model.baseUrl,
          config.relevanceThreshold,
          this.minimumConfidence,
          relevanceQuestions,
        ])
      )
      .digest('hex')
  }

  result(decision: RelevanceDecision): RelevanceResult {
    return {
      ...decision,
      isRelevant:
        decision.eligible && decision.score >= this.config.relevanceThreshold,
    }
  }

  async detectRelevance(
    item: NewsItem,
    filter: Pick<NewsFilter, 'description'>
  ): Promise<RelevanceResult | null> {
    try {
      const { answers, model, usage } = await this.model.invoke(
        {
          preferences: filter.description,
          article: {
            title: item.title.slice(0, 1000),
            description: item.description?.slice(0, 3000),
          },
        },
        relevanceQuestions
      )
      const confidence = answers.eligibility.confidence
      if (confidence < this.minimumConfidence) {
        logger.info(
          {
            event: 'news.decision.uncertain',
            itemId: item.id,
            model,
            confidence,
          },
          'Withheld uncertain news decision'
        )
        return null
      }
      const decision = {
        eligible: answers.eligibility.choice === 'yes',
        score: answers.relevance.score * 20,
        reason:
          answers.eligibility.choice === 'yes'
            ? 'Preferences satisfied; coverage determines relevance'
            : 'Article does not satisfy the saved preferences',
      }
      logger.debug(
        {
          event: 'news.decision.result',
          itemId: item.id,
          model,
          confidence,
          usage,
        },
        'Evaluated news decision'
      )
      return this.result(decision)
    } catch (error) {
      logger.error(
        {
          event: 'news.score.error',
          itemId: item.id,
          errorType: error instanceof Error ? error.name : 'UnknownError',
          status: error instanceof APIError ? error.status : undefined,
        },
        'Failed to evaluate news relevance'
      )
      return null
    }
  }
}
