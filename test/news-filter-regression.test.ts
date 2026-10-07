import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { NewsPreferenceGenerator } from '../src/lib/news/preferences.js'
import { preference } from './news-filter-helpers.js'
import {
  acceptedDecision,
  filterHarness,
  structuredModel,
} from './news-filter-helpers.js'

const original =
  'Developer tools and coding agents. Exclude Python and LangChain releases. Reject vague, SHA-only, and semver-only titles.'
const siri = {
  id: 'siri-settlement',
  title: 'How to Claim Your Cut of Apple’s $250 Million Siri Settlement',
  description:
    'Apple may pay out up to $95 for each eligible iPhone purchased by someone who felt misled about Siri’s release. You have until December 21 to submit a claim.',
  source: 'Planet AI - Aggregate Feed',
  feedUrl: '',
  url: 'https://www.wired.com/story/how-to-claim-your-cut-of-apple-250-million-siri-settlement/',
  fetchedAt: new Date('2026-09-22T19:20:00.844Z'),
  publishedAt: new Date('2026-09-22T18:19:13.000Z'),
}

test('rejects the observed heading-only generator response', async () => {
  const generator = new NewsPreferenceGenerator(
    structuredModel(() => ({ instruction: '**News Selection Criteria**' })),
    {
      model: 'generator',
      supportsVision: false,
      systemPrompt: 'generation-role',
    }
  )

  await expect(generator.generate(original)).rejects.toThrow()
})

test('supplies original preferences when scoring the Siri article with a broken legacy filter', async () => {
  const payloadSchema = z.object({ preferences: z.unknown() })
  const inputs: unknown[] = []
  const harness = filterHarness((request) => {
    const payload = payloadSchema.parse(request.state)
    inputs.push(payload.preferences)
    const criteria = z
      .object({ original: z.string() })
      .safeParse(payload.preferences)
    return {
      ...acceptedDecision,
      matchesInterest: !(
        criteria.success && criteria.data.original === original
      ),
    }
  })
  await harness.redis.set(
    'news:preferences:a',
    JSON.stringify({
      mode: 'custom',
      description: original,
      instruction: '**News Selection Criteria**',
      revision: '7bf8ed72-be02-4778-b1d0-bcbf4c7c39f6',
      generatedAt: '2026-09-29T18:07:12.431Z',
      model: 'generator',
    })
  )

  const result = await harness.filter.evaluate(
    { chatId: 'a', filter: await harness.preferences.resolve('a') },
    siri
  )

  expect(inputs[0]).toMatchObject({ original })
  expect(result?.isRelevant).toBe(false)
})

test.each([
  { interests: [], exclusions: [], titleRules: [] },
  {
    interests: [{ rule: 'Corporate law', sourceText: 'Corporate law' }],
    exclusions: [],
    titleRules: [],
  },
  { interests: [{ rule: 'Developer tools', sourceText: 'Developer tools' }] },
])('rejects incomplete or ungrounded criteria: %j', async (criteria) => {
  const generator = new NewsPreferenceGenerator(
    structuredModel(() => criteria),
    {
      model: 'generator',
      supportsVision: false,
      systemPrompt: 'generation-role',
    }
  )
  await expect(generator.generate(original)).rejects.toThrow()
})

test('preserves structured exclusions and title requirements with their source text', async () => {
  const criteria = {
    interests: [
      {
        rule: 'Substantive coding-agent coverage',
        sourceText: 'coding agents',
      },
    ],
    exclusions: [
      { rule: 'Exclude Python', sourceText: 'Exclude Python' },
      { rule: 'Exclude LangChain releases', sourceText: 'LangChain releases' },
    ],
    titleRules: [
      {
        rule: 'Reject vague or identifier-only titles',
        sourceText: 'Reject vague, SHA-only, and semver-only titles',
      },
    ],
  }
  const generator = new NewsPreferenceGenerator(
    structuredModel(() => criteria),
    {
      model: 'generator',
      supportsVision: false,
      systemPrompt: 'generation-role',
    }
  )
  const generated = await generator.generate(original)
  expect(generated).toMatchObject({
    version: 2,
    description: original,
    criteria,
  })
})

test('migrates legacy topics once without changing subscription state', async () => {
  const { preferences, redis } = filterHarness()
  const subscription = JSON.stringify({
    enabled: true,
    intervalSeconds: 1800,
    topics: ['Coding', 'Languages'],
  })
  await redis.set('news:chat-subscription:a', subscription)

  const migrated = await preferences.resolve('a')
  const persisted = await redis.get('news:preferences:a')
  expect(persisted).not.toBeNull()
  expect(migrated).toMatchObject({
    source: 'custom',
    preference: { model: 'legacy-topic-migration' },
  })
  expect(await preferences.resolve('a')).toEqual(migrated)
  expect(await redis.get('news:chat-subscription:a')).toBe(subscription)
})

test('does not overwrite custom preferences when a subscription still has legacy topics', async () => {
  const { preferences, redis } = filterHarness()
  const custom = preference('Specific interest')
  await preferences.save('a', custom)
  await redis.set(
    'news:chat-subscription:a',
    JSON.stringify({ topics: ['Other topic'] })
  )

  expect((await preferences.resolve('a')).preference).toEqual(custom)
})

test('migration preserves preferences saved concurrently', async () => {
  const { preferences, redis } = filterHarness()
  await redis.set(
    'news:chat-subscription:a',
    JSON.stringify({ topics: ['Old topic'] })
  )
  const custom = preference('Concurrent choice')
  const set = redis.set.bind(redis)
  vi.spyOn(redis, 'set').mockImplementation(async (key, value, mode) => {
    if (mode === 'NX') await set(key, JSON.stringify(custom))
    return set(key, value, mode)
  })

  expect((await preferences.resolve('a')).preference).toEqual(custom)
})
