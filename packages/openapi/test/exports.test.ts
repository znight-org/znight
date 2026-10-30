/** Public entries, the manifest and the boundaries of the compiler entry. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import * as compiler from '../src/compiler/index.ts'
import * as emit from '../src/emit/index.ts'
import * as entry from '../src/index.ts'
import * as testing from '../src/testing.ts'
import * as vite from '../src/vite.ts'
import { describe, expect, test as it } from 'bun:test'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, unknown>
  znight: unknown
}

describe('@znight/openapi entries', () => {
  it('exports the runtime API', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'ApiBody',
      'ApiExclude',
      'ApiHeader',
      'ApiOperation',
      'ApiQuery',
      'ApiResponse',
      'ApiSecurity',
      'ApiTags',
      'BUILT_IN_CONVERTERS',
      'CDN_ORIGIN',
      'OPENAPI_METADATA_VERSION',
      'OpenApi',
      'OpenApiDocument',
      'OpenApiPlugin',
      'OpenApiTokens',
      'UI_PACKAGES',
      'buildOpenApiDocument',
      'securityScheme',
      'standardJsonSchemaConverter',
      'valibotConverter',
    ])
  })

  it('declares the subpath entries and the manifest', () => {
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './compiler',
      './emit',
      './vite',
      './testing',
      './package.json',
    ])
    expect(manifest.znight).toEqual({
      apiVersion: 1,
      compiler: '@znight/openapi/compiler',
      provides: [{ export: 'OpenApi', plugin: 'OpenApiPlugin', scope: 'singleton' }],
    })
    expect(Object.keys(emit)).toEqual(['emitOpenApi', 'findViteConfig'])
    expect(Object.keys(vite).sort()).toEqual(['OPENAPI_PLUGIN_NAME', 'openapi'])
    expect(Object.keys(testing)).toEqual(['validateResponse'])
  })

  it('exports a compiler extension', () => {
    expect(compiler.default).toMatchObject({ apiVersion: 1, name: 'openapi' })
    expect(Object.keys(compiler.default.decorators).sort()).toEqual([
      '@znight/openapi#ApiBody',
      '@znight/openapi#ApiExclude',
      '@znight/openapi#ApiHeader',
      '@znight/openapi#ApiOperation',
      '@znight/openapi#ApiQuery',
      '@znight/openapi#ApiResponse',
      '@znight/openapi#ApiSecurity',
      '@znight/openapi#ApiTags',
      '@znight/openapi#OpenApiDocument',
    ])
  })

  it('securityScheme() returns a frozen { name, definition }', () => {
    const scheme = entry.securityScheme('apiKey', { type: 'apiKey', in: 'header', name: 'x-api-key' })
    expect(scheme).toEqual({ name: 'apiKey', definition: { type: 'apiKey', in: 'header', name: 'x-api-key' } })
    expect(Object.isFrozen(scheme)).toBe(true)
  })
})

describe('compiler entry boundaries (architecture §2)', () => {
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const src = resolve(import.meta.dir, '../src')
  const visit = (file: string, seen: Set<string>, bare: Set<string>): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const { path } of transpiler.scan(readFileSync(file, 'utf8')).imports) {
      if (path.startsWith('.')) visit(resolve(dirname(file), path), seen, bare)
      else bare.add(path)
    }
  }

  it('only reaches import-free modules of the package and node:crypto (types of the compiler)', () => {
    const files = new Set<string>()
    const bare = new Set<string>()
    visit(resolve(src, 'compiler/index.ts'), files, bare)
    expect([...bare].sort()).toEqual(['node:crypto'])
    expect([...files].map(file => file.slice(src.length + 1)).sort()).toEqual([
      'compiler/analyze.ts',
      'compiler/document.ts',
      'compiler/generate.ts',
      'compiler/index.ts',
      'compiler/model.ts',
      'compiler/operations.ts',
      'compiler/schemas.ts',
      'compiler/validate.ts',
      'compiler/values.ts',
      'shared.ts',
    ])
  })

  it('runtime entries never reach the compiler extension', () => {
    for (const entryFile of ['index.ts', 'emit/index.ts', 'emit/child.ts', 'vite.ts', 'testing.ts']) {
      const files = new Set<string>()
      visit(resolve(src, entryFile), files, new Set())
      expect([...files].filter(file => file.includes('/compiler/'))).toEqual([])
    }
  })
})
