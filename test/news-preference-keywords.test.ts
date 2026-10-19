import { expect, test } from 'vitest'
import { NewsPreferenceGenerator } from '../src/lib/news/preferences.js'
import { renderCriteria } from '../src/lib/news/preference-schema.js'
import { filterHarness, structuredModel } from './news-filter-helpers.js'

const interests =
  'Developer tools, Coding tools, Coding plans, AI Agents, AI Agent harness, AI Automation, Codex, Claude Code, Grok, SpaceX, Opencode, Hermes, OpenAI, Anthropic, LLM releases, LLM coding benchmarks'
const inclusion = `Select articles substantively covering at least one of these interests: ${interests}.`
const quality = 'Passing mentions and uncertain matches are insufficient.'
const exclusions = 'Not interested in langchain releases, python,'
const titles = 'or articles whose title is vague or is a commit SHA or semver'
const description = `${inclusion} ${quality} ${exclusions} ${titles}`
const completeCriteria = {
  interests: [
    { rule: 'At least one specified interest', sourceText: inclusion },
    { rule: 'Substantive and certain matches only', sourceText: quality },
  ],
  exclusions: [
    { rule: 'LangChain releases or Python', sourceText: exclusions },
  ],
  titleRules: [
    { rule: 'Reject vague, commit SHA, or semver titles', sourceText: titles },
  ],
}

function generator(output: unknown) {
  return new NewsPreferenceGenerator(
    structuredModel(() => output),
    {
      model: 'generator',
      supportsVision: false,
      systemPrompt: 'generation-role',
    }
  )
}

test('rejects the reported generic compilation that omits every named interest', async () => {
  await expect(
    generator({
      ...completeCriteria,
      interests: [
        {
          rule: 'Article must cover at least one specified interest substantively',
          sourceText:
            'Select articles substantively covering at least one of these interests:',
        },
        {
          rule: 'Passing mentions and uncertain matches are not sufficient',
          sourceText: quality,
        },
      ],
    }).generate(description)
  ).rejects.toThrow()
})

test('rejects a grounded compilation that silently omits only the last named interest', async () => {
  await expect(
    generator({
      ...completeCriteria,
      interests: [
        {
          rule: 'Named tools and companies',
          sourceText: inclusion.slice(0, inclusion.indexOf(', LLM coding')),
        },
        { rule: 'Substantive and certain matches only', sourceText: quality },
      ],
    }).generate(description)
  ).rejects.toThrow()
})

test('keeps all exact keywords visible even when a generated rule paraphrases its source', async () => {
  const generated = await generator(completeCriteria).generate(description)
  for (const interest of interests.split(', ')) {
    expect(generated.instruction).toContain(interest)
  }
  expect(generated.description).toBe(description)
  expect(generated.instruction).toContain(exclusions)
  expect(generated.instruction).toContain(titles)

  const harness = filterHarness((request) => {
    expect(request.state.preferences).toBe(description)
    return { eligible: false, score: 0 }
  })
  await harness.preferences.save('a', generated)
  const resolved = await harness.preferences.resolve('a')
  expect(resolved.instruction).toBe(generated.instruction)
  await harness.detector.detectRelevance(
    {
      id: 'keyword-qa',
      title: 'Claude Code release',
      source: 'test',
      feedUrl: '',
      url: '',
      fetchedAt: new Date(0),
      publishedAt: new Date(0),
    },
    resolved
  )
})

test('uses original preferences when an existing saved compilation omitted the keyword list', async () => {
  const { redis, preferences } = filterHarness()
  await redis.set(
    'news:preferences:a',
    JSON.stringify({
      mode: 'custom',
      version: 2,
      description,
      instruction: 'Include substantive coverage of any: specified interest',
      criteria: {
        ...completeCriteria,
        interests: [{ rule: 'Specified interest', sourceText: quality }],
      },
      revision: '7bf8ed72-be02-4778-b1d0-bcbf4c7c39f6',
      generatedAt: '2026-09-29T18:07:12.431Z',
      model: 'generator',
    })
  )

  expect((await preferences.resolve('a')).instruction).toBe(description)
})

test('does not duplicate a source quote already present in its rule', () => {
  expect(
    renderCriteria({
      interests: [{ rule: 'Codex and Claude Code', sourceText: 'Codex' }],
      exclusions: [],
      titleRules: [],
    })
  ).toBe('Include substantive coverage of any: Codex and Claude Code')
})
