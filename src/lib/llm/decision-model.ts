import 'openai/shims/web'
import { OpenAI, type ClientOptions } from 'openai'
import { z } from 'zod'

export { APIError } from 'openai'

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
    interest: choiceAnswer,
    exclusion: choiceAnswer,
    title: choiceAnswer,
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
  readonly preferences: { readonly original: string; readonly compiled: string }
  readonly article: {
    readonly title: string
    readonly description?: string
    readonly content?: string
  }
}

export class VeniceDecisionModel {
  readonly model: string
  readonly baseUrl: string
  private readonly client: OpenAI

  constructor(config: ClientOptions & { readonly model?: string }) {
    this.model = config.model ?? 'jev-latest'
    this.client = new OpenAI({ timeout: 20_000, maxRetries: 2, ...config })
    this.baseUrl = this.client.baseURL
  }

  async invoke(state: DecisionState, questions: DecisionQuestions) {
    const body = { model: this.model, state, questions }
    const output = await this.client.post<typeof body, unknown>('/decisions', {
      body,
      signal: AbortSignal.timeout(60_000),
    })
    return decisionResponseSchema.parse(output)
  }
}
