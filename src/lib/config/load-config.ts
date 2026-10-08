import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import mergeWith from 'lodash/mergeWith.js'
import { z } from 'zod'

import type { AppConfig } from './types.js'
import { appConfigSchema } from './schema.js'

type LoadAppConfigOptions = {
  rootDir?: string
}

export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
  const rootDir = options.rootDir ?? process.cwd()
  const defaultsPath = path.resolve(rootDir, 'config.defaults.json')
  const userConfigPath = path.resolve(rootDir, 'config.json')

  if (!existsSync(defaultsPath)) {
    throw new Error(`Required config file not found: ${defaultsPath}`)
  }

  const defaults = appConfigSchema.parse(readJsonFile(defaultsPath), {
    error: (issue) => `${defaultsPath}: ${z.locales.en().localeError(issue)}`,
  })
  if (!existsSync(userConfigPath)) return defaults

  const input = readJsonFile(userConfigPath)
  if (z.strictObject({}).safeParse(input).success) return defaults

  const override = appConfigSchema.parse(input, {
    error: (issue) => `${userConfigPath}: ${z.locales.en().localeError(issue)}`,
  })
  return mergeWith(defaults, override, (_base, value: unknown) =>
    Array.isArray(value) ? value : undefined
  )
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse config file ${filePath}: ${message}`, {
      cause: error,
    })
  }
}
