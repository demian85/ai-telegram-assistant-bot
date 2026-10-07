import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadAppConfig } from '../src/lib/config/load-config.js'
import {
  llmSupportsVision,
  llmSupportsWebSearch,
} from '../src/lib/llm/model.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function configuration() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'modern-config-'))
  directories.push(rootDir)
  writeFileSync(
    path.join(rootDir, 'config.defaults.json'),
    readFileSync('config.sample.json', 'utf8')
  )
  return { rootDir, config: loadAppConfig({ rootDir }) }
}

test('loads complete modern overrides without obsolete model and capability properties', () => {
  // Given
  const { rootDir, config } = configuration()
  writeFileSync(
    path.join(rootDir, 'config.json'),
    JSON.stringify({
      ...config,
      news: {
        ...config.news,
        relevanceThreshold: 75,
        defaultFilter: 'Developer tools and coding agents',
      },
      llm: {
        ...config.llm,
        roles: {
          ...config.llm.roles,
          chat: { ...config.llm.roles.chat, model: 'custom-chat-model' },
          newsRelevance: { systemPrompt: 'custom-decision-instructions' },
        },
      },
    })
  )
  // When
  const resolved = loadAppConfig({ rootDir })
  // Then
  expect(resolved.llm).not.toHaveProperty('defaultModel')
  expect(resolved.llm.roles.newsRelevance).toEqual({
    systemPrompt: 'custom-decision-instructions',
  })
  expect(resolved.llm.roles.chat.model).toBe('custom-chat-model')
  expect(resolved.news).toMatchObject({
    relevanceThreshold: 75,
    defaultFilter: 'Developer tools and coding agents',
    decisionModel: 'jev-latest',
  })
})

test('uses the summarizer for preference fallback when both legacy and explicit preference models are absent', () => {
  // Given
  const { rootDir, config } = configuration()
  const { newsPreferences: _preferences, ...roles } = config.llm.roles
  writeFileSync(
    path.join(rootDir, 'config.defaults.json'),
    JSON.stringify({
      ...config,
      llm: {
        ...config.llm,
        roles: {
          ...roles,
          summarizer: {
            ...roles.summarizer,
            model: 'summarizer-fallback-model',
          },
        },
      },
    })
  )
  // When
  const resolved = loadAppConfig({ rootDir })
  // Then
  expect(resolved.llm.roles.newsPreferences).toMatchObject({
    model: 'summarizer-fallback-model',
    supportsVision: false,
    supportsWebSearch: false,
  })
  expect(resolved.llm.roles.newsPreferences.model).not.toBe(
    resolved.news.decisionModel
  )
})

test('reports text-only decision capabilities even for legacy role flags', () => {
  // Given
  const { config } = configuration()
  const legacy = {
    ...config,
    llm: {
      ...config.llm,
      roles: {
        ...config.llm.roles,
        newsRelevance: {
          systemPrompt: 'legacy-prompt',
          model: 'old-chat-model',
          supportsVision: true,
          supportsWebSearch: true,
        },
      },
    },
  }
  // When
  const capabilities = {
    vision: llmSupportsVision('newsRelevance', legacy),
    webSearch: llmSupportsWebSearch('newsRelevance', legacy),
  }
  // Then
  expect(capabilities).toEqual({ vision: false, webSearch: false })
  expect(llmSupportsVision('chat', legacy)).toBe(
    config.llm.roles.chat.supportsVision
  )
})

test.each([
  { model: 42 },
  { supportsVision: 'yes' },
  { supportsWebSearch: 'yes' },
])(
  'rejects malformed legacy decision role properties when provided: %j',
  (legacy) => {
    // Given
    const { rootDir, config } = configuration()
    writeFileSync(
      path.join(rootDir, 'config.json'),
      JSON.stringify({
        ...config,
        llm: {
          ...config.llm,
          roles: {
            ...config.llm.roles,
            newsRelevance: { systemPrompt: 'legacy-prompt', ...legacy },
          },
        },
      })
    )
    // When
    const load = () => loadAppConfig({ rootDir })
    // Then
    expect(load).toThrow()
  }
)
