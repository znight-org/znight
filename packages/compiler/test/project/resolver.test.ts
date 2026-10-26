import type { ModuleResolution, ModuleResolverOptions } from '../../src/project/index.ts'

import fs from 'node:fs'

import { DEFAULT_RUNTIME_CONDITIONS, DEFAULT_SCAN_CONDITIONS, SOURCE_CONDITION } from '../../src/options.ts'
import { ModuleResolver } from '../../src/project/index.ts'
import { APP, caseInsensitiveFileSystem, tempDir } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const MAIN = `${APP}/src/main.ts`
const LIB = `${APP}/node_modules/@fixture/lib`

function resolver(options: Partial<ModuleResolverOptions> = {}): ModuleResolver {
  return new ModuleResolver({
    tsconfig: 'auto',
    scanConditions: [SOURCE_CONDITION, ...DEFAULT_SCAN_CONDITIONS],
    runtimeConditions: DEFAULT_RUNTIME_CONDITIONS,
    aliases: [],
    ...options,
  })
}

function pathOf(resolution: ModuleResolution): string | undefined {
  return resolution.kind === 'file' ? resolution.path : undefined
}

describe('ModuleResolver (scan mode)', () => {
  const scan = resolver()

  it('maps .js specifiers to TypeScript sources and accepts explicit .ts', () => {
    const fromJs = scan.resolve(`${APP}/src/users/user.service.ts`, './user.repository.js')
    expect(fromJs).toEqual({
      kind: 'file',
      path: `${APP}/src/users/user.repository.ts`,
      requestedPath: `${APP}/src/users/user.repository.ts`,
      casingMismatch: false,
    })
    expect(pathOf(scan.resolve(MAIN, './users/index.ts'))).toBe(`${APP}/src/users/index.ts`)
    expect(pathOf(scan.resolve(MAIN, './users'))).toBe(`${APP}/src/users/index.ts`)
  })

  it("uses the nearest tsconfig's paths", () => {
    expect(pathOf(scan.resolve(MAIN, '@app/users/user.service.ts'))).toBe(`${APP}/src/users/user.service.ts`)
    expect(pathOf(scan.resolve(MAIN, '#shared/format.ts'))).toBe(`${APP}/shared/format.ts`)
  })

  it('scan conditions select the sources (@znight/source) or the declarations', () => {
    expect(pathOf(scan.resolve(MAIN, '@fixture/lib'))).toBe(`${LIB}/src/index.ts`)
    expect(pathOf(scan.resolve(MAIN, '@fixture/lib/sub'))).toBe(`${LIB}/src/sub.ts`)
    const withoutSource = resolver({ scanConditions: DEFAULT_SCAN_CONDITIONS })
    expect(pathOf(withoutSource.resolve(MAIN, '@fixture/lib'))).toBe(`${LIB}/dist/index.d.mts`)
    expect(pathOf(withoutSource.resolve(MAIN, '@fixture/lib/sub'))).toBe(`${LIB}/dist/sub.d.mts`)
  })

  it('maps .mjs specifiers of declaration chunks to .d.mts (tsdown output)', () => {
    expect(pathOf(scan.resolve(`${LIB}/dist/index.d.mts`, './pool-fa4zP2qW.mjs'))).toBe(
      `${LIB}/dist/pool-fa4zP2qW.d.mts`,
    )
  })

  it('falls back to @types for untyped JavaScript packages', () => {
    expect(pathOf(scan.resolve(MAIN, 'pg'))).toBe(`${APP}/node_modules/@types/pg/index.d.ts`)
    expect(pathOf(scan.resolve(MAIN, 'cjs-only'))).toBe(`${APP}/node_modules/cjs-only/index.js`)
    expect(pathOf(scan.resolve(MAIN, 'legacy-ns'))).toBe(`${APP}/node_modules/legacy-ns/index.d.ts`)
  })

  it('normalizes builtins to node: specifiers', () => {
    expect(scan.resolve(MAIN, 'fs')).toEqual({ kind: 'builtin', specifier: 'node:fs' })
    expect(scan.resolve(MAIN, 'node:events')).toEqual({ kind: 'builtin', specifier: 'node:events' })
  })

  it('reports missing modules', () => {
    expect(scan.resolve(MAIN, './nope.ts').kind).toBe('not-found')
    expect(scan.resolve(MAIN, 'not-installed')).toMatchObject({
      kind: 'not-found',
      message: expect.stringContaining('not-installed'),
    })
  })

  it('resolves package self-references from a directory', () => {
    expect(pathOf(scan.resolveFromDirectory(LIB, '@fixture/lib'))).toBe(`${LIB}/src/index.ts`)
    expect(pathOf(scan.resolveFromDirectory(APP, 'pg'))).toBe(`${APP}/node_modules/@types/pg/index.d.ts`)
  })

  it.if(caseInsensitiveFileSystem())('flags specifiers whose casing differs from the file on disk', () => {
    const resolution = scan.resolve(`${APP}/src/casing/importer.ts`, './userprofile.ts')
    expect(resolution).toEqual({
      kind: 'file',
      path: `${APP}/src/casing/UserProfile.ts`,
      requestedPath: `${APP}/src/casing/userprofile.ts`,
      casingMismatch: true,
    })
  })

  it.if(!caseInsensitiveFileSystem())(
    'a wrongly cased specifier does not resolve on case-sensitive file systems',
    () => {
      expect(scan.resolve(`${APP}/src/casing/importer.ts`, './userprofile.ts').kind).toBe('not-found')
    },
  )
})

