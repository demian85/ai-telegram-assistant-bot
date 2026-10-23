import { expect, test } from 'vitest'
import { llmConfigSchema } from '../src/lib/config/schema.js'

const role = { model: 'offline', supportsVision: false }
const config = {
  apiKeyEnvVar: 'TEST_KEY',
  baseUrl: 'https://provider.test',
  roles: {
    chat: {
      ...role,
      systemPrompts: {
        private: 'private={{chatType}}',
        group: 'group={{chatType}}',
      },
    },
    summarizer: { ...role, systemPrompt: '{{period}}:{{messageCount}}' },
    newsPreferences: { ...role, systemPrompt: 'preferences' },
  },
}

test('accepts separate chat prompts and supported summary variables', () => {
  // Given
  const input = config
  // When
  const result = llmConfigSchema.safeParse(input)
  // Then
  expect(result.success).toBe(true)
})

test('rejects the retired shared chat prompt', () => {
  // Given
  const input = {
    ...config,
    roles: { ...config.roles, chat: { ...role, systemPrompt: 'legacy' } },
  }
  // When
  const result = llmConfigSchema.safeParse(input)
  // Then
  expect(result.success).toBe(false)
})

test.each(['private', 'group'] as const)(
  'requires the %s chat prompt',
  (chatType) => {
    // Given
    const systemPrompts: Partial<Record<'private' | 'group', string>> = {
      ...config.roles.chat.systemPrompts,
    }
    delete systemPrompts[chatType]
    // When
    const result = llmConfigSchema.safeParse({
      ...config,
      roles: { ...config.roles, chat: { ...role, systemPrompts } },
    })
    // Then
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['roles', 'chat', 'systemPrompts', chatType],
          }),
        ])
      )
    }
  }
)

test.each([
  '',
  '   ',
  '{{unknown}}',
  '{{period',
  'period}}',
  '{{}}',
  '{{{period}}}',
])('rejects invalid summary template %j', (systemPrompt) => {
  // Given
  const input = {
    ...config,
    roles: { ...config.roles, summarizer: { ...role, systemPrompt } },
  }
  // When
  const result = llmConfigSchema.safeParse(input)
  // Then
  expect(result.success).toBe(false)
})

test.each(['', '   ', '{{unknown}}', '{{period}}', '{{chatType'])(
  'rejects invalid chat template %j',
  (group) => {
    // Given
    const input = {
      ...config,
      roles: {
        ...config.roles,
        chat: {
          ...role,
          systemPrompts: { ...config.roles.chat.systemPrompts, group },
        },
      },
    }
    // When
    const result = llmConfigSchema.safeParse(input)
    // Then
    expect(result.success).toBe(false)
  }
)
