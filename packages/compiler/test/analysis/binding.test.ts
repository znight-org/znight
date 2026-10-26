/**
 * Binding algorithm (§4.7) edge cases, normalization of injection points and graph ordering helpers.
 */
import type { TypeInfo } from '../../src/project/index.ts'
import type { FixtureAnalysis } from './helpers.ts'

import { kindsCompatible, normalizeInjection, stripNullish, valueKind } from '../../src/binding/injection.ts'
import { stronglyConnectedComponents, topologicalOrder } from '../../src/graph/order.ts'
import {
  arrayType,
  literalType,
  opaqueType,
  primitiveType,
  promiseType,
  referenceType,
  serializeType,
  unionType,
} from '../../src/project/index.ts'
import { analyzeRoot, codes, provider, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const SERVICE = referenceType('src/a.ts#Service', 'Service')
const LAZY = (inner: TypeInfo): TypeInfo => referenceType('@znight/core#Lazy', 'Lazy', [inner])

describe('normalizeInjection', () => {
  it('unwraps optionality, Lazy and multi', () => {
    const cases: [TypeInfo, boolean, object][] = [
      [SERVICE, false, { optional: false, multi: false, lazy: false, valueLike: false }],
      [unionType([SERVICE, primitiveType('undefined')]), false, { optional: true }],
      [unionType([SERVICE, primitiveType('null')]), false, { optional: true }],
      [SERVICE, true, { optional: true }],
      [arrayType(SERVICE), false, { multi: true, type: SERVICE }],
      [arrayType(unionType([SERVICE, primitiveType('undefined')])), false, { multi: true, type: SERVICE }],
      [LAZY(SERVICE), false, { lazy: true, type: SERVICE }],
      [LAZY(unionType([SERVICE, primitiveType('undefined')])), false, { lazy: true, optional: true }],
      [unionType([LAZY(SERVICE), primitiveType('undefined')]), false, { lazy: true, optional: true }],
    ]
    for (const [type, optional, expected] of cases) {
      const result = normalizeInjection({ type, qualifier: undefined, optional }, 'x')
      expect(result.ok).toBe(true)
      expect(result.ok && result.injection).toMatchObject(expected)
    }
  })

  it('treats primitives, arrays of primitives and opaque types as value types needing a qualifier', () => {
    for (const type of [
      primitiveType('string'),
      arrayType(primitiveType('string')),
      opaqueType('{ a: 1 }', 'object-literal'),
    ]) {
      expect(normalizeInjection({ type, qualifier: undefined, optional: false }, 'x').ok).toBe(false)
      const qualified = normalizeInjection({ type, qualifier: 'q', optional: false }, 'x')
      expect(qualified.ok && qualified.injection).toMatchObject({ valueLike: true, multi: false })
    }
  })

  it('rejects Promise<T>, Lazy<T[]>, nested Lazy, bare Lazy and unresolved types', () => {
    const problems = [
      promiseType(SERVICE),
      LAZY(arrayType(SERVICE)),
      LAZY(LAZY(SERVICE)),
      referenceType('@znight/core#Lazy', 'Lazy', []),
      opaqueType('Missing', 'unresolved'),
      { kind: 'typeParameter', name: 'T' } as TypeInfo,
    ]
    for (const type of problems) {
      const result = normalizeInjection({ type, qualifier: 'q', optional: false }, 'Parameter')
      expect(result.ok).toBe(false)
    }
  })

  it('strips nullish members', () => {
    expect(serializeType(stripNullish(unionType([SERVICE, primitiveType('void'), primitiveType('null')])).type)).toBe(
      'src/a.ts#Service',
    )
    expect(stripNullish(primitiveType('undefined'))).toEqual({ type: primitiveType('undefined'), nullable: false })
  })

  it('matches value kinds', () => {
    expect(valueKind(literalType('a'))).toBe('string')
    expect(valueKind(unionType([literalType(1), literalType(2)]))).toBe('number')
    expect(valueKind(arrayType(primitiveType('boolean')))).toBe('boolean[]')
    expect(valueKind(primitiveType('unknown'))).toBe('opaque')
    expect(kindsCompatible('number', 'number')).toBe(true)
    expect(kindsCompatible('opaque', 'number')).toBe(true)
    expect(kindsCompatible('string', 'number')).toBe(false)
  })
})

describe('graph ordering helpers', () => {
  it('orders topologically with ties broken by token', () => {
    const deps: Record<string, string[]> = { c: ['a'], b: ['a'], a: [], d: ['c', 'b', 'x'] }
    expect(topologicalOrder(['d', 'c', 'b', 'a'], node => deps[node] ?? [])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('appends nodes on cycles in token order', () => {
    const deps: Record<string, string[]> = { a: ['b'], b: ['a'], c: [] }
    expect(topologicalOrder(['b', 'a', 'c'], node => deps[node] ?? [])).toEqual(['c', 'a', 'b'])
  })

  it('finds strongly connected components deterministically', () => {
    const next: Record<string, string[]> = { a: ['b'], b: ['c'], c: ['a', 'd'], d: ['d'], e: ['a'] }
    expect(stronglyConnectedComponents(['e', 'd', 'c', 'b', 'a'], node => next[node] ?? [])).toEqual([
      ['a', 'b', 'c'],
      ['d'],
      ['e'],
    ])
  })
})

describe('binding edge cases', () => {
  const app = tempApp({
    'src/types.ts': `
import { Container, Factory, Inject, Injectable, type Lazy, Named, Primary, Provides } from '@znight/core'

export interface Mailer { send(): void }
export interface Missing { run(): void }
export class Remote {}
export abstract class Store {}
export class Config {}
export class Metrics {}

@Injectable() export class SmtpMailer implements Mailer { send(): void {} }
@Injectable() export class MemoryStore extends Store {}
@Injectable() export class Base {}
@Injectable() export class Derived extends Base {}

@Factory()
export class Values {
  @Provides({ name: 'retries' }) retries(this: Values): number { return 3 }
  @Provides() async config(): Promise<Config | undefined> { return new Config() }
  @Provides() @Named('special') special(): Derived { return new Derived() }
}

@Injectable()
export class Consumer {
  constructor(
    readonly mailer: Mailer,
    readonly store: Store,
    readonly base: Base,
    readonly all: Array<Base>,
    readonly readonlyAll: ReadonlyArray<Base>,
    readonly config: Config,
    readonly container: Container,
    readonly remote: Remote,
    readonly lazyRemote: Lazy<Remote>,
    readonly lazyMissing?: Lazy<Missing>,
    @Inject('timeout') readonly timeout?: number,
    @Inject('retries') readonly retries: number = 1,
    @Inject('special') readonly special: Base = new Base(),
    readonly metrics?: Metrics,
  ) {}
}

@Injectable()
export class QualifiedExternal {
  constructor(@Inject('main') readonly remote: Remote) {}
}

@Injectable() @Primary() export class PrimaryOne extends Store {}
`,
  })
  let result: FixtureAnalysis

  beforeAll(async () => {
    result = await analyzeRoot(app.root, { externals: ['src/types.ts#Remote'] })
  })
  afterAll(() => app.cleanup())

  it('binds every injection point of Consumer', () => {
    expect(provider(result, 'src/types.ts#Consumer').deps.map(dep => dep.ref)).toEqual([
      'src/types.ts#SmtpMailer', // interface with a single implementation
      'src/types.ts#PrimaryOne', // abstract class: two candidates, one @Primary
      'src/types.ts#Base', // the exact candidate wins over assignable ones (Derived, Values.special)
      { multi: ['src/types.ts#Base', 'src/types.ts#Derived', 'src/types.ts#Values.special'] },
      { multi: ['src/types.ts#Base', 'src/types.ts#Derived', 'src/types.ts#Values.special'] },
      'src/types.ts#Values.config', // Promise<Config | undefined> provides Config
      '@znight/core#Container', // external from the @znight/core manifest
      'src/types.ts#Remote', // external from options.externals
      { lazy: 'src/types.ts#Remote' },
      { token: 'src/types.ts#Missing', optional: true }, // optional Lazy without provider
      { token: 'timeout', optional: true }, // optional qualified value without provider
      'src/types.ts#Values.retries',
      'src/types.ts#Values.special',
      { token: 'src/types.ts#Metrics', optional: true },
    ])
  })

  it('ignores TypeScript `this` parameters', () => {
    const retries = provider(result, 'src/types.ts#Values.retries')
    expect(retries.deps.map(dep => dep.role)).toEqual(['factory'])
    expect(retries.factory).toEqual({ kind: 'method', method: 'retries', args: 0 })
  })

  it('records the externals with their origin', () => {
    expect(result.graph.externals.map(external => [external.token, external.origin, external.providedBy])).toEqual([
      ['@znight/core#Container', 'manifest', '@znight/core'],
      ['src/types.ts#Remote', 'option', undefined],
    ])
  })

  it('does not satisfy a qualifier with an external', () => {
    expect(codes(result)).toEqual(['ZNIGHT001 src/types.ts:45:48'])
    expect(result.diagnostics[0]?.message).toBe(
      "Missing provider for 'Remote' (qualifier 'main') required by QualifiedExternal",
    )
  })

  it('aliases interfaces and abstract classes to their single (or primary) provider', () => {
    expect(result.graph.aliases).toEqual([
      { key: 'src/types.ts#Config', token: 'src/types.ts#Values.config' },
      { key: 'src/types.ts#Mailer', token: 'src/types.ts#SmtpMailer' },
      { key: 'src/types.ts#Store', token: 'src/types.ts#PrimaryOne' },
    ])
  })
})
