import fs from 'node:fs'

import * as entry from '../src/index.ts'
import { describe, expect, test as it } from 'bun:test'

const PACKAGE = new URL('../package.json', import.meta.url)
const TSDOWN = new URL('../tsdown.config.ts', import.meta.url)

describe('public entries', () => {
  it('the root entry exposes the programmatic API, the Vite plugin (also default) and the Bun API', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'COMPILER_VERSION',
      'DEFAULT_APP_ENTRY',
      'DEFAULT_EXCLUDE',
      'DEFAULT_INCLUDE',
      'DEFAULT_OUT_FILE',
      'DEFAULT_RUNTIME_CONDITIONS',
      'DEFAULT_SCAN_CONDITIONS',
      'EXTENSION_API_VERSION',
      'PROVIDERS_FILE',
      'PROVIDERS_SCHEMA_VERSION',
      'Project',
      'SOURCE_CONDITION',
      'ValueRef',
      'ZNIGHT_CONFIG_FILES',
      'analyze',
      'analyzeProject',
      'compile',
      'createCompiler',
      'createGenBuilders',
      'createPreload',
      'default',
      'discoverExtensionModules',
      'formatDiagnostics',
      'generate',
      'isGenNode',
      'loadExtensions',
      'loadZnightConfig',
      'normalizeOptions',
      'renderErrorModule',
      'validateExtension',
      'znight',
      'znightBunPlugin',
    ])
    expect(entry.default).toBe(entry.znight)
    expect(entry.znight().name).toBe('znight')
  })

  it('package.json exports and tsdown entries agree (`.` and `./bun`)', () => {
    const manifest = JSON.parse(fs.readFileSync(PACKAGE, 'utf8')) as { exports: Record<string, unknown> }
    expect(manifest.exports['.']).toEqual({
      '@znight/source': './src/index.ts',
      types: './dist/index.d.mts',
      default: './dist/index.mjs',
    })
    expect(manifest.exports['./bun']).toEqual({
      '@znight/source': './src/bun.ts',
      types: './dist/bun.d.mts',
      default: './dist/bun.mjs',
    })
    expect(fs.readFileSync(TSDOWN, 'utf8')).toContain("entry: ['src/index.ts', 'src/bun.ts']")
  })

  it('the root entry never loads Vite (type-only imports)', () => {
    for (const file of ['vite.ts', 'bun-plugin.ts', 'strip.ts', 'watch.ts', 'index.ts']) {
      const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/^import (?!type )[^\n]* from 'vite'/m)
    }
  })
})
