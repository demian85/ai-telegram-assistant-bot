import { test, expect, describe } from 'vitest'
import { loadAppConfig } from '../src/lib/config/load-config.js'
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
    topics: ['AI'],
  },
  llm: {
    apiKeyEnvVar: 'TEST_API_KEY',
    baseUrl: 'https://api.test.com',
    defaultModel: 'test-model',
    roles: {
      chat: {
        model: 'chat-model',
        supportsVision: false,
        systemPrompt: 'You are a test assistant',
      },
      summarizer: {
        model: 'summarizer-model',
        supportsVision: true,
        systemPrompt: 'Summarize this',
      },
      newsRelevance: {
        model: 'relevance-model',
        supportsVision: true,
        systemPrompt: 'Judge relevance',
      },
    },
  },
}

describe('loadAppConfig', () => {
  test('inherits the new role for existing overrides and honors a separate preference model', () => {
    const tempDir = createTempDir()
    const newRole = {
      model: 'preference-default',
      supportsVision: false,
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
      ).toEqual(newRole)

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
      expect(config.llm.roles.newsRelevance.model).toBe('relevance-model')
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
                supportsVision: false,
                systemPrompt: 'role',
              },
            },
          },
        })
      )
      expect(() => loadAppConfig({ rootDir: tempDir })).toThrow(
        /newsPreferences.model/
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
        /Config file must contain a JSON object/
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
          topics: ['AI'],
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
          topics: ['AI'],
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
        /Unknown top-level config key "unknownKey"/
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
        /Unknown top-level config key "invalidSection"/
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
        /Invalid telegram.botUsername.*expected string/
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
        /Invalid news.pollIntervalMinutes.*expected number/
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
        /Invalid llm.roles.chat.supportsVision.*expected boolean/
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
        /Invalid telegram.whitelistedUsers.*expected string\[\]/
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
        /Invalid telegram.whitelistedUsers.*expected string\[\]/
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
        /Invalid news.relevanceThreshold.*expected number/
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
          baseUrl: 'https://api.test.com',
          defaultModel: 'custom-default-model',
          roles: validDefaultsConfig.llm.roles,
        },
      }

      writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify(userConfig)
      )

      const config = loadAppConfig({ rootDir: tempDir })

      expect(config.llm.defaultModel).toBe('custom-default-model')
      expect(config.llm.apiKeyEnvVar).toBe('TEST_API_KEY')
      expect(config.llm.baseUrl).toBe('https://api.test.com')
      expect(config.llm.roles.chat.model).toBe('chat-model')
      expect(config.llm.roles.chat.supportsVision).toBe(false)
    } finally {
      cleanupTempDir(tempDir)
    }
  })
})
