import type { Message } from 'telegraf/types'
import { expect, test, vi } from 'vitest'
import { NewsPreferenceGenerator } from '../src/lib/news/preferences.js'
import { NewsFilterCommand } from '../src/lib/telegram/news-filter-command.js'
import { renderCriteria } from '../src/lib/news/preference-schema.js'
import { filterHarness, structuredModel } from './news-filter-helpers.js'

const description = 'Codex '.repeat(500).trimEnd() + '.'
const unicodeDescription = 'Codex \u{1F680}'.repeat(375)
const criteria = {
  interests: [{ rule: 'Substantive Codex coverage', sourceText: description }],
  exclusions: [],
  titleRules: [],
}

test('generates and persists maximum-length preferences with complete provenance', async () => {
  const generator = new NewsPreferenceGenerator(
    structuredModel(() => criteria),
    {
      model: 'generator',
      systemPrompt: 'generation-role',
    }
  )
  const { preferences } = filterHarness()

  const generated = await generator.generate(description)
  await preferences.save('a', generated)

  expect(description).toHaveLength(3000)
  expect((await preferences.resolve('a')).preference).toEqual(generated)
  expect(generated.instruction).toContain(description)
})

test('rejects overlength input before calling the provider', async () => {
  const respond = vi.fn(() => criteria)
  const generator = new NewsPreferenceGenerator(structuredModel(respond), {
    model: 'generator',
    systemPrompt: 'generation-role',
  })

  await expect(generator.generate(description + 'x')).rejects.toThrow()

  expect(respond).not.toHaveBeenCalled()
})

test.each([
  ['save', description],
  ['view', description],
  ['save', unicodeDescription],
  ['view', unicodeDescription],
] as const)(
  'sends every compiled character in bounded Telegram messages on %s',
  async (operation, input) => {
    const { preferences } = filterHarness()
    const longCriteria = {
      interests: Array.from({ length: 3 }, (_, index) => ({
        rule: `Codex requirement ${index}`,
        sourceText: input,
      })),
      exclusions: [],
      titleRules: [],
    }
    const generated = {
      mode: 'custom',
      version: 2,
      description: input,
      criteria: longCriteria,
      instruction: renderCriteria(longCriteria),
      revision: '7bf8ed72-be02-4778-b1d0-bcbf4c7c39f6',
      generatedAt: '2026-09-29T18:07:12.431Z',
      model: 'generator',
    } as const
    const replies: string[] = []
    const reply = vi.fn(async (text: string): Promise<Message.TextMessage> => {
      expect(text.length).toBeLessThanOrEqual(4096)
      expect(text.isWellFormed()).toBe(true)
      replies.push(text)
      return {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: 'private', first_name: 'Alice' },
        text,
      }
    })
    const ctx = { reply, sendChatAction: async (): Promise<true> => true }
    const command = new NewsFilterCommand(preferences, {
      generate: async () => generated,
    })
    if (operation === 'view') {
      await preferences.save('a', generated)
    }

    await command.handle(ctx, {
      chatId: 'a',
      args: operation === 'save' ? input : '',
    })

    expect(replies.join('')).toContain(generated.instruction)
    expect(reply.mock.calls.length).toBeGreaterThan(1)
    expect((await preferences.resolve('a')).preference).toEqual(generated)
  }
)
