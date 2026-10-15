import { expect, test } from 'vitest'
import { NewsPreferenceGenerator } from '../src/lib/news/preferences.js'
import { filterHarness, structuredModel } from './news-filter-helpers.js'

const role = {
  model: 'generator',
  supportsVision: false,
  systemPrompt: 'generation-role',
}

const managerRequest =
  'Select articles relevant to a Product Manager, Business Analyst, or team manager working with human developers and AI agents. Prioritize AI-assisted software development, coding agents, AI automation, developer productivity, project estimation, delivery speed, software quality, team management, human-AI collaboration, product management, and the impact of AI on software development workflows.Include significant updates and comparisons involving OpenAI, Codex, Anthropic, Claude Code, OpenCode, Hermes, and other relevant tools, focusing on practical capabilities, limitations, business impact, and adoption strategies.Prioritize insights that help managers understand changes, make decisions, and improve team performance. No developer expertise required.Exclude passing mentions, generic AI news, superficial product announcements, and technical tutorials without clear management or business relevance.'

test('generates and saves the reported manager request with missing spaces between sentences', async () => {
  const criteria = {
    interests: [
      {
        rule: 'Practical AI development coverage for product, business, and team managers',
        sourceText:
          'Select articles relevant to a Product Manager, Business Analyst, or team manager working with human developers and AI agents. Prioritize AI-assisted software development, coding agents, AI automation, developer productivity, project estimation, delivery speed, software quality, team management, human-AI collaboration, product management, and the impact of AI on software development workflows.',
      },
      {
        rule: 'Significant tool updates and comparisons with practical management relevance',
        sourceText:
          'Include significant updates and comparisons involving OpenAI, Codex, Anthropic, Claude Code, OpenCode, Hermes, and other relevant tools, focusing on practical capabilities, limitations, business impact, and adoption strategies.',
      },
      {
        rule: 'Decision-making and team performance insights requiring no developer expertise',
        sourceText:
          'Prioritize insights that help managers understand changes, make decisions, and improve team performance. No developer expertise required.',
      },
    ],
    exclusions: [
      {
        rule: 'Exclude superficial coverage and tutorials without management or business relevance',
        sourceText:
          'Exclude passing mentions, generic AI news, superficial product announcements, and technical tutorials without clear management or business relevance.',
      },
    ],
    titleRules: [],
  }
  const generator = new NewsPreferenceGenerator(
    structuredModel(() => criteria),
    role
  )
  const { preferences } = filterHarness()

  const generated = await generator.generate(managerRequest)
  await preferences.save('manager', generated)
  const saved = await preferences.resolve('manager')

  expect(saved.description).toBe(managerRequest)
  expect(saved.preference).toEqual(generated)
  expect(generated.criteria).toEqual(criteria)
  for (const criterion of [...criteria.interests, ...criteria.exclusions]) {
    expect(saved.instruction).toContain(criterion.sourceText)
  }
})

test.each(['.', '!', '?'])(
  'accepts unspaced sentences separated by %s while retaining complete keywords',
  async (separator) => {
    const first = `Track C++, C#, .NET, Node.js, GPT-4o, and @scope/package${separator}`
    const second = 'Include practical comparisons.'
    const description = first + second
    const generator = new NewsPreferenceGenerator(
      structuredModel(() => ({
        interests: [
          { rule: 'Track named tools', sourceText: first },
          { rule: 'Include practical comparisons', sourceText: second },
        ],
        exclusions: [],
        titleRules: [],
      })),
      role
    )

    const generated = await generator.generate(description)

    expect(generated.description).toBe(description)
    expect(generated.instruction).toContain(first)
    expect(generated.instruction).toContain(second)
  }
)

test.each([
  { keyword: 'C++', fragments: ['C', '++'] },
  { keyword: '.NET', fragments: ['.', 'NET'] },
  { keyword: 'Node.js', fragments: ['Node.', 'js'] },
])(
  'rejects fragmented $keyword quotes even alongside unspaced sentences',
  async ({ keyword, fragments }) => {
    const generator = new NewsPreferenceGenerator(
      structuredModel(() => ({
        interests: [
          ...fragments,
          'updates.',
          'Include practical comparisons.',
        ].map((sourceText) => ({ rule: 'Track named tools', sourceText })),
        exclusions: [],
        titleRules: [],
      })),
      role
    )

    await expect(
      generator.generate(`${keyword} updates.Include practical comparisons.`)
    ).rejects.toThrow('Source quotes must cover complete original tokens')
  }
)
