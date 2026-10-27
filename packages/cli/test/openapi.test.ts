/** `znight openapi` and `znight build --openapi`, with fake `@znight/openapi` modules. */
import type { CompilerApi, Diagnostic } from '../src/integrations/compiler.ts'
import type {
  OpenApiEmitApi,
  OpenApiEmitOptionsLike,
  OpenApiEmitResultLike,
  OpenApiVitePluginOptionsLike,
} from '../src/integrations/openapi.ts'

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { repeatedOption } from '../src/commands/openapi.ts'
import { fallbackFormatDiagnostics } from '../src/integrations/compiler.ts'
import { FakeVite } from './fake-vite.ts'
import { runCli, temporaryDirectory } from './helpers.ts'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

let project: { path: string; cleanup: () => void }

beforeEach(() => {
  project = temporaryDirectory()
})

afterEach(() => project.cleanup())

/** A compiler whose only job here is formatting diagnostics and reading znight.config (none). */
function fakeCompiler(): CompilerApi {
  return {
    generate: () => Promise.reject(new Error('not used')),
    check: () => Promise.reject(new Error('not used')),
    createIncremental: () => {
      throw new Error('not used')
    },
    formatDiagnostics: (diagnostics, options) => fallbackFormatDiagnostics(diagnostics, options),
    loadConfig: () => Promise.resolve({ file: undefined, options: {} }),
  }
}

class FakeEmit implements OpenApiEmitApi {
  readonly calls: OpenApiEmitOptionsLike[] = []
  result: (options: OpenApiEmitOptionsLike) => Partial<OpenApiEmitResultLike> = () => ({})
  error: unknown

  emitOpenApi(options: OpenApiEmitOptionsLike): Promise<OpenApiEmitResultLike> {
    this.calls.push(options)
    if (this.error !== undefined) return Promise.reject(this.error)
    const outputs = options.output.map(file => join(options.root, file))
    return Promise.resolve({
      ok: true,
      written: options.check === true ? [] : outputs,
      stale: false,
      staleFiles: [],
      diagnostics: [],
      warnings: [],
      outputs,
      runtime: 'bun',
      document: { paths: { '/books': { get: {}, post: {} }, '/books/{id}': { get: {} } } },
      ...this.result(options),
    })
  }
}

const run = (argv: string[], emit: FakeEmit) =>
  runCli(argv, {
    cwd: project.path,
    services: { loadCompiler: () => Promise.resolve(fakeCompiler()), loadOpenApi: () => Promise.resolve(emit) },
  })

