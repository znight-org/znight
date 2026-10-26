/**
 * The compiled-library flow (opt-in with the end-to-end tests: `ZNIGHT_E2E=1 bun test`).
 *
 * In this monorepo `@znight-examples/shared` is a *source* library: users-api compiles its
 * TypeScript sources. A library published to a registry ships JavaScript instead, plus the provider
 * metadata the compiler cannot recover from `.d.ts` files (decorators: scopes, qualifiers,
 * injection points). This test plays that scenario end to end:
 *
 * 1. builds the library: JavaScript + declarations (`bun run build` = tsc), then its provider
 *    metadata with the compiler in library mode (`generate({ library: true })` →
 *    `dist/znight.providers.json`);
 * 2. "publishes" it: a package made of `dist/` and a manifest whose entry points to `dist/` and
 *    whose `znight.providers` references the metadata (what a pack / publish step produces);
 * 3. installs it into a copy of users-api (`node_modules/@znight-examples/shared` is now that
 *    published package, not a link to the sources), then compiles, type-checks, builds and runs the
 *    copy on Node.js and Bun.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { type CompileResult, compile, generate } from '@znight/compiler'

import { executableOf, expectSuccess, fetchWhenUp, freePort, run, start } from './support/processes.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const enabled = process.env.ZNIGHT_E2E === '1'
const API = resolve(import.meta.dir, '..')
const SHARED = resolve(API, '../../packages/shared')
const ZNIGHT = join(API, 'node_modules/.bin/znight')
const TIMEOUT = 60_000

interface Manifest {
  readonly name: string
  readonly version: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

interface ProvidersFile {
  readonly schemaVersion: number
  readonly package: string
  readonly providers: readonly { readonly token: string; readonly importRoute: { readonly specifier: string } }[]
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T

describe.skipIf(!enabled)('compiled provider library (ZNIGHT_E2E=1)', () => {
  let work: string
  let app: string

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'znight-compiled-library-'))
    app = join(work, 'users-api')

    // 1. library build: JavaScript and declarations, then the provider metadata (library mode)
    expectSuccess(await run('bun', ['run', 'build'], { cwd: SHARED }), 'bun run build (shared)')
    const library = await generate({ root: SHARED, library: true, mode: 'build' })
    expect(library.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    expect(library.library?.file).toBe(join(SHARED, 'dist/znight.providers.json'))

    // 2. the published package: dist/ + a manifest pointing to it
    const manifest = readJson<Manifest>(join(SHARED, 'package.json'))
    const published = join(app, 'node_modules', manifest.name)
    cpSync(join(SHARED, 'dist'), join(published, 'dist'), { recursive: true })
    writeFileSync(
      join(published, 'package.json'),
      `${JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          type: 'module',
          exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
          dependencies: manifest.dependencies,
          znight: { apiVersion: 1, providers: './dist/znight.providers.json' },
        },
        null,
        2,
      )}\n`,
    )

    // 3. a copy of users-api: its sources, and its other dependencies linked as installed
    for (const file of ['package.json', 'tsconfig.json', 'vite.config.ts', 'znight.config.ts']) {
      cpSync(join(API, file), join(app, file))
    }
    cpSync(join(API, 'src'), join(app, 'src'), { recursive: true, filter: source => !source.includes('.znight') })
    const { dependencies = {}, devDependencies = {} } = readJson<Manifest>(join(API, 'package.json'))
    for (const name of Object.keys({ ...dependencies, ...devDependencies })) {
      if (name === manifest.name) continue
      const link = join(app, 'node_modules', name)
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(realpathSync(join(API, 'node_modules', name)), link, 'dir')
    }
  }, TIMEOUT)

  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('library mode emits dist/znight.providers.json with package tokens and import routes', () => {
    const fragment = readJson<ProvidersFile>(join(SHARED, 'dist/znight.providers.json'))

    expect(fragment.schemaVersion).toBe(1)
    expect(fragment.package).toBe('@znight-examples/shared')
    expect(fragment.providers.map(provider => provider.token)).toEqual([
      '@znight-examples/shared#RandomIdGenerator',
      '@znight-examples/shared#SystemClock',
      '@znight-examples/shared#UserDirectory',
    ])
    expect(new Set(fragment.providers.map(provider => provider.importRoute.specifier))).toEqual(
      new Set(['@znight-examples/shared']),
    )
  })

  it(
    'users-api compiles against the compiled library, and its @Primary override still applies',
    async () => {
      const result: CompileResult = await compile({ root: app, mode: 'serve' })

      expect(result.diagnostics).toEqual([])
      expect(result.code).toContain("from '@znight-examples/shared'")
      // the providers were found in the published declarations, not in sources
      expect(result.code).toContain("source: { file: '@znight-examples/shared/dist/users/user-directory.d.ts'")
      expect(result.code).toContain(
        "['@znight-examples/shared#IdGenerator']: 'src/ids/sortable-id.generator.ts#SortableIdGenerator'",
      )
      expect(result.code).toContain(
        "deps: ['@znight-examples/shared#SystemClock', 'src/ids/sortable-id.generator.ts#SortableIdGenerator']",
      )
    },
    TIMEOUT,
  )

  it(
    'type-checks against the published declarations',
    async () => {
      expectSuccess(await run(ZNIGHT, ['generate'], { cwd: app }), 'znight generate')
      const typecheck = await run(join(API, 'node_modules/.bin/tsc'), ['--noEmit', '-p', app], { cwd: app })
      expectSuccess(typecheck, 'tsc')
      expect(typecheck.output).toBe('')
    },
    TIMEOUT,
  )

  it(
    'builds and runs on Node.js and Bun (the library JavaScript is loaded from node_modules)',
    async () => {
      expectSuccess(await run(ZNIGHT, ['build'], { cwd: app }), 'znight build')
      // the published library stays external, like any installed package
      expect(readFileSync(join(app, 'dist/main.js'), 'utf8')).toContain('from "@znight-examples/shared"')

      for (const runtime of ['node', 'bun']) {
        const port = await freePort()
        const api = start(ZNIGHT, ['start', '--runtime', runtime], { cwd: app, env: { PORT: String(port) } })
        try {
          await fetchWhenUp(`http://127.0.0.1:${port}/health`, api)
          expect(executableOf(api.child.pid ?? 0)).toBe(runtime)
          const created = await fetch(`http://127.0.0.1:${port}/users`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'ada@example.com', name: 'Ada' }),
          })
          expect(created.status).toBe(201)
          // a UUIDv7: the compiled UserDirectory received the application's SortableIdGenerator
          expect(((await created.json()) as { id: string }).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
        } catch (error) {
          await api.stop('SIGKILL')
          throw new Error(`${runtime}: ${String(error)}\n--- output ---\n${api.output()}`)
        }
        expect(await api.stop('SIGTERM')).toBe(0)
      }
    },
    TIMEOUT,
  )
})
