import type { Message } from 'telegraf/types'
import { expect, test, vi } from 'vitest'
import { NewsPreferenceGenerator } from '../src/lib/news/preferences.js'
import { NewsFilterCommand } from '../src/lib/telegram/news-filter-command.js'
import {
  filterHarness,
  preference,
  structuredModel,
} from './news-filter-helpers.js'

const inclusion =
  'Select articles substantively covering at least one of these interests: AI coding tools, AI agents, coding harness, llm releases, openai, spacex, anthropic, gemini, llm benchmarks, bun, nodejs.'
const titles =
  'Ignore articles whose title contain only a git sha1 or are vague.'
const exclusion = 'Ignore Python related articles.'
const quality = 'Passing mentions and uncertain matches are insufficient.'
const description = `${inclusion} ${titles} ${exclusion} ${quality}`
const criteria = {
  interests: [
    {
      rule: 'Substantive coverage of the listed interests',
      sourceText: inclusion,
    },
    { rule: 'Require substantive, certain matches', sourceText: quality },
  ],
  exclusions: [{ rule: 'Exclude Python articles', sourceText: exclusion }],
  titleRules: [{ rule: 'Reject vague or SHA-only titles', sourceText: titles }],
}
const invalid = {
  ...criteria,
  titleRules: [
    {
      rule: 'Reject vague or SHA-only titles',
      sourceText: titles.replace('contain', 'contains'),
    },
  ],
}
const role = { model: 'generator', systemPrompt: 'generation-role' }

function commandContext() {
  const replies: string[] = []
  return {
    replies,
    ctx: {
      reply: async (text: string): Promise<Message.TextMessage> => {
        replies.push(text)
        return {
          message_id: 1,
          date: 0,
          chat: { id: 1, type: 'private', first_name: 'Alice' },
          text,
        }
      },
      sendChatAction: async (): Promise<true> => true,
    },
  }
}

test.each([
  { failure: 'paraphrased source quote', output: invalid },
  {
    failure: 'incomplete source coverage',
    output: {
      ...criteria,
      interests: [
        {
          rule: 'Substantive coverage of the listed interests',
          sourceText: inclusion.slice(inclusion.indexOf('AI coding tools'), -1),
        },
      ],
    },
  },
])(
  'repairs $failure before saving the reported news filter',
  async ({ output }) => {
    const respond = vi
      .fn()
      .mockReturnValueOnce(output)
      .mockReturnValue(criteria)
    const generator = new NewsPreferenceGenerator(
      structuredModel(respond),
      role
    )
    const { preferences } = filterHarness()
    const command = new NewsFilterCommand(preferences, generator)
    const { ctx, replies } = commandContext()

    await command.handle(ctx, { chatId: 'a', args: description })

    expect((await preferences.resolve('a')).preference).toMatchObject({
      description,
      criteria,
    })
    expect(replies.join('\n')).toContain('News filter saved:')
    expect(respond).toHaveBeenCalledTimes(2)
  }
)

test.each([
  { failure: 'invalid repair', attempts: 2 },
  { failure: 'provider error', attempts: 1 },
])('preserves saved settings after $failure', async ({ failure, attempts }) => {
  const respond = vi.fn(() => {
    if (failure === 'provider error') throw new Error('provider unavailable')
    return invalid
  })
  const generator = new NewsPreferenceGenerator(structuredModel(respond), role)
  const { preferences } = filterHarness()
  const previous = preference('Existing interests')
  await preferences.save('a', previous)
  const command = new NewsFilterCommand(preferences, generator)
  const { ctx, replies } = commandContext()

  await command.handle(ctx, { chatId: 'a', args: description })

  expect((await preferences.resolve('a')).preference).toEqual(previous)
  expect(replies.join('\n')).toContain('Could not finish processing')
  expect(respond).toHaveBeenCalledTimes(attempts)
})

test('viewing a news filter does not call the preference model', async () => {
  const respond = vi.fn(() => invalid)
  const generator = new NewsPreferenceGenerator(structuredModel(respond), role)
  const { preferences } = filterHarness()
  const previous = preference('Existing interests')
  await preferences.save('a', previous)
  const command = new NewsFilterCommand(preferences, generator)
  const { ctx, replies } = commandContext()

  await command.handle(ctx, { chatId: 'a', args: '' })

  expect(replies.join('\n')).toContain(previous.instruction)
  expect(respond).not.toHaveBeenCalled()
})