describe('ModuleResolver (runtime mode)', () => {
  const runtime = resolver()

  it('uses the runtime conditions (never the scan-only ones)', () => {
    expect(pathOf(runtime.resolve(MAIN, '@fixture/lib', 'runtime'))).toBe(`${LIB}/dist/index.mjs`)
    expect(pathOf(runtime.resolve(MAIN, 'pg', 'runtime'))).toBe(`${APP}/node_modules/pg/lib/index.js`)
  })

  it('runtime and scan results are memoized separately', () => {
    expect(pathOf(runtime.resolve(MAIN, '@fixture/lib', 'scan'))).toBe(`${LIB}/src/index.ts`)
    expect(pathOf(runtime.resolve(MAIN, '@fixture/lib', 'runtime'))).toBe(`${LIB}/dist/index.mjs`)
  })
})

describe('ModuleResolver options', () => {
  const dir = tempDir({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }),
    'other.tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '~/*': ['./lib/*'] } } }),
    'src/a.ts': 'export const a = 1',
    'lib/a.ts': 'export const a = 2',
    'src/main.ts': "import { a } from '~/a.ts'",
  })
  afterAll(() => dir.cleanup())
  const main = `${dir.root}/src/main.ts`

  it('tsconfig: a fixed file applies to every importer', () => {
    const fixed = resolver({ tsconfig: `${dir.root}/other.tsconfig.json` })
    expect(pathOf(fixed.resolve(main, '~/a.ts'))).toBe(`${dir.root}/lib/a.ts`)
    expect(pathOf(resolver().resolve(main, '~/a.ts'))).toBe(`${dir.root}/src/a.ts`)
  })

  it('tsconfig: false disables paths', () => {
    expect(resolver({ tsconfig: false }).resolve(main, '~/a.ts').kind).toBe('not-found')
  })

  it('string aliases (Vite resolve.alias)', () => {
    const aliased = resolver({ aliases: [{ find: '@lib', replacement: `${dir.root}/lib` }] })
    expect(pathOf(aliased.resolve(main, '@lib/a.ts'))).toBe(`${dir.root}/lib/a.ts`)
  })

  it('clearCache() picks up created files', () => {
    const cached = resolver()
    expect(cached.resolve(main, './b.ts').kind).toBe('not-found')
    dir.write('src/b.ts', 'export const b = 1')
    expect(cached.resolve(main, './b.ts').kind).toBe('not-found')
    cached.clearCache()
    expect(pathOf(cached.resolve(main, './b.ts'))).toBe(`${dir.root}/src/b.ts`)
  })

  it('returns real paths through symlinks', () => {
    dir.write('real/x.ts', 'export {}')
    fs.symlinkSync(`${dir.root}/real`, `${dir.root}/src/linked`)
    expect(pathOf(resolver().resolve(main, './linked/x.ts'))).toBe(`${dir.root}/real/x.ts`)
  })
})
