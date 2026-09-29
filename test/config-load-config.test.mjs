import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test, expect } from 'vitest'

const require = createRequire(import.meta.url)
const { loadAppConfig } = require('../src/lib/config/load-config.ts')

function withTempConfigDir(files, run) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'venice-config-test-'))

  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(rootDir, relativePath)
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, contents)
    }

    run(rootDir)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

function createDefaultsConfigJson() {
  return JSON.stringify(
    {
      telegram: {
        botUsername: 'default-bot',
        whitelistedUsers: ['alice', 'bob'],
      },
      news: {
        feeds: ['https://feeds.test/default.xml'],
        pollIntervalMinutes: 5,
        deliveryCheckIntervalSeconds: 60,
        relevanceThreshold: 70,
        maxArticlesPerPoll: 10,
        topics: ['ai', 'llms'],
      },
      llm: {
        apiKeyEnvVar: 'LLM_API_KEY',
        baseUrl: 'https://llm.test/api',
        defaultModel: 'baseline-model',
        roles: {
          chat: {
            model: 'chat-default',
            supportsVision: false,
            systemPrompt: 'chat default prompt',
          },
          summarizer: {
            model: 'summarizer-default',
            supportsVision: true,
            systemPrompt: 'summarizer default prompt',
          },
          newsRelevance: {
            model: 'news-default',
            supportsVision: true,
            systemPrompt: 'news default prompt',
          },
        },
      },
    },
    null,
    2
  )
}

test('loadAppConfig deep-merges objects while replacing arrays and scalars', () => {
  withTempConfigDir(
    {
      'config.defaults.json': createDefaultsConfigJson(),
      'config.json': JSON.stringify(
        {
          telegram: {
            botUsername: 'override-bot',
            whitelistedUsers: ['carol'],
          },
          news: {
            feeds: ['https://feeds.test/override.xml'],
            pollIntervalMinutes: 5,
            deliveryCheckIntervalSeconds: 60,
            relevanceThreshold: 85,
            maxArticlesPerPoll: 10,
            topics: ['agents'],
          },
          llm: {
            apiKeyEnvVar: 'LLM_API_KEY',
            baseUrl: 'https://override.test/api',
            defaultModel: 'baseline-model',
            roles: {
              chat: {
                model: 'chat-default',
                supportsVision: false,
                systemPrompt: 'chat override prompt',
              },
              summarizer: {
                model: 'summarizer-default',
                supportsVision: true,
                systemPrompt: 'summarizer default prompt',
              },
              newsRelevance: {
                model: 'news-default',
                supportsVision: true,
                systemPrompt: 'news default prompt',
              },
            },
          },
        },
        null,
        2
      ),
    },
    (rootDir) => {
      const config = loadAppConfig({ rootDir })

      expect(config.telegram).toEqual({
        botUsername: 'override-bot',
        whitelistedUsers: ['carol'],
      })
      expect(config.news).toEqual({
        feeds: ['https://feeds.test/override.xml'],
        pollIntervalMinutes: 5,
        deliveryCheckIntervalSeconds: 60,
        relevanceThreshold: 85,
        maxArticlesPerPoll: 10,
        topics: ['agents'],
      })
      expect(config.llm).toEqual({
        apiKeyEnvVar: 'LLM_API_KEY',
        baseUrl: 'https://override.test/api',
        defaultModel: 'baseline-model',
        roles: {
          newsPreferences: {
            model: 'news-default',
            supportsVision: false,
            supportsWebSearch: false,
            systemPrompt: expect.any(String),
          },
          chat: {
            model: 'chat-default',
            supportsVision: false,
            systemPrompt: 'chat override prompt',
          },
          summarizer: {
            model: 'summarizer-default',
            supportsVision: true,
            systemPrompt: 'summarizer default prompt',
          },
          newsRelevance: {
            model: 'news-default',
            supportsVision: true,
            systemPrompt: 'news default prompt',
          },
        },
      })
    }
  )
})

test('loadAppConfig ignores a missing optional config.json', () => {
  withTempConfigDir(
    {
      'config.defaults.json': createDefaultsConfigJson(),
    },
    (rootDir) => {
      const config = loadAppConfig({ rootDir })

      expect(config.telegram.botUsername).toBe('default-bot')
      expect(config.news.feeds).toEqual(['https://feeds.test/default.xml'])
      expect(config.llm.roles.chat.model).toBe('chat-default')
    }
  )
})

test('loadAppConfig rejects unknown top-level keys from config.json with file path', () => {
  withTempConfigDir(
    {
      'config.defaults.json': createDefaultsConfigJson(),
      'config.json': JSON.stringify({ unexpected: true }, null, 2),
    },
    (rootDir) => {
      expect(() => loadAppConfig({ rootDir })).toThrow(
        /Unknown top-level config key "unexpected".*config\.json/
      )
    }
  )
})

test('loadAppConfig surfaces malformed JSON with the offending file path', () => {
  withTempConfigDir(
    {
      'config.defaults.json': '{\n  "telegram": ',
    },
    (rootDir) => {
      expect(() => loadAppConfig({ rootDir })).toThrow(
        /Failed to parse config file .*config\.defaults\.json/
      )
    }
  )
})
