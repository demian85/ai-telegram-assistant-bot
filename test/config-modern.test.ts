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

test.each(['defaults', 'override'])(
  'requires an explicit preference role in %s config',
  (source) => {
    // Given
    const { rootDir, config } = configuration()
    const { newsPreferences: _preferences, ...roles } = config.llm.roles
    if (source === 'defaults') {
      writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(config))
    }
    writeFileSync(
      path.join(
        rootDir,
        source === 'defaults' ? 'config.defaults.json' : 'config.json'
      ),
      JSON.stringify({ ...config, llm: { ...config.llm, roles } })
    )
    // When
    const load = () => loadAppConfig({ rootDir })
    // Then
    expect(load).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'invalid_type',
            path: ['llm', 'roles', 'newsPreferences'],
          }),
        ]),
      })
    )
  }
)

test('reports text-only decision capabilities', () => {
  // Given
  const { config } = configuration()
  // When
  const capabilities = {
    vision: llmSupportsVision('newsRelevance', config),
    webSearch: llmSupportsWebSearch('newsRelevance', config),
  }
  // Then
  expect(capabilities).toEqual({ vision: false, webSearch: false })
})

test.each([
  { model: 'old-chat-model' },
  { supportsVision: true },
  { supportsWebSearch: false },
])(
  'rejects retired decision role properties even with valid values: %j',
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

test.each(['defaults', 'override'])(
  'rejects the retired default LLM model in %s config',
  (source) => {
    // Given
    const { rootDir, config } = configuration()
    const filename =
      source === 'defaults' ? 'config.defaults.json' : 'config.json'
    writeFileSync(
      path.join(rootDir, filename),
      JSON.stringify({
        ...config,
        llm: { ...config.llm, defaultModel: 'old-model' },
      })
    )
    // When
    const load = () => loadAppConfig({ rootDir })
    // Then
    expect(load).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'unrecognized_keys',
            path: ['llm'],
            keys: ['defaultModel'],
          }),
        ]),
      })
    )
  }
)

test.each(['defaults', 'override'])(
  'rejects retired news topics in %s config',
  (source) => {
    // Given
    const { rootDir, config } = configuration()
    const filename =
      source === 'defaults' ? 'config.defaults.json' : 'config.json'
    writeFileSync(
      path.join(rootDir, filename),
      JSON.stringify({ ...config, news: { ...config.news, topics: ['AI'] } })
    )
    // When
    const load = () => loadAppConfig({ rootDir })
    // Then
    expect(load).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'unrecognized_keys',
            path: ['news'],
            keys: ['topics'],
          }),
        ]),
      })
    )
  }
)
