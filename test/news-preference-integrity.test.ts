import { expect, test } from 'vitest'
import { NewsPreferenceGenerator } from '../src/lib/news/preferences.js'
import { structuredModel } from './news-filter-helpers.js'

const role = {
  model: 'generator',
  supportsVision: false,
  systemPrompt: 'generation-role',
}

test.each([
  { description: 'C', rule: 'C++ coverage' },
  { description: 'C#', rule: 'C## coverage' },
  { description: 'Node', rule: 'Node.js coverage' },
])(
  'retains a source quote when the paraphrase embeds it in a different keyword: $description',
  async ({ description, rule }) => {
    const generator = new NewsPreferenceGenerator(
      structuredModel(() => ({
        interests: [{ rule, sourceText: description }],
        exclusions: [],
        titleRules: [],
      })),
      role
    )

    const generated = await generator.generate(description)

    expect(generated.instruction).toContain(`"${description}"`)
  }
)

test.each([
  { keyword: 'C++', quotes: ['C'] },
  { keyword: 'C#', quotes: ['C'] },
  { keyword: '.NET', quotes: ['NET'] },
  { keyword: 'Node.js', quotes: ['Node', 'js'] },
  { keyword: 'GPT-4o', quotes: ['GPT', '4o'] },
  { keyword: '@scope/package', quotes: ['scope', 'package'] },
  { keyword: 'C++', quotes: ['C', '++'] },
  { keyword: 'Café', quotes: ['Caf', 'é'] },
  { keyword: 'C++ C', quotes: ['C++'] },
  { keyword: 'Node.js Node', quotes: ['Node.js'] },
])(
  'rejects fragmented or incomplete keyword quotes: $keyword / $quotes',
  async ({ keyword, quotes }) => {
    const generator = new NewsPreferenceGenerator(
      structuredModel(() => ({
        interests: quotes.map((sourceText) => ({
          rule: 'Topic coverage',
          sourceText,
        })),
        exclusions: [],
        titleRules: [],
      })),
      role
    )

    await expect(generator.generate(keyword)).rejects.toThrow()
  }
)

test('preserves complete symbolic keywords while allowing standalone punctuation separators', async () => {
  const keywords = ['C++', 'C#', '.NET', 'Node.js', 'GPT-4o', '@scope/package']
  const description = keywords.join(' , ')
  const generator = new NewsPreferenceGenerator(
    structuredModel(() => ({
      interests: keywords.map((sourceText) => ({
        rule: 'Topic coverage',
        sourceText,
      })),
      exclusions: [],
      titleRules: [],
    })),
    role
  )

  const generated = await generator.generate(description)

  expect(generated.description).toBe(description)
  for (const keyword of keywords)
    expect(generated.instruction).toContain(keyword)
})
