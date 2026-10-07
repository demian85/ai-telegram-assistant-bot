import { createHash } from 'node:crypto'
import { z } from 'zod'
import { APIError, type VeniceDecisionModel } from '@lib/llm/decision-model.js'
import logger from '@lib/logger.js'
import type { NewsConfig, NewsItem } from './types.js'
import type { NewsFilter } from './preferences.js'
import { createRelevanceQuestions } from './relevance-questions.js'

export const relevanceDecisionSchema = z.object({
  matchesInterest: z.boolean(),
  excluded: z.boolean(),
  titleRulesSatisfied: z.boolean(),
  score: z.number().int().min(0).max(100),
  reason: z.string().max(2000),
})
export type RelevanceDecision = z.infer<typeof relevanceDecisionSchema>
export type RelevanceResult = RelevanceDecision & {
  readonly isRelevant: boolean
}

export class RelevanceDetector {
  readonly cacheVersion: string
  private readonly questions
  private readonly minimumConfidence: number
  constructor(
    private readonly model: VeniceDecisionModel,
    private readonly config: Pick<
      NewsConfig,
      'relevanceThreshold' | 'decisionConfidenceThreshold'
    > & {
      readonly systemPrompt?: string
    }
  ) {
    this.questions = createRelevanceQuestions(config.systemPrompt)
    this.minimumConfidence = config.decisionConfidenceThreshold ?? 0.8
    this.cacheVersion = createHash('sha256')
      .update(
        JSON.stringify([
          model.model,
          'venice-decisions-v1',
          model.baseUrl,
          config.relevanceThreshold,
          this.minimumConfidence,
          this.questions,
        ])
      )
      .digest('hex')
  }

  result(decision: RelevanceDecision): RelevanceResult {
    return {
      ...decision,
      isRelevant:
        decision.matchesInterest &&
        !decision.excluded &&
        decision.titleRulesSatisfied &&
        decision.score >= this.config.relevanceThreshold,
    }
  }

  async detectRelevance(
    item: NewsItem,
    filter: Pick<NewsFilter, 'description' | 'instruction'>
  ): Promise<RelevanceResult | null> {
    try {
      const { answers, model, usage } = await this.model.invoke(
        {
          preferences: {
            original: filter.description,
            compiled: filter.instruction,
          },
          article: {
            title: item.title.slice(0, 1000),
            description: item.description?.slice(0, 3000),
            content: item.content?.slice(0, 8000),
          },
        },
        this.questions
      )
      const confidence = Math.min(
        answers.interest.confidence,
        answers.exclusion.confidence,
        answers.title.confidence
      )
      const rejection = [
        {
          applies: answers.exclusion.choice === 'yes',
          confidence: answers.exclusion.confidence,
          reason: 'Explicit exclusion applies',
        },
        {
          applies: answers.title.choice === 'no',
          confidence: answers.title.confidence,
          reason: 'Title requirements are not satisfied',
        },
        {
          applies: answers.interest.choice === 'no',
          confidence: answers.interest.confidence,
          reason: 'No substantive interest match in the available text',
        },
      ].find(
        (gate) => gate.applies && gate.confidence >= this.minimumConfidence
      )
      if (!rejection && confidence < this.minimumConfidence) {
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
        matchesInterest: answers.interest.choice === 'yes',
        excluded: answers.exclusion.choice === 'yes',
        titleRulesSatisfied: answers.title.choice === 'yes',
        score: Math.round(answers.relevance.score * 20),
        reason:
          rejection?.reason ??
          'Substantive interest match; relevance determined by coverage rubric',
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
