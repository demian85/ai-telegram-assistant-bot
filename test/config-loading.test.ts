import { test, expect, describe } from 'vitest'
import { loadAppConfig } from '../src/lib/config/load-config.js'
import { telegramConfigSchema } from '../src/lib/config/schema.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'config-test-'))
}

function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

const validDefaultsConfig = {
  telegram: {
    botUsername: '@testbot',
    whitelistedUsers: [],
  },
  news: {
    feeds: ['https://example.com/feed.xml'],
    pollIntervalMinutes: 5,
    deliveryCheckIntervalSeconds: 60,
    relevanceThreshold: 70,
    maxArticlesPerPoll: 10,
    defaultFilter: 'AI',
  },
  llm: {
    apiKeyEnvVar: 'TEST_API_KEY',
    baseUrl: 'https://api.test.com',
    roles: {
      chat: {
        model: 'chat-model',
        supportsVision: false,
        systemPrompts: { private: 'private-test', group: 'group-test' },
      },
      summarizer: {
        model: 'summarizer-model',
        systemPrompt: 'Summarize this',
      },
      newsPreferences: {
        model: 'preference-model',
        systemPrompt: 'Compile preferences',
      },
    },
  },
}

describe('telegram group allowlist schema', () => {
  test('accepts negative numeric group IDs as strings', () => {
    // Given both basic group and supergroup ID strings.
    const allowedGroupIds = ['-1', '-100', '-1001234567890']

    // When Telegram configuration is parsed.
    const config = telegramConfigSchema.parse({
      ...validDefaultsConfig.telegram,
      allowedGroupIds,
    })

    // Then the IDs retain their exact string representation.
    expect(config.allowedGroupIds).toEqual(allowedGroupIds)
  })

  test.each([
    '',
    '100',
    '0',
    '-0',
    '-01',
    '-1.5',
    '-1e3',
    '-',
    '-abc',
    ' -100',
    '-100 ',
    '-100\n',
    'group:-100',
    -100,
    null,
  ])('rejects invalid group ID %j', (id) => {
    // Given an allowlist containing an invalid ID.
    const input = {
      ...validDefaultsConfig.telegram,
      allowedGroupIds: [id],
    }

    // When the schema validates the Telegram configuration.
    const result = telegramConfigSchema.safeParse(input)

    // Then it identifies the invalid allowlist entry.
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['allowedGroupIds', 0] }),
        ])
      )
    }
  })

  test.each(['-100', -100, null, {}])(
    'rejects a non-array group allowlist %j',
    (allowedGroupIds) => {
      // Given an allowlist with the wrong container type.
      const input = { ...validDefaultsConfig.telegram, allowedGroupIds }

      // When Telegram configuration is validated.
      const result = telegramConfigSchema.safeParse(input)

      // Then only an array can satisfy the allowlist contract.
      expect(result.success).toBe(false)
    }
  )

  test.each([{}, { allowedGroupIds: [] }])(
    'resolves omitted or empty group access to no groups: %j',
    (input) => {
      // Given legacy configuration or an explicit empty allowlist.
      const telegram = { ...validDefaultsConfig.telegram, ...input }

      // When configuration defaults are applied.
      const config = telegramConfigSchema.parse(telegram)

      // Then no group receives access.
      expect(config.allowedGroupIds).toEqual([])
    }
  )
})

