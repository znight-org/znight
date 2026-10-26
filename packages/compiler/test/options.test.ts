import type { ZnightOptions } from '../src/options.ts'

import fs from 'node:fs'

import {
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  DEFAULT_RUNTIME_CONDITIONS,
  DEFAULT_SCAN_CONDITIONS,
  normalizeOptions,
  SOURCE_CONDITION,
} from '../src/options.ts'
import { tempDir } from './project/helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const dir = tempDir({ 'app/package.json': '{}' })
afterAll(() => dir.cleanup())

describe('normalizeOptions', () => {
  it('fills every default', () => {
    const options = normalizeOptions({}, { cwd: `${dir.root}/app` })
    expect(options).toEqual({
      root: `${dir.root}/app`,
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
      outFile: `${dir.root}/app/src/.znight/container.generated.ts`,
      tsconfig: 'auto',
      scanConditions: DEFAULT_SCAN_CONDITIONS,
      runtimeConditions: DEFAULT_RUNTIME_CONDITIONS,
      aliases: [],
      importExtension: 'js',
      sourceLocations: 'dev',
      stripDecorators: true,
      extensions: [],
      trustedExtensions: [],
      externals: [],
      libraries: [],
      library: false,
      strictValidation: false,
      reportUnused: false,
      prune: false,
      app: { entry: `${dir.root}/app/src/main.ts` },
    })
  })

  it('documents the spec defaults', () => {
    expect(DEFAULT_INCLUDE).toEqual(['src/**/*.{ts,tsx,mts}'])
    expect(DEFAULT_EXCLUDE).toEqual(['**/*.{test,spec}.*', '**/*.d.ts', '**/.znight/**'])
    expect(SOURCE_CONDITION).toBe('@znight/source')
  })

  it('resolves a relative root against cwd and returns its real path', () => {
    fs.symlinkSync(`${dir.root}/app`, `${dir.root}/link`)
    const options = normalizeOptions({ root: 'link' }, { cwd: dir.root })
    expect(options.root).toBe(`${dir.root}/app`)
  })

  it('keeps a non-existing root as an absolute path', () => {
    expect(normalizeOptions({ root: 'missing' }, { cwd: dir.root }).root).toBe(`${dir.root}/missing`)
  })

  it('resolves paths relative to the root', () => {
    const options = normalizeOptions(
      { root: 'app', outFile: 'gen/container.ts', tsconfig: 'tsconfig.app.json', app: { entry: 'server.ts' } },
      { cwd: dir.root },
    )
    expect(options.outFile).toBe(`${dir.root}/app/gen/container.ts`)
    expect(options.tsconfig).toBe(`${dir.root}/app/tsconfig.app.json`)
    expect(options.app).toEqual({ entry: `${dir.root}/app/server.ts` })
  })

  it('keeps absolute paths and supports tsconfig: false and app: false', () => {
    const options = normalizeOptions({ root: dir.root, outFile: '/abs/out.ts', tsconfig: false, app: false })
    expect(options.outFile).toBe('/abs/out.ts')
    expect(options.tsconfig).toBe(false)
    expect(options.app).toBe(false)
  })

  it('puts extra scan conditions first and de-duplicates them', () => {
    const options = normalizeOptions({ root: dir.root, conditions: [SOURCE_CONDITION, 'types', SOURCE_CONDITION] })
    expect(options.scanConditions).toEqual([SOURCE_CONDITION, ...DEFAULT_SCAN_CONDITIONS])
    expect(options.runtimeConditions).toEqual(DEFAULT_RUNTIME_CONDITIONS)
  })

  it('takes runtime conditions and aliases from the context', () => {
    const options = normalizeOptions(
      { root: dir.root },
      { runtimeConditions: ['module', 'node', 'module'], aliases: [{ find: '@', replacement: '/src' }] },
    )
    expect(options.runtimeConditions).toEqual(['module', 'node'])
    expect(options.aliases).toEqual([{ find: '@', replacement: '/src' }])
  })

  it('copies list options and de-duplicates libraries', () => {
    const libraries = ['@acme/a', '@acme/a', '@acme/b']
    const options = normalizeOptions({ root: dir.root, libraries, externals: ['@acme/a#Foo', 'src/x.ts#Bar'] })
    expect(options.libraries).toEqual(['@acme/a', '@acme/b'])
    expect(options.externals).toEqual(['@acme/a#Foo', 'src/x.ts#Bar'])
  })

  const invalid: [string, ZnightOptions, RegExp][] = [
    ['empty include', { include: [] }, /"include" must contain at least one glob/],
    ['non-string include', { include: [''] }, /"include" must be an array of non-empty strings/],
    ['bad importExtension', { importExtension: 'mjs' as never }, /"importExtension" must be one of/],
    ['bad sourceLocations', { sourceLocations: true as never }, /"sourceLocations" must be/],
    ['bare external', { externals: ['Logger'] }, /takes canonical identities/],
    ['external without name', { externals: ['@acme/lib#'] }, /takes canonical identities/],
    ['empty outFile', { outFile: '' }, /"outFile" must be a non-empty string/],
    ['non-boolean flag', { prune: 'yes' as never }, /"prune" must be a boolean/],
    ['anonymous extension', { extensions: [{ apiVersion: 1, name: '' }] }, /non-empty "name"/],
    [
      'duplicate extension',
      {
        extensions: [
          { apiVersion: 1, name: 'http' },
          { apiVersion: 1, name: 'http' },
        ],
      },
      /two extensions named "http"/,
    ],
  ]
  it.each(invalid)('rejects %s', (_name, options, message) => {
    expect(() => normalizeOptions({ root: dir.root, ...options })).toThrow(message)
  })

  it('rejects RegExp aliases', () => {
    expect(() =>
      normalizeOptions({ root: dir.root }, { aliases: [{ find: /x/ as never, replacement: '/x' }] }),
    ).toThrow(/only string aliases/)
  })
})
