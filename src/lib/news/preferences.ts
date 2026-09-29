import { createHash, randomUUID } from 'node:crypto'
import type { ChatOpenAI } from '@langchain/openai'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import type { LlmRoleConfig } from '@lib/config/types.js'
import { ChatSubscriptionStore } from './chat-subscription-store.js'

export const preferenceDescriptionSchema = z.string().trim().min(1).max(3000)
const instructionSchema = z.string().trim().min(1).max(3000)
const generatedSchema = z.object({ instruction: instructionSchema })
const customPreferenceSchema = z.object({
  mode: z.literal('custom'),
  description: preferenceDescriptionSchema,
  instruction: instructionSchema,
  revision: z.string().uuid(),
  generatedAt: z.string().datetime(),
  model: z.string(),
})
const savedPreferenceSchema = z.discriminatedUnion('mode', [
  customPreferenceSchema,
  z.object({ mode: z.literal('default'), revision: z.string().uuid() }),
])

export type NewsPreference = z.infer<typeof customPreferenceSchema>
export type NewsFilter = {
  readonly instruction: string
  readonly revision: string
  readonly preference?: NewsPreference
  readonly source: 'custom' | 'topics' | 'default'
}

export class NewsPreferenceGenerator {
  constructor(
    private readonly model: ChatOpenAI,
    private readonly config: LlmRoleConfig
  ) {}

  async generate(description: string): Promise<NewsPreference> {
    const input = preferenceDescriptionSchema.parse(description)
    const output = await this.model
      .withStructuredOutput(generatedSchema)
      .invoke(
        [
          { role: 'system', content: this.config.systemPrompt },
          { role: 'user', content: input },
        ],
        { signal: AbortSignal.timeout(60_000) }
      )
    const { instruction } = generatedSchema.parse(output)
    return {
      mode: 'custom',
      description: input,
      instruction,
      revision: randomUUID(),
      generatedAt: new Date().toISOString(),
      model: this.config.model,
    }
  }
}

export class NewsPreferenceStore {
  constructor(
    private readonly redis: Redis,
    private readonly defaultTopics: readonly string[]
  ) {}

  async save(chatId: string, preference: NewsPreference): Promise<void> {
    const parsed = customPreferenceSchema.parse(preference)
    await this.redis.set(`news:preferences:${chatId}`, JSON.stringify(parsed))
  }

  async reset(chatId: string): Promise<void> {
    await this.redis.set(
      `news:preferences:${chatId}`,
      JSON.stringify({
        mode: 'default',
        revision: randomUUID(),
      })
    )
  }

  async resolve(chatId: string): Promise<NewsFilter> {
    const raw = await this.redis.get(`news:preferences:${chatId}`)
    const saved =
      raw === null ? null : savedPreferenceSchema.parse(JSON.parse(raw))
    if (saved?.mode === 'custom') {
      return {
        instruction: saved.instruction,
        revision: saved.revision,
        preference: saved,
        source: 'custom',
      }
    }
    const subscription =
      saved === null
        ? await new ChatSubscriptionStore(this.redis).getSubscription(chatId)
        : null
    const topics = subscription?.topics ?? this.defaultTopics
    const instruction = `Select articles substantively covering at least one of these interests: ${topics.join(', ')}. Passing mentions and uncertain matches are insufficient.`
    return {
      instruction,
      revision: createHash('sha256')
        .update(JSON.stringify([saved?.revision, topics]))
        .digest('hex'),
      source: subscription?.topics ? 'topics' : 'default',
    }
  }
}
