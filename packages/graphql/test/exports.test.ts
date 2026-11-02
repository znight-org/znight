import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as compiler from '../src/compiler/index.ts'
import * as entry from '../src/index.ts'
import * as testing from '../src/testing.ts'
import { expect, test as it } from 'bun:test'

interface Manifest {
  readonly name: string
  readonly znight: {
    readonly apiVersion: number
    readonly compiler: string
    readonly provides: readonly { readonly export: string; readonly plugin: string; readonly scope: string }[]
  }
}

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as Manifest

/**
 * Manifest exports implemented with the plugin runtime. Remove an entry when its export lands: the
 * test below then requires it to be a runtime value of the entry.
 */
const PENDING_RUNTIME_EXPORTS: ReadonlySet<string> = new Set(['GraphQLPlugin'])

/** Type-only exports of `src/index.ts` (read from the source: types do not exist at runtime). */
function typeExports(): Set<string> {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8')
  const names = new Set<string>()
  for (const match of source.matchAll(/export (type )?\{([^}]*)\}/g)) {
    for (const item of (match[2] ?? '').split(',')) {
      const name = item
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
      if (name !== undefined && name !== '') names.add(name)
    }
  }
  return names
}

it('exports the public runtime API', () => {
  expect(Object.keys(entry).sort()).toEqual([
    'Args',
    'Ctx',
    'GRAPHQL_METADATA_VERSION',
    'GraphQLErrorCode',
    'GraphQLException',
    'Info',
    'Loader',
    'Mutation',
    'Parent',
    'PubSub',
    'Query',
    'ResolveField',
    'Resolver',
    'Subscription',
    'UseGuard',
    'scalar',
  ])
})

it('exports the types of the catalogue (RFC 0005 §5.14)', () => {
  const types = typeExports()
  for (const name of [
    'ID',
    'Int',
    'Float',
    'JSONValue',
    'Loader',
    'BatchLoad',
    'LoaderOptions',
    'GraphQLContext',
    'ResolverContext',
    'GraphQLGuard',
    'GraphQLErrorMapper',
    'GraphQLArgs',
    'GraphQLMetadata',
    'ScalarDefinition',
    'StandardSchemaV1',
  ]) {
    expect(types.has(name) || name in entry).toBe(true)
  }
})

it('declares the manifest of RFC 0005 §7.4, whose exports exist', () => {
  expect(manifest.znight.apiVersion).toBe(1)
  expect(manifest.znight.compiler).toBe(`${manifest.name}/compiler`)
  expect(manifest.znight.provides).toEqual([
    { export: 'GraphQLContext', plugin: 'GraphQLPlugin', scope: 'request' },
    { export: 'PubSub', plugin: 'GraphQLPlugin', scope: 'singleton' },
    { export: 'GraphQLPlugin', plugin: 'GraphQLPlugin', scope: 'singleton' },
  ])
  const types = typeExports()
  const names = manifest.znight.provides.map(entry => entry.export)
  const pending = names.filter(name => PENDING_RUNTIME_EXPORTS.has(name))
  // an export that landed must leave PENDING_RUNTIME_EXPORTS
  expect(pending.filter(name => name in entry)).toEqual([])
  expect(names.filter(name => !PENDING_RUNTIME_EXPORTS.has(name) && !(name in entry) && !types.has(name))).toEqual([])
})

it('exports the compiler extension and an empty testing entry for now', () => {
  expect(Object.keys(testing)).toEqual([])
  expect(compiler.default).toBe(compiler.graphqlCompilerExtension)
  expect(compiler.default).toMatchObject({ apiVersion: 1, name: 'graphql' })
  expect(Object.keys(compiler.default.decorators).sort()).toEqual([
    '@znight/graphql#Args',
    '@znight/graphql#Ctx',
    '@znight/graphql#Info',
    '@znight/graphql#Loader',
    '@znight/graphql#Mutation',
    '@znight/graphql#Parent',
    '@znight/graphql#Query',
    '@znight/graphql#ResolveField',
    '@znight/graphql#Resolver',
    '@znight/graphql#Subscription',
    '@znight/graphql#UseGuard',
  ])
  expect(compiler.default.decorators['@znight/graphql#UseGuard']).toEqual({
    targets: ['class', 'method'],
    params: [],
    rest: 'value',
  })
})

it('names every decorator after the export the compiler resolves', () => {
  for (const identity of Object.keys(compiler.default.decorators)) {
    const name = identity.slice('@znight/graphql#'.length)
    expect(typeof (entry as Record<string, unknown>)[name]).toBe('function')
  }
})

it('decorators are no-op markers', () => {
  const marker = entry.Resolver()
  for (const decorator of [
    entry.Resolver({ scope: 'request' }),
    entry.Query(),
    entry.Mutation('rename'),
    entry.Subscription(),
    entry.ResolveField(),
    entry.Args(),
    entry.Args('id'),
    entry.Parent(),
    entry.Ctx(),
    entry.Info(),
    entry.Loader(),
  ]) {
    expect(decorator).toBe(marker)
  }
  expect(marker(class {})).toBeUndefined()
})