describe('loadAppConfig', () => {
  test.each(['', '   ', 'x'.repeat(3001)])(
    'rejects invalid default filter length',
    (defaultFilter) => {
      const tempDir = createTempDir()
      try {
        writeFileSync(
          path.join(tempDir, 'config.defaults.json'),
          JSON.stringify({
            ...validDefaultsConfig,
            news: { ...validDefaultsConfig.news, defaultFilter },
          })
        )
        expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
          expect.objectContaining({
            issues: expect.arrayContaining([
              expect.objectContaining({
                code: defaultFilter.length > 3000 ? 'too_big' : 'too_small',
                path: ['news', 'defaultFilter'],
              }),
            ]),
          })
        )
      } finally {
        cleanupTempDir(tempDir)
      }
    }
  )
  test('honors a separate preference model in a complete override', () => {
    const tempDir = createTempDir()
    const newRole = {
      model: 'preference-default',
      systemPrompt: 'preference-role',
    }
    try {
      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify({
          ...validDefaultsConfig,
          llm: {
            ...validDefaultsConfig.llm,
            roles: {
              ...validDefaultsConfig.llm.roles,
              newsPreferences: newRole,
            },
          },
        })
      )
      writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify(validDefaultsConfig)
      )
      expect(
        loadAppConfig({ rootDir: tempDir }).llm.roles.newsPreferences
      ).toEqual(validDefaultsConfig.llm.roles.newsPreferences)

      writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify({
          ...validDefaultsConfig,
          llm: {
            ...validDefaultsConfig.llm,
            roles: {
              ...validDefaultsConfig.llm.roles,
              newsPreferences: { ...newRole, model: 'preference-override' },
            },
          },
        })
      )
      const config = loadAppConfig({ rootDir: tempDir })
      expect(config.llm.roles.newsPreferences.model).toBe('preference-override')
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('rejects a malformed preference role', () => {
    const tempDir = createTempDir()
    try {
      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify({
          ...validDefaultsConfig,
          llm: {
            ...validDefaultsConfig.llm,
            roles: {
              ...validDefaultsConfig.llm.roles,
              newsPreferences: {
                model: 42,
                systemPrompt: 'role',
              },
            },
          },
        })
      )
      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'invalid_type',
              path: ['llm', 'roles', 'newsPreferences', 'model'],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })
  test('loads defaults config successfully', () => {
    const tempDir = createTempDir()

    try {
      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(validDefaultsConfig)
      )

      const config = loadAppConfig({ rootDir: tempDir })

      expect(config.telegram.botUsername).toBe('@testbot')
      expect(config.telegram.allowedGroupIds).toEqual([])
      expect(config.news.feeds).toEqual(['https://example.com/feed.xml'])
      expect(config.llm.roles.chat.supportsVision).toBe(false)
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('throws when defaults config is missing', () => {
    const tempDir = createTempDir()

    try {
      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        /Required config file not found/
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('throws on invalid JSON in defaults file', () => {
    const tempDir = createTempDir()

    try {
      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        'not valid json{'
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        /Failed to parse config file/
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('throws when config is not an object', () => {
    const tempDir = createTempDir()

    try {
      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        '"just a string"'
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'invalid_type',
              path: [],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('deep merges user config with defaults', () => {
    const tempDir = createTempDir()

    try {
      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(validDefaultsConfig)
      )

      const userConfig = {
        telegram: {
          botUsername: '@custombot',
          whitelistedUsers: [],
        },
        news: {
          feeds: ['https://custom.com/feed.xml'],
          pollIntervalMinutes: 5,
          deliveryCheckIntervalSeconds: 60,
          relevanceThreshold: 70,
          maxArticlesPerPoll: 10,
          defaultFilter: 'AI',
        },
        llm: validDefaultsConfig.llm,
      }

      writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify(userConfig)
      )

      const config = loadAppConfig({ rootDir: tempDir })

      expect(config.telegram.botUsername).toBe('@custombot')
      expect(config.news.feeds).toEqual(['https://custom.com/feed.xml'])
      expect(config.telegram.whitelistedUsers).toEqual([])
      expect(config.news.pollIntervalMinutes).toBe(5)
      expect(config.llm.apiKeyEnvVar).toBe('TEST_API_KEY')
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('user config can add new feeds without losing defaults', () => {
    const tempDir = createTempDir()

    try {
      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(validDefaultsConfig)
      )

      const userConfig = {
        telegram: validDefaultsConfig.telegram,
        news: {
          feeds: ['https://custom.com/feed.xml', 'https://another.com/rss'],
          pollIntervalMinutes: 5,
          deliveryCheckIntervalSeconds: 60,
          relevanceThreshold: 70,
          maxArticlesPerPoll: 10,
          defaultFilter: 'AI',
        },
        llm: validDefaultsConfig.llm,
      }

      writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify(userConfig)
      )

      const config = loadAppConfig({ rootDir: tempDir })

      expect(config.news.feeds).toEqual([
        'https://custom.com/feed.xml',
        'https://another.com/rss',
      ])
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('throws on unknown top-level key in defaults', () => {
    const tempDir = createTempDir()

    try {
      const configWithUnknownKey = {
        ...validDefaultsConfig,
        unknownKey: 'value',
      }

      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(configWithUnknownKey)
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'unrecognized_keys',
              path: [],
              keys: ['unknownKey'],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('throws on unknown top-level key in user config', () => {
    const tempDir = createTempDir()

    try {
      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(validDefaultsConfig)
      )

      const userConfig = {
        invalidSection: {},
      }

      writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify(userConfig)
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'unrecognized_keys',
              path: [],
              keys: ['invalidSection'],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('validates required string fields', () => {
    const tempDir = createTempDir()

    try {
      const invalidConfig = {
        ...validDefaultsConfig,
        telegram: {
          ...validDefaultsConfig.telegram,
          botUsername: 123,
        },
      }

      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(invalidConfig)
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'invalid_type',
              path: ['telegram', 'botUsername'],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('validates required number fields', () => {
    const tempDir = createTempDir()

    try {
      const invalidConfig = {
        ...validDefaultsConfig,
        news: {
          ...validDefaultsConfig.news,
          pollIntervalMinutes: 'five',
        },
      }

      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(invalidConfig)
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'invalid_type',
              path: ['news', 'pollIntervalMinutes'],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('validates required boolean fields', () => {
    const tempDir = createTempDir()

    try {
      const invalidConfig = {
        ...validDefaultsConfig,
        llm: {
          ...validDefaultsConfig.llm,
          roles: {
            ...validDefaultsConfig.llm.roles,
            chat: {
              ...validDefaultsConfig.llm.roles.chat,
              supportsVision: 'yes',
            },
          },
        },
      }

      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(invalidConfig)
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'invalid_type',
              path: ['llm', 'roles', 'chat', 'supportsVision'],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('validates required string array fields', () => {
    const tempDir = createTempDir()

    try {
      const invalidConfig = {
        ...validDefaultsConfig,
        telegram: {
          ...validDefaultsConfig.telegram,
          whitelistedUsers: 'user1',
        },
      }

      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(invalidConfig)
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'invalid_type',
              path: ['telegram', 'whitelistedUsers'],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('validates string array elements are all strings', () => {
    const tempDir = createTempDir()

    try {
      const invalidConfig = {
        ...validDefaultsConfig,
        telegram: {
          ...validDefaultsConfig.telegram,
          whitelistedUsers: ['user1', 123, 'user2'],
        },
      }

      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(invalidConfig)
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'invalid_type',
              path: ['telegram', 'whitelistedUsers', 1],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('rejects NaN as invalid number', () => {
    const tempDir = createTempDir()

    try {
      const invalidConfig = {
        ...validDefaultsConfig,
        news: {
          ...validDefaultsConfig.news,
          relevanceThreshold: NaN,
        },
      }

      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(invalidConfig)
      )

      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'invalid_type',
              path: ['news', 'relevanceThreshold'],
            }),
          ]),
        })
      )
    } finally {
      cleanupTempDir(tempDir)
    }
  })

  test('nested objects are deeply merged', () => {
    const tempDir = createTempDir()

    try {
      writeFileSync(
        path.join(tempDir, 'config.defaults.json'),
        JSON.stringify(validDefaultsConfig)
      )

      const userConfig = {
        telegram: validDefaultsConfig.telegram,
        news: validDefaultsConfig.news,
        llm: {
          apiKeyEnvVar: 'TEST_API_KEY',
          baseUrl: 'https://custom.test.com',
          roles: validDefaultsConfig.llm.roles,
        },
      }

      writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify(userConfig)
      )

      const config = loadAppConfig({ rootDir: tempDir })

      expect(config.llm.apiKeyEnvVar).toBe('TEST_API_KEY')
      expect(config.llm.baseUrl).toBe('https://custom.test.com')
      expect(config.llm.roles.chat.model).toBe('chat-model')
      expect(config.llm.roles.chat.supportsVision).toBe(false)
    } finally {
      cleanupTempDir(tempDir)
    }
  })
})
