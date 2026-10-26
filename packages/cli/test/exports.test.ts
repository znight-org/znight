import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as entry from '../src/index.ts'
import { describe, expect, test as it } from 'bun:test'

describe('public entry', () => {
  it('exports the programmatic API', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'AppSupervisor',
      'COMMANDS',
      'CancelledError',
      'CliError',
      'DEFAULT_FEATURES',
      'ExitCode',
      'FEATURES',
      'HTTP_ADAPTERS',
      'PACKAGE_MANAGERS',
      'SCHEMATICS',
      'UsageError',
      'adaptCompilerModule',
      'cliVersion',
      'createContext',
      'defineCommand',
      'findSchematic',
      'loadCompiler',
      'main',
      'planSchematic',
      'renderProject',
    ])
  })

  it('declares the znight binary, built from src/cli.ts with its shebang', () => {
    const root = join(import.meta.dir, '..')
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(manifest.bin).toEqual({ znight: './dist/cli.mjs' })
    expect(readFileSync(join(root, 'tsdown.config.ts'), 'utf8')).toContain("'src/cli.ts'")
    expect(readFileSync(join(root, 'src/cli.ts'), 'utf8')).toStartWith('#!/usr/bin/env node\n')
  })

  it('reports the version of the package', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'))
    expect(entry.cliVersion()).toBe(manifest.version)
  })
})
