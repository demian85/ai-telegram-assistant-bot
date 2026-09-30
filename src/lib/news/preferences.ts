import { createHash, randomUUID } from 'node:crypto'
import type { ChatOpenAI } from '@langchain/openai'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import type { LlmRoleConfig } from '@lib/config/types.js'
import {
  preferenceDescriptionSchema,
  generatedCriteriaSchema,
  newsPreferenceSchema,
  legacyPreferenceSchema,
  renderCriteria,
  type NewsPreference,
  type NewsFilter,
} from './preference-schema.js'

export {
  preferenceDescriptionSchema,
  type NewsPreference,
  type NewsFilter,
} from './preference-schema.js'

const generationRules = `Extract interests, exclusions, and title requirements into the required structured arrays.
Every criterion must contain an actionable rule and sourceText quoted exactly from the user's description.
Preserve all preferences and exceptions, including negative preferences and title-quality rules.
Do not invent interests, expand named companies to all technology news, or return a heading instead of criteria.
Require at least one interest. Empty exclusions or titleRules arrays are allowed only when none were specified.
The original description remains authoritative; your criteria are a compilation aid only.`

export class NewsPreferenceGenerator {
  constructor(
    private readonly model: ChatOpenAI,
    private readonly config: LlmRoleConfig
  ) {}

  async generate(description: string): Promise<NewsPreference> {
    const input = preferenceDescriptionSchema.parse(description)
    const output = await this.model
      .withStructuredOutput(generatedCriteriaSchema)
      .invoke(
        [
          {
            role: 'system',
            content: [this.config.systemPrompt, generationRules].join('\n\n'),
          },
          { role: 'user', content: input },
        ],
        { signal: AbortSignal.timeout(60_000) }
      )
    const criteria = generatedCriteriaSchema.parse(output)
    return newsPreferenceSchema.parse({
      mode: 'custom',
      version: 2,
      description: input,
      criteria,
      instruction: renderCriteria(criteria),
      revision: randomUUID(),
      generatedAt: new Date().toISOString(),
      model: this.config.model,
    })
  }
}

export class NewsPreferenceStore {
  constructor(
    private readonly redis: Redis,
    private readonly defaultFilter: string
  ) {}

  async save(chatId: string, preference: NewsPreference): Promise<void> {
    const parsed = newsPreferenceSchema.parse(preference)
    await this.redis.set(
      `news:preferences:${chatId}`,
      JSON.stringify({
        ...parsed,
        instruction: renderCriteria(parsed.criteria),
      })
    )
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
    const key = `news:preferences:${chatId}`
    const raw = await this.redis.get(key)
    if (raw !== null) {
      const saved: unknown = JSON.parse(raw)
      const marker = z
        .object({ mode: z.literal('default'), revision: z.string().uuid() })
        .safeParse(saved)
      if (marker.success) return this.defaultSettings(marker.data.revision)
      const original = legacyPreferenceSchema.parse(saved)
      const current = newsPreferenceSchema.safeParse(saved)
      const preference = current.success
        ? {
            ...current.data,
            instruction: renderCriteria(current.data.criteria),
          }
        : { ...original, instruction: original.description }
      return {
        description: preference.description,
        instruction: preference.instruction,
        revision: `v2:${preference.revision}`,
        preference,
        source: 'custom',
      }
    }

    const subscription = await this.redis.get(
      `news:chat-subscription:${chatId}`
    )
    const legacy =
      subscription === null
        ? null
        : z
            .object({ topics: z.array(z.string()).optional() })
            .parse(JSON.parse(subscription))
    if (legacy?.topics?.length) {
      const description = `Select substantive articles about: ${legacy.topics.join(', ')}. Passing mentions are insufficient.`
      const migrated = legacyPreferenceSchema.parse({
        mode: 'custom',
        description,
        instruction: description,
        revision: randomUUID(),
        generatedAt: new Date().toISOString(),
        model: 'legacy-topic-migration',
      })
      await this.redis.set(key, JSON.stringify(migrated), 'NX')
      return this.resolve(chatId)
    }
    return this.defaultSettings('default')
  }

  private defaultSettings(revision: string): NewsFilter {
    return {
      description: this.defaultFilter,
      instruction: this.defaultFilter,
      revision: createHash('sha256')
        .update(JSON.stringify([revision, this.defaultFilter]))
        .digest('hex'),
      source: 'default',
    }
  }
}
