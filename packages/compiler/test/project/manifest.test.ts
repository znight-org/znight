import type { PackageInfo } from '../../src/project/index.ts'

import { MANIFEST_API_VERSION, readManifest } from '../../src/project/index.ts'
import { describe, expect, test as it } from 'bun:test'

function packageWith(znight: unknown, name: string | null = '@acme/obs'): PackageInfo {
  const json: Record<string, unknown> = { ...(name === null ? {} : { name }), version: '1.0.0', znight }
  return {
    name: name ?? undefined,
    publicName: name ?? undefined,
    version: '1.0.0',
    dir: '/repo/node_modules/@acme/obs',
    packageJsonPath: '/repo/node_modules/@acme/obs/package.json',
    text: JSON.stringify(json, null, 2),
    json,
  }
}

describe('readManifest', () => {
  it('returns nothing for packages without a manifest', () => {
    const info = packageWith(undefined)
    expect(readManifest({ ...info, json: { name: '@acme/obs' } })).toEqual({ manifest: undefined, diagnostics: [] })
  })

  it('reads a complete manifest', () => {
    const result = readManifest(
      packageWith({
        apiVersion: 1,
        compiler: '@acme/obs/compiler',
        provides: [
          { export: 'Logger', plugin: 'ObservabilityPlugin', scope: 'singleton' },
          { export: 'HttpContext', plugin: 'HttpPlugin', scope: 'request', optional: true },
          { export: 'Tracer' },
        ],
        interceptors: [{ decorator: 'Logged', interceptor: 'LoggedInterceptor' }],
        library: 'source',
        providers: './dist/znight.providers.json',
      }),
    )
    expect(result.diagnostics).toEqual([])
    expect(result.manifest).toEqual({
      packageName: '@acme/obs',
      packageDir: '/repo/node_modules/@acme/obs',
      apiVersion: MANIFEST_API_VERSION,
      compiler: ['@acme/obs/compiler'],
      provides: [
        {
          export: 'Logger',
          identity: '@acme/obs#Logger',
          plugin: 'ObservabilityPlugin',
          scope: 'singleton',
          optional: false,
        },
        {
          export: 'HttpContext',
          identity: '@acme/obs#HttpContext',
          plugin: 'HttpPlugin',
          scope: 'request',
          optional: true,
        },
        { export: 'Tracer', identity: '@acme/obs#Tracer', plugin: undefined, scope: 'singleton', optional: false },
      ],
      interceptors: [
        {
          decorator: 'Logged',
          decoratorIdentity: '@acme/obs#Logged',
          interceptor: 'LoggedInterceptor',
          interceptorIdentity: '@acme/obs#LoggedInterceptor',
        },
      ],
      library: 'source',
      providers: '/repo/node_modules/@acme/obs/dist/znight.providers.json',
    })
  })

  it('accepts an array of compiler extension modules', () => {
    const result = readManifest(packageWith({ apiVersion: 1, compiler: ['@acme/obs/a', '@acme/obs/b'] }))
    expect(result.manifest?.compiler).toEqual(['@acme/obs/a', '@acme/obs/b'])
  })

  it('a missing apiVersion is a ZNIGHT018 warning and version 1 is assumed', () => {
    const result = readManifest(packageWith({ provides: [] }))
    expect(result.manifest?.apiVersion).toBe(1)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ code: 'ZNIGHT018', severity: 'warning' })
    expect(result.diagnostics[0]?.message).toContain('no "apiVersion"')
  })

  it('a newer apiVersion is a ZNIGHT018 error asking to upgrade the compiler, the manifest is ignored', () => {
    const result = readManifest(packageWith({ apiVersion: 2 }))
    expect(result.manifest).toBeUndefined()
    expect(result.diagnostics[0]).toMatchObject({ code: 'ZNIGHT018', severity: 'error' })
    expect(result.diagnostics[0]?.hints).toEqual(['Upgrade @znight/compiler to a version supporting this package'])
  })

  it('an older apiVersion asks to upgrade the package', () => {
    const result = readManifest(packageWith({ apiVersion: 0 }))
    expect(result.diagnostics[0]?.hints).toEqual(['Upgrade @acme/obs to a version built for this compiler'])
  })

  it('the diagnostic points at the "znight" key of package.json', () => {
    const info = packageWith({ apiVersion: 'one' })
    const result = readManifest(info)
    const start = info.text.indexOf('"znight"')
    expect(result.diagnostics[0]?.location).toEqual({
      file: '/repo/node_modules/@acme/obs/package.json',
      line: 4,
      column: 3,
      endLine: 4,
      endColumn: 11,
      start,
      end: start + 8,
    })
    expect(result.diagnostics[0]?.message).toBe('@acme/obs: manifest "apiVersion" must be an integer (got "one")')
  })

  it('rejects a non-object manifest and nameless packages', () => {
    expect(readManifest(packageWith('source')).diagnostics[0]?.message).toContain('must be an object')
    expect(readManifest(packageWith({ apiVersion: 1 }, null)).diagnostics[0]?.message).toContain('must have a "name"')
  })

  it('reports and skips malformed entries, keeping the valid ones', () => {
    const result = readManifest(
      packageWith({
        apiVersion: 1,
        compiler: ['', 42],
        provides: [
          { export: 'Valid' },
          { export: 'not valid' },
          { export: 'Bad', scope: 'global' },
          'nope',
          { export: 'X', plugin: 1 },
          { export: 'Y', optional: 'yes' },
        ],
        interceptors: { decorator: 'Logged' },
        library: 'compiled',
        providers: 42,
      }),
    )
    expect(result.manifest?.provides.map(provided => provided.export)).toEqual(['Valid'])
    expect(result.manifest?.compiler).toEqual([])
    expect(result.manifest?.interceptors).toEqual([])
    expect(result.manifest?.library).toBeUndefined()
    expect(result.manifest?.providers).toBeUndefined()
    expect(result.diagnostics.map(diagnostic => diagnostic.message.replace('@acme/obs: ', ''))).toEqual([
      'manifest "compiler" must be a module specifier or an array of specifiers (got "")',
      'manifest "compiler" must be a module specifier or an array of specifiers (got 42)',
      'manifest "provides[1].export" must be an export name (got "not valid")',
      "manifest \"provides[2].scope\" must be 'singleton', 'request' or 'transient' (got \"global\")",
      'manifest "provides[3]" must be an object',
      'manifest "provides[4].plugin" must be a string',
      'manifest "provides[5].optional" must be a boolean',
      'manifest "interceptors" must be an array',
      'manifest "library" must be \'source\' (got "compiled")',
      'manifest "providers" must be a path to a znight.providers.json file',
    ])
    expect(
      result.diagnostics.every(diagnostic => diagnostic.code === 'ZNIGHT018' && diagnostic.severity === 'error'),
    ).toBe(true)
  })

  it('reports invalid interceptor entries', () => {
    const result = readManifest(
      packageWith({
        apiVersion: 1,
        interceptors: [{ decorator: 'Logged' }, { interceptor: 'X' }, { decorator: 'A', interceptor: 'B' }],
      }),
    )
    expect(result.manifest?.interceptors.map(entry => entry.decorator)).toEqual(['A'])
    expect(result.diagnostics).toHaveLength(2)
  })
})