describe('znight openapi', () => {
  it('writes openapi.json at the project root by default', async () => {
    const emit = new FakeEmit()
    const result = await run(['openapi'], emit)
    expect(result.code).toBe(0)
    expect(emit.calls).toEqual([
      { root: project.path, output: ['openapi.json'], compilerOptions: { root: project.path } },
    ])
    expect(result.stdout).toMatch(/✓ Wrote openapi\.json \(3 operations, bun, \d+ms\)/)
  })

  it('passes every option, -o repeated', async () => {
    const emit = new FakeEmit()
    const result = await run(
      [
        'openapi',
        '-o',
        'openapi.json',
        '--output=docs/openapi.yaml',
        '--prefix',
        '/api',
        '--runtime',
        'node',
        '--converters',
        'src/c.ts',
      ],
      emit,
    )
    expect(result.code).toBe(0)
    expect(emit.calls[0]).toMatchObject({
      output: ['openapi.json', 'docs/openapi.yaml'],
      prefix: '/api',
      runtime: 'node',
      converters: 'src/c.ts',
    })
    expect(result.stdout).toContain('✓ Wrote docs/openapi.yaml')
  })

  it('--check: exit 1 and the stale or missing files', async () => {
    const emit = new FakeEmit()
    writeFileSync(join(project.path, 'openapi.json'), '{}')
    emit.result = options => ({
      stale: true,
      staleFiles: [join(options.root, 'openapi.json'), join(options.root, 'dist/openapi.json')],
    })
    const stale = await run(['openapi', '--check', '-o', 'openapi.json', '-o', 'dist/openapi.json'], emit)
    expect(stale.code).toBe(1)
    expect(emit.calls[0]?.check).toBe(true)
    expect(stale.stderr).toContain('✗ openapi.json is out of date')
    expect(stale.stderr).toContain('✗ dist/openapi.json is missing')
    expect(stale.stderr).toContain('run "znight openapi" and commit the result')
    emit.result = () => ({})
    const fresh = await run(['openapi', '--check'], emit)
    expect(fresh.code).toBe(0)
    expect(fresh.stdout).toContain('✓ openapi.json up to date')
  })

  it('prints compile diagnostics and fails before anything runs', async () => {
    const emit = new FakeEmit()
    const error = {
      code: 'ZNIGHT032',
      severity: 'error',
      message: 'ShelfStats.total is a bigint',
      location: { file: join(project.path, 'src/a.ts'), line: 3, column: 5 },
      hints: ['Return a number'],
    } as Diagnostic
    emit.result = () => ({ ok: false, diagnostics: [error], document: undefined })
    const result = await run(['openapi'], emit)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('✗ ZNIGHT032: ShelfStats.total is a bigint')
    expect(result.stderr).toContain('--> src/a.ts:3:5')
    expect(result.stderr).toContain('OpenAPI emission failed: the application does not compile (1 error)')
  })

  it('reports assembly errors with their hints, and warnings', async () => {
    const emit = new FakeEmit()
    emit.error = Object.assign(new Error('ZNIGHT037: Cannot convert a schema to JSON Schema'), {
      hints: ['Add a converter'],
    })
    const failed = await run(['openapi'], emit)
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('OpenAPI emission failed: ZNIGHT037: Cannot convert a schema to JSON Schema')
    expect(failed.stderr).toContain('Add a converter')
    emit.error = undefined
    emit.result = () => ({ warnings: [{ code: 'ZNIGHT037', message: 'documented as any value' }] })
    const warned = await run(['openapi'], emit)
    expect(warned.code).toBe(0)
    expect(warned.stderr).toContain('ZNIGHT037: documented as any value')
  })

  it('checks --prefix', async () => {
    const prefix = await run(['openapi', '--prefix', 'api'], new FakeEmit())
    expect(prefix.code).toBe(2)
    expect(prefix.stderr).toContain('Invalid --prefix "api"')
  })

  it('collects repeated options', () => {
    expect(repeatedOption(['-o', 'a', '--output', 'b,c', '--output=d', '-o=e', '--other', 'f'], 'output', 'o')).toEqual(
      ['a', 'b', 'c', 'd', 'e'],
    )
  })
})

describe('znight build --openapi', () => {
  const vite = (calls: OpenApiVitePluginOptionsLike[]) => ({
    openapi: (options: OpenApiVitePluginOptionsLike = {}) => {
      calls.push(options)
      return { name: 'znight:openapi' }
    },
  })

  it('adds the openapi() plugin to the build (default output, or --openapi=<path>)', async () => {
    const fake = new FakeVite()
    const calls: OpenApiVitePluginOptionsLike[] = []
    const services = { loadVite: () => Promise.resolve(fake), loadOpenApiVite: () => Promise.resolve(vite(calls)) }
    expect((await runCli(['build', '--openapi'], { cwd: project.path, services })).code).toBe(0)
    expect(fake.lastBuild().plugins?.map(plugin => (plugin as { name: string }).name)).toContain('znight:openapi')
    expect((await runCli(['build', '--openapi=docs/api.json'], { cwd: project.path, services })).code).toBe(0)
    expect(calls).toEqual([{}, { output: 'docs/api.json' }])
    expect((await runCli(['build'], { cwd: project.path, services })).code).toBe(0)
    expect(calls).toHaveLength(2)
    expect(fake.lastBuild().plugins?.map(plugin => (plugin as { name: string }).name)).not.toContain('znight:openapi')
  })
})
