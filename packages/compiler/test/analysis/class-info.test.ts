/**
 * ClassInfo construction (§6.5): decorators with ArgInfo, constructors resolved through inheritance
 * with type-argument substitution, methods, properties, heritage closure, lifecycle.
 */
import type { ClassInfo } from '../../src/extensions/api.ts'
import type { FixtureAnalysis } from './helpers.ts'

import { serializeType, ValueRef } from '../../src/project/index.ts'
import { analyzeRoot, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const app = tempApp({
  'src/model.ts': `
export interface Entity { readonly id: string }
export interface User extends Entity { readonly name: string }
export interface Repository<T, ID = string> { find(id: ID): T }
export interface Auditable<T> { audit(value: T): void }
`,
  'src/base.ts': `
import type { Repository, Auditable } from './model.ts'
export class Logger {}
export abstract class Base<T> implements Repository<T> {
  constructor(protected readonly items: T[], readonly logger?: Logger) {}
  find(_id: string): T { throw new Error() }
  onStart(): void {}
}
export abstract class Middle<A, B = A> extends Base<B> implements Auditable<A> {
  audit(_value: A): void {}
}
`,
  'src/constants.ts': `
export const PREFIX = '/api'
export const OPTIONS = { level: 'debug', retries: 1 + 2 } as const
export class Guard {}
export function helper(): void {}
`,
  'src/service.ts': `
import { Inject, Injectable, Intercept, Optional } from '@znight/core'
import * as zn from '@znight/core'
import { Middle, Logger } from './base.ts'
import type { User } from './model.ts'
import { Guard, OPTIONS, PREFIX, helper } from './constants.ts'

export class Interceptor {}

@Injectable({ scope: 'singleton', name: PREFIX + '/users' })
export class UserService extends Middle<number, User> {
  static instances = 0
  readonly name: string = 'users'
  ready? = true
  declare tag: string
  #secret = 1
  protected handler = helper
  accessor counter = 1

  get size(): number { return 0 }
  set size(_value: number) {}

  @Intercept(Interceptor, OPTIONS)
  async load(@Inject('id') id: string, limit = 10, ...rest: string[]): Promise<User[]> { return [] }

  overloaded(): void
  overloaded(value?: string): void {}

  find2<T>(value: T): T { return value }
  private hidden(): Promise<void> { return Promise.resolve() }
  #reallyHidden(): void {}
  static create(): void {}
  *items(): Generator<number> {}
  [Symbol.asyncDispose](): Promise<void> { return Promise.resolve() }

  @zn.Intercept(Interceptor, { guard: Guard, nested: [Guard] })
  guarded(): void {}
}

@Injectable()
export class OwnConstructor {
  constructor(
    @Inject('first') private readonly first: string,
    @Optional() protected second?: Logger,
    readonly third: Logger | undefined = undefined,
    { a }: { a: number } = { a: 1 },
    ...others: Logger[]
  ) {}
}
`,
  'src/mixin.ts': `
import { Injectable } from '@znight/core'
export function Mixin<T>(base: T): T { return base }
export class Plain {}
@Injectable()
export class Mixed extends Mixin(Plain) {}
@Injectable()
export class NoConstructor extends Plain {}
`,
})

let result: FixtureAnalysis
let service: ClassInfo

beforeAll(async () => {
  result = await analyzeRoot(app.root)
  service = classInfo('src/service.ts#UserService')
})
afterAll(() => app.cleanup())

function classInfo(identity: string): ClassInfo {
  const found = result.classes.find(info => info.identity === identity)
  if (!found) {
    throw new Error(`no class ${identity}`)
  }
  return found
}

describe('ClassInfo: identity and shape', () => {
  it('describes the class', () => {
    expect(service).toMatchObject({
      name: 'UserService',
      identity: 'src/service.ts#UserService',
      displayName: 'UserService',
      relativeFile: 'src/service.ts',
      exported: true,
      abstract: false,
      ambient: false,
      typeParameters: [],
      decorated: true,
    })
    expect(service.location).toMatchObject({ line: 11, column: 14 })
    expect(service.importRoute).toEqual({
      specifier: '../service.js',
      exportName: 'UserService',
      members: [],
      typeOnly: false,
    })
    expect(service.superClass && serializeType(service.superClass)).toBe(
      'src/base.ts#Middle<number, src/model.ts#User>',
    )
  })

  it('lists only decorated classes, sorted by identity', () => {
    expect(result.classes.map(info => info.identity)).toEqual([
      'src/mixin.ts#Mixed',
      'src/mixin.ts#NoConstructor',
      'src/service.ts#OwnConstructor',
      'src/service.ts#UserService',
    ])
  })
})

describe('ClassInfo: decorators', () => {
  it('records identity, owner, call form, target and evaluated static arguments', () => {
    const [injectable] = service.decorators
    expect(injectable).toMatchObject({
      identity: '@znight/core#Injectable',
      name: 'Injectable',
      owner: 'core',
      called: true,
      target: 'class',
    })
    expect(injectable?.args).toHaveLength(1)
    expect(injectable?.args[0]).toMatchObject({
      kind: 'static',
      evaluated: true,
      value: { scope: 'singleton', name: '/api/users' },
      text: "{ scope: 'singleton', name: PREFIX + '/users' }",
    })
  })

  it('keeps value arguments as references or values with nested references', () => {
    const load = service.methods.find(method => method.name === 'load')
    const [target, options] = load?.decorators[0]?.args ?? []
    expect(target?.evaluated).toBe(false)
    expect(target?.ref).toBeInstanceOf(ValueRef)
    expect(target?.ref?.identity).toBe('src/service.ts#Interceptor')
    expect(options).toMatchObject({ kind: 'value', evaluated: true, value: { level: 'debug', retries: 3 } })

    const guarded = service.methods.find(method => method.name === 'guarded')
    expect(guarded?.decorators[0]?.identity).toBe('@znight/core#Intercept')
    const nested = guarded?.decorators[0]?.args[1]?.value as { guard: ValueRef; nested: ValueRef[] }
    expect(nested.guard).toBeInstanceOf(ValueRef)
    expect(nested.guard.identity).toBe('src/constants.ts#Guard')
    expect(nested.nested[0]?.identity).toBe('src/constants.ts#Guard')
  })

  it('records parameter decorators with their target', () => {
    const load = service.methods.find(method => method.name === 'load')
    expect(load?.params[0]?.decorators[0]).toMatchObject({
      identity: '@znight/core#Inject',
      target: 'parameter',
      args: [{ value: 'id' }],
    })
    const own = classInfo('src/service.ts#OwnConstructor')
    expect(own.ctor.params[0]?.decorators[0]).toMatchObject({
      identity: '@znight/core#Inject',
      target: 'constructorParameter',
    })
  })
})

describe('ClassInfo: constructors', () => {
  it('resolves an inherited constructor through the chain with substituted type arguments', () => {
    // UserService extends Middle<number, User> extends Base<B = User>: constructor(items: T[], logger?: Logger)
    expect(service.ctor.declaredBy).toBe('src/base.ts#Base')
    expect(service.ctor.params.map(param => [param.name, serializeType(param.type), param.optional])).toEqual([
      ['items', 'src/model.ts#User[]', false],
      ['logger', 'src/base.ts#Logger', true],
    ])
    expect(service.ctor.params[0]?.property).toEqual({ visibility: 'protected', readonly: true })
    expect(service.ctor.error).toBeUndefined()
  })

  it('describes own constructor parameters', () => {
    const own = classInfo('src/service.ts#OwnConstructor')
    expect(own.ctor.declaredBy).toBe('src/service.ts#OwnConstructor')
    expect(
      own.ctor.params.map(param => ({
        name: param.name,
        type: serializeType(param.type),
        optional: param.optional,
        hasDefault: param.hasDefault,
        rest: param.rest,
        property: param.property,
      })),
    ).toEqual([
      {
        name: 'first',
        type: 'string',
        optional: false,
        hasDefault: false,
        rest: false,
        property: { visibility: 'private', readonly: true },
      },
      {
        name: 'second',
        type: 'src/base.ts#Logger',
        optional: true,
        hasDefault: false,
        rest: false,
        property: { visibility: 'protected', readonly: false },
      },
      {
        name: 'third',
        type: 'src/base.ts#Logger | undefined',
        optional: false,
        hasDefault: true,
        rest: false,
        property: { visibility: 'public', readonly: true },
      },
      {
        name: 'arg3',
        type: 'opaque("{ a: number }")',
        optional: false,
        hasDefault: true,
        rest: false,
        property: undefined,
      },
      {
        name: 'others',
        type: 'src/base.ts#Logger[]',
        optional: false,
        hasDefault: false,
        rest: true,
        property: undefined,
      },
    ])
  })

  it('reports unanalysable inherited constructors and implicit ones', () => {
    const mixed = classInfo('src/mixin.ts#Mixed')
    expect(mixed.ctor.error?.message).toContain(
      "The constructor inherited by Mixed from 'Mixin(Plain)' cannot be analysed",
    )
    expect(mixed.ctor.error?.hints).toEqual([
      'Declare an explicit constructor in Mixed: `constructor(...) { super(...) }`',
    ])
    expect(
      result.diagnostics
        .filter(diagnostic => diagnostic.code === 'ZNIGHT010')
        .map(diagnostic => `${diagnostic.location?.file.slice(app.root.length + 1)}:${diagnostic.location?.line}`),
    ).toEqual(['src/mixin.ts:6', 'src/service.ts:46', 'src/service.ts:47'])
    const implicit = classInfo('src/mixin.ts#NoConstructor').ctor
    expect(implicit).toMatchObject({ params: [], declaredBy: undefined, error: undefined, visibility: 'public' })
  })
})

describe('ClassInfo: members', () => {
  it('lists methods with visibility, static, async, kind and return types (overload signatures excluded)', () => {
    expect(
      service.methods.map(
        method =>
          `${method.static ? 'static ' : ''}${method.visibility} ${method.kind} ${method.name}${method.privateName ? ' #' : ''}${method.computed ? ' computed' : ''}${method.async ? ' async' : ''}${method.generator ? ' generator' : ''} -> ${method.returnType ? serializeType(method.returnType) : '?'}`,
      ),
    ).toEqual([
      'public get size -> number',
      'public set size -> ?',
      'public method load async -> Promise<src/model.ts#User[]>',
      'public method overloaded -> void',
      'public method find2 -> T',
      'private method hidden async -> Promise<void>',
      'private method #reallyHidden # -> void',
      'static public method create -> void',
      'public method items generator -> globalThis#Generator<number>',
      'public method [Symbol.asyncDispose] computed async -> Promise<void>',
      'public method guarded -> void',
    ])
    const load = service.methods.find(method => method.name === 'load')
    expect(load?.params.map(param => [param.name, serializeType(param.type), param.hasDefault, param.rest])).toEqual([
      ['id', 'string', false, false],
      ['limit', 'opaque("")', true, false],
      ['rest', 'string[]', false, true],
    ])
    expect(service.methods.find(method => method.name === 'find2')?.typeParameters).toEqual(['T'])
  })

  it('lists properties with types, modifiers and evaluated initializers', () => {
    expect(
      service.properties.map(property => ({
        name: property.name,
        static: property.static,
        visibility: property.visibility,
        readonly: property.readonly,
        optional: property.optional,
        declare: property.declare,
        accessor: property.accessor,
        type: property.type && serializeType(property.type),
        value: property.initializer?.evaluated ? property.initializer.value : property.initializer?.ref?.identity,
      })),
    ).toEqual([
      {
        name: 'instances',
        static: true,
        visibility: 'public',
        readonly: false,
        optional: false,
        declare: false,
        accessor: false,
        type: undefined,
        value: 0,
      },
      {
        name: 'name',
        static: false,
        visibility: 'public',
        readonly: true,
        optional: false,
        declare: false,
        accessor: false,
        type: 'string',
        value: 'users',
      },
      {
        name: 'ready',
        static: false,
        visibility: 'public',
        readonly: false,
        optional: true,
        declare: false,
        accessor: false,
        type: undefined,
        value: true,
      },
      {
        name: 'tag',
        static: false,
        visibility: 'public',
        readonly: false,
        optional: false,
        declare: true,
        accessor: false,
        type: 'string',
        value: undefined,
      },
      {
        name: '#secret',
        static: false,
        visibility: 'private',
        readonly: false,
        optional: false,
        declare: false,
        accessor: false,
        type: undefined,
        value: 1,
      },
      {
        name: 'handler',
        static: false,
        visibility: 'protected',
        readonly: false,
        optional: false,
        declare: false,
        accessor: false,
        type: undefined,
        value: 'src/constants.ts#helper',
      },
      {
        name: 'counter',
        static: false,
        visibility: 'public',
        readonly: false,
        optional: false,
        declare: false,
        accessor: true,
        type: undefined,
        value: 1,
      },
    ])
  })
})

describe('ClassInfo: heritage and lifecycle', () => {
  it('computes the heritage closure with substituted type arguments', () => {
    expect(service.heritage.map(serializeType)).toEqual([
      'src/base.ts#Base<src/model.ts#User>',
      'src/base.ts#Middle<number, src/model.ts#User>',
      'src/model.ts#Auditable<number>',
      'src/model.ts#Repository<src/model.ts#User, string>',
    ])
  })

  it('detects lifecycle hooks on the class and its bases', () => {
    expect(service.lifecycle.map(hook => [hook.hook, hook.member, hook.declaredBy, hook.requiredParams])).toEqual([
      ['asyncDispose', '[Symbol.asyncDispose]', 'src/service.ts#UserService', 0],
      ['onStart', 'onStart', 'src/base.ts#Base', 0],
    ])
  })
})
