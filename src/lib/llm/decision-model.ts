import { APIError, OpenAI, type ClientOptions } from 'openai'
import { z } from 'zod'

export { APIError } from 'openai'

export class DecisionRateLimitError extends Error {
  readonly name = 'DecisionRateLimitError'

  constructor(
    readonly retryAfterMs: number,
    options?: ErrorOptions
  ) {
    super('Decision provider rate limit exceeded', options)
  }
}

const probability = z.number().min(0).max(1)
const choiceAnswer = z
  .object({
    type: z.literal('choice'),
    choice: z.enum(['yes', 'no']),
    confidence: probability,
    probabilities: z
      .object({ yes: probability, no: probability })
      .refine((value) => Math.abs(value.yes + value.no - 1) < 0.001),
  })
  .refine((value) => value.probabilities[value.choice] >= 0.5)

export const decisionResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.object({
    eligibility: choiceAnswer,
    relevance: z.object({
      type: z.literal('score'),
      score: z.number().min(0).max(5),
      confidence: probability,
    }),
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
})

export type DecisionQuestions = Readonly<
  Record<
    string,
    {
      readonly type: 'choice' | 'score'
      readonly instructions: string
      readonly criteria: Readonly<Record<string, string>> | readonly string[]
    }
  >
>

export type DecisionState = {
  readonly preferences: string
  readonly article: {
    readonly title: string
    readonly description?: string
  }
}

export class VeniceDecisionModel {
  readonly model: string
  readonly baseUrl: string
  private readonly client: OpenAI

  constructor(config: ClientOptions & { readonly model?: string }) {
    this.model = config.model ?? 'jev-latest'
    this.client = new OpenAI({ timeout: 20_000, maxRetries: 0, ...config })
    this.baseUrl = this.client.baseURL
  }

  async invoke(state: DecisionState, questions: DecisionQuestions) {
    const body = { model: this.model, state, questions }
    try {
      const output = await this.client.post<unknown>('/decisions', {
        body,
        signal: AbortSignal.timeout(60_000),
      })
      return decisionResponseSchema.parse(output)
    } catch (error) {
      if (!(error instanceof APIError) || error.status !== 429) throw error
      const milliseconds = error.headers?.get('retry-after-ms')?.trim()
      const retryAfter = error.headers?.get('retry-after')?.trim()
      const millisecondsDelay = milliseconds ? Number(milliseconds) : NaN
      const seconds = retryAfter ? Number(retryAfter) : NaN
      const retryAfterDelay = Number.isFinite(seconds)
        ? seconds * 1000
        : retryAfter
          ? Date.parse(retryAfter) - Date.now()
          : NaN
      const delay =
        [millisecondsDelay, retryAfterDelay].find(
          (value) => Number.isFinite(value) && value >= 0
        ) ?? 60_000
      throw new DecisionRateLimitError(delay, { cause: error })
    }
  }
}
