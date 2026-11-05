/**
 * Custom parameter decorators (RFC 0010): `AnalyzeContext.paramDecorator`, the build-time checks of
 * §4.5, unclaimed uses and `TypeHelpers.assignable`.
 */
import type { CompilerExtension, ParamDecoratorUse, TypeHelpers } from '../../src/index.ts'

import { analyzeRoot, renderDiagnostics, tempApp } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const FAKE = {
  'node_modules/@acme/fake/package.json': JSON.stringify({
    name: '@acme/fake',
    version: '1.0.0',
    types: './index.d.ts',
  }),
  'node_modules/@acme/fake/index.d.ts': [
    'export declare function Handlers(): ClassDecorator',
    'export declare function Handle(): MethodDecorator',
    '',
  ].join('\n'),
}

/** An extension reading the custom decorators of every `@Handle()` method for the transport `fake`. */
function fakeExtension(uses: Map<string, ParamDecoratorUse | undefined>, types?: (helpers: TypeHelpers) => void) {
  const extension: CompilerExtension = {
    apiVersion: 1,
    name: 'fake',
    decorators: {
      '@acme/fake#Handlers': { targets: ['class'], params: [] },
      '@acme/fake#Handle': { targets: ['method'], params: [] },
    },
    analyzeClass(cls, ctx) {
      ctx.registerProvider(cls)
      types?.(ctx.types)
      for (const method of cls.methods) {
        if (!method.decorators.some(decorator => decorator.identity === '@acme/fake#Handle')) continue
        for (const param of method.params) {
          uses.set(`${method.name}.${param.name}`, ctx.paramDecorator(param, 'fake', cls))
        }
      }
    },
  }
  return extension
}

const DECORATORS = `import { createParamDecorator } from '@znight/core'
import { UserResolver } from './user-resolver.ts'
import type { User } from './user.ts'

export const CurrentUser = createParamDecorator<User>({ fake: ctx => (ctx as { user: User }).user })
export const OptionalUser = createParamDecorator<User | undefined>({ fake: () => undefined, other: () => undefined })
export const Claim = createParamDecorator<string, string>({ fake: async (_ctx, name) => name })
export const Loaded = createParamDecorator<User>({ 'fake': UserResolver })
export const ByFunction = createParamDecorator<User>({ fake: readUser })
export const OtherOnly = createParamDecorator<User>({ other: () => ({ id: '1' }) })
export const Untyped = createParamDecorator({ fake: () => 1 })
export const NotObject = createParamDecorator<User>(resolversOf())
export const Spread = createParamDecorator<User>({ ...base })
export const Called = createParamDecorator<User>({ fake: makeResolver() })
const Hidden = createParamDecorator<User>({ fake: () => ({ id: 'h' }) })
export const Exposed = Hidden

export async function readUser(): Promise<User> {
  return { id: '1' }
}
function resolversOf() {
  return {}
}
function makeResolver() {
  return () => ({ id: '1' })
}
const base = {}
export const CLAIM = 'sub'
`

describe('custom parameter decorators', () => {
  it('reads valid uses: function and class resolvers, data arguments, the value type', async () => {
    const app = tempApp({
      ...FAKE,
      'src/user.ts': 'export interface User { readonly id: string; readonly name?: string }\n',
      'src/user-resolver.ts': `import type { User } from './user.ts'
export class UserResolver {
  async resolve(): Promise<User> {
    return { id: 'r' }
  }
}
`,
      'src/decorators.ts': DECORATORS,
      'src/handler.ts': `import { Handle, Handlers } from '@acme/fake'
import { CLAIM, Claim, CurrentUser, Loaded, ByFunction, OptionalUser } from './decorators.ts'
import * as all from './decorators.ts'
import { CurrentUser as Me } from './decorators.ts'
import type { User } from './user.ts'

@Handlers()
export class Handler {
  @Handle()
  run(
    @CurrentUser() user: User,
    @Claim('sub') sub: string,
    @Claim(CLAIM) sub2: string,
    @Loaded() loaded: User,
    @ByFunction() byFunction: { readonly id: string },
    @OptionalUser() optional?: User,
    @OptionalUser() withDefault: User = { id: 'guest' },
    @all.CurrentUser() namespaced: User,
    @Me() renamed: User,
    @CurrentUser() untyped,
    plain: string,
  ): void {}
}
`,
    })
    const uses = new Map<string, ParamDecoratorUse | undefined>()
    try {
      const result = await analyzeRoot(app.root, { extensions: [fakeExtension(uses)] })
      expect(renderDiagnostics(result.root, result.diagnostics)).toBe('')
      const summary = [...uses].map(([key, use]) => {
        if (use === undefined) return [key, undefined]
        if (!use.ok) return [key, 'failed']
        const data = use.data?.value ?? use.data?.ref?.text
        return [key, use.identity, use.name, use.resolver.kind, use.resolver.async, data, use.cast]
      })
      expect(summary).toEqual([
        ['run.user', 'src/decorators.ts#CurrentUser', 'CurrentUser', 'function', false, undefined, false],
        ['run.sub', 'src/decorators.ts#Claim', 'Claim', 'function', true, 'sub', false],
        ['run.sub2', 'src/decorators.ts#Claim', 'Claim', 'function', true, 'sub', false],
        ['run.loaded', 'src/decorators.ts#Loaded', 'Loaded', 'class', true, undefined, false],
        ['run.byFunction', 'src/decorators.ts#ByFunction', 'ByFunction', 'function', true, undefined, false],
        ['run.optional', 'src/decorators.ts#OptionalUser', 'OptionalUser', 'function', false, undefined, false],
        ['run.withDefault', 'src/decorators.ts#OptionalUser', 'OptionalUser', 'function', false, undefined, false],
        ['run.namespaced', 'src/decorators.ts#CurrentUser', 'CurrentUser', 'function', false, undefined, false],
        ['run.renamed', 'src/decorators.ts#CurrentUser', 'CurrentUser', 'function', false, undefined, false],
        ['run.untyped', 'src/decorators.ts#CurrentUser', 'CurrentUser', 'function', false, undefined, true],
        ['run.plain', undefined],
      ])
      const loaded = uses.get('run.loaded')
      expect(loaded?.ok && loaded.resolver.kind === 'class' ? loaded.resolver.ref.token : undefined).toBe(
        'src/user-resolver.ts#UserResolver',
      )
      // the class resolver is registered, with a lazy edge from the handler class
      expect(result.graph.providers.map(provider => provider.token)).toContain('src/user-resolver.ts#UserResolver')
      const edge = result.graph.edges.find(candidate => candidate.to === 'src/user-resolver.ts#UserResolver')
      expect(edge).toMatchObject({ from: 'src/handler.ts#Handler', kind: 'lazy', label: 'parameter resolver' })
    } finally {
      app.cleanup()
    }
  })

  it('reports every invalid use as ZNIGHT005, the definition related', async () => {
    const app = tempApp({
      ...FAKE,
      'src/user.ts': 'export interface User { readonly id: string }\n',
      'src/user-resolver.ts': 'export class UserResolver {\n  resolve() {\n    return { id: "r" }\n  }\n}\n',
      'src/decorators.ts': DECORATORS,
      'src/handler.ts': `import { Handle, Handlers } from '@acme/fake'
import { Called, Claim, CurrentUser, Exposed, NotObject, OptionalUser, OtherOnly, Spread, Untyped } from './decorators.ts'
import type { User } from './user.ts'

@Handlers()
export class Handler {
  constructor(@CurrentUser() readonly user: User) {}

  @Handle()
  run(
    @OptionalUser() a: User,
    @OtherOnly() b: User,
    @Untyped() c: number,
    @NotObject() d: User,
    @Spread() e: User,
    @Called() f: User,
    @Claim(String(1)) g: string,
    @Claim('a', 'b') h: string,
    @CurrentUser i: User,
    @CurrentUser() j: string,
    @Exposed() k: User,
    @CurrentUser() ...rest: User[]
  ): void {}

  helper(@CurrentUser() user: User): User {
    return user
  }
}
`,
    })
    const uses = new Map<string, ParamDecoratorUse | undefined>()
    try {
      const result = await analyzeRoot(app.root, { extensions: [fakeExtension(uses)] })
      expect(renderDiagnostics(result.root, result.diagnostics)).toMatchSnapshot()
      expect([...uses.values()].every(use => use === undefined || !use.ok)).toBe(true)
    } finally {
      app.cleanup()
    }
  })

  it('casts what members left out of the shapes leave undecided, without rejecting it', async () => {
    const app = tempApp({
      ...FAKE,
      'src/user.ts': `export class User {
  id = ''
  hasRole(role: string): boolean {
    return role === 'admin'
  }
}
export interface Principal { readonly id: string; readonly hasRole: (role: string) => boolean }
export class Admin { private secret = 1; id = '' }
export interface WithMethod { readonly id: string; isAdmin(): boolean }
`,
      'src/decorators.ts': `import { createParamDecorator } from '@znight/core'
import { User } from './user.ts'
export const CurrentUser = createParamDecorator<User>({ fake: () => new User() })
`,
      'src/handler.ts': `import { Handle, Handlers } from '@acme/fake'
import { CurrentUser } from './decorators.ts'
import type { Admin, Principal, User, WithMethod } from './user.ts'
@Handlers()
export class Handler {
  @Handle()
  run(
    @CurrentUser() principal: Principal,
    @CurrentUser() admin: Admin,
    @CurrentUser() withMethod: WithMethod,
    @CurrentUser() user: User,
  ): void {}
}
`,
    })
    const uses = new Map<string, ParamDecoratorUse | undefined>()
    try {
      const result = await analyzeRoot(app.root, { extensions: [fakeExtension(uses)] })
      expect(renderDiagnostics(result.root, result.diagnostics)).toBe('')
      // undecided (methods, private members): the generated argument is cast
      const casts = [...uses].map(([key, use]) => [key, use?.ok && use.cast])
      expect(casts).toEqual([
        ['run.principal', true],
        ['run.admin', true],
        ['run.withMethod', true],
        ['run.user', false],
      ])
    } finally {
      app.cleanup()
    }
  })

  it('costs nothing without definitions', async () => {
    const app = tempApp({
      ...FAKE,
      'src/handler.ts': `import { Handle, Handlers } from '@acme/fake'
@Handlers()
export class Handler {
  @Handle()
  run(value: string): string {
    return value
  }
}
`,
    })
    const uses = new Map<string, ParamDecoratorUse | undefined>()
    try {
      const result = await analyzeRoot(app.root, { extensions: [fakeExtension(uses)] })
      expect(result.diagnostics).toEqual([])
      expect([...uses]).toEqual([['run.value', undefined]])
    } finally {
      app.cleanup()
    }
  })
})

describe('TypeHelpers.assignable', () => {
  it('compares shapes conservatively', async () => {
    const app = tempApp({
      ...FAKE,
      'src/types.ts': `export interface User { readonly id: string; readonly name?: string }
export interface Admin extends User { readonly level: number }
export interface Named { readonly name: string }
export class Account { constructor(readonly id: string) {} get label(): string { return this.id } }
export type Id = string
export type Role = 'admin' | 'user'
export interface Tree { readonly children: Tree[] }
export interface Node { readonly children: Node[] }
`,
      'src/handler.ts': `import { Handle, Handlers } from '@acme/fake'
import type { Account, Admin, Id, Named, Role, Tree, Node, User } from './types.ts'
@Handlers()
export class Handler {
  @Handle()
  run(
    user: User, admin: Admin, named: Named, account: Account, id: Id, role: Role, tree: Tree, node: Node,
    maybe: User | undefined, nullable: User | null, list: User[], text: string, num: number, any: any, unknownValue: unknown,
    noAnnotation, literal: 'admin', pair: [string, number], fn: () => void, date: Date, labelled: { readonly label: string },
  ): void {}
}
`,
    })
    let helpers: TypeHelpers | undefined
    const params = new Map<string, import('../../src/index.ts').ParameterInfo>()
    const extension: CompilerExtension = {
      apiVersion: 1,
      name: 'fake',
      decorators: {
        '@acme/fake#Handlers': { targets: ['class'], params: [] },
        '@acme/fake#Handle': { targets: ['method'], params: [] },
      },
      analyzeClass(cls, ctx) {
        helpers = ctx.types
        for (const param of cls.methods[0]?.params ?? []) params.set(param.name, param)
      },
    }
    try {
      const result = await analyzeRoot(app.root, { extensions: [extension] })
      expect(result.diagnostics).toEqual([])
      const types = helpers as TypeHelpers
      const check = (source: string, target: string): boolean | undefined =>
        types.assignable({ parameter: params.get(source) as never }, { parameter: params.get(target) as never })
      expect(check('user', 'user')).toBe(true)
      expect(check('admin', 'user')).toBe(true)
      expect(check('user', 'admin')).toBe(false)
      expect(check('user', 'named')).toBe(false)
      expect(check('maybe', 'user')).toBe(false)
      expect(check('user', 'maybe')).toBe(true)
      expect(check('nullable', 'user')).toBe(false)
      expect(check('nullable', 'maybe')).toBe(false)
      expect(check('list', 'list')).toBe(true)
      expect(check('user', 'list')).toBe(false)
      expect(check('id', 'text')).toBe(true)
      expect(check('role', 'text')).toBe(true)
      expect(check('text', 'role')).toBe(false)
      expect(check('literal', 'role')).toBe(true)
      expect(check('num', 'text')).toBe(false)
      expect(check('any', 'user')).toBeUndefined()
      expect(check('unknownValue', 'user')).toBeUndefined()
      expect(check('user', 'unknownValue')).toBe(true)
      expect(check('noAnnotation', 'user')).toBeUndefined()
      expect(check('tree', 'node')).toBe(true)
      expect(check('pair', 'pair')).toBe(true)
      expect(check('fn', 'fn')).toBeUndefined()
      expect(check('date', 'date')).toBe(true)
      expect(check('account', 'labelled')).toBe(true)
      expect(types.assignable(params.get('text')?.type as never, params.get('id')?.type as never)).toBe(true)
    } finally {
      app.cleanup()
    }
  })

  it('never decides on members the instance shapes leave out (methods, private members)', async () => {
    const app = tempApp({
      ...FAKE,
      'src/types.ts': `export class User {
  id = ''
  hasRole(role: string): boolean {
    return role === this.id
  }
}
export class Plain { id = '' }
export class Child extends User {}
export interface Principal { readonly id: string; readonly hasRole: (role: string) => boolean }
export interface WithMethod { readonly id: string; isAdmin(): boolean }
export interface WithOptional { readonly id: string; readonly isAdmin?: () => boolean }
export class Admin { private secret = 1; id = '' }
export class Guarded { #token = ''; id = '' }
export interface Missing { readonly id: string; readonly name: string }
`,
      'src/handler.ts': `import { Handle, Handlers } from '@acme/fake'
import type { Admin, Child, Guarded, Missing, Plain, Principal, User, WithMethod, WithOptional } from './types.ts'
@Handlers()
export class Handler {
  @Handle()
  run(
    user: User, plain: Plain, child: Child, principal: Principal, withMethod: WithMethod, withOptional: WithOptional,
    admin: Admin, guarded: Guarded, missing: Missing, inline: { readonly id: string; isAdmin(): boolean },
  ): void {}
}
`,
    })
    let helpers: TypeHelpers | undefined
    const params = new Map<string, import('../../src/index.ts').ParameterInfo>()
    const extension: CompilerExtension = {
      apiVersion: 1,
      name: 'fake',
      decorators: {
        '@acme/fake#Handlers': { targets: ['class'], params: [] },
        '@acme/fake#Handle': { targets: ['method'], params: [] },
      },
      analyzeClass(cls, ctx) {
        helpers = ctx.types
        for (const param of cls.methods[0]?.params ?? []) params.set(param.name, param)
      },
    }
    try {
      const result = await analyzeRoot(app.root, { extensions: [extension] })
      expect(result.diagnostics).toEqual([])
      const types = helpers as TypeHelpers
      const check = (source: string, target: string): boolean | undefined =>
        types.assignable({ parameter: params.get(source) as never }, { parameter: params.get(target) as never })
      // a function property of the target may be a method of the source (left out of its shape)
      expect(check('user', 'principal')).toBeUndefined()
      expect(check('child', 'principal')).toBeUndefined()
      expect(check('user', 'withOptional')).toBe(true)
      // a source without methods certainly lacks it
      expect(check('plain', 'principal')).toBe(false)
      expect(check('user', 'missing')).toBe(false)
      // methods and private members of the target are not compared: never `true`
      expect(check('user', 'withMethod')).toBeUndefined()
      expect(check('plain', 'inline')).toBeUndefined()
      expect(check('user', 'admin')).toBeUndefined()
      expect(check('user', 'guarded')).toBeUndefined()
      expect(check('plain', 'child')).toBeUndefined()
      // still decided when the target certainly lacks something
      expect(check('plain', 'missing')).toBe(false)
      // the same declaration is still assignable to itself
      expect(check('user', 'user')).toBe(true)
      expect(check('admin', 'admin')).toBe(true)
      expect(check('user', 'plain')).toBe(true)
    } finally {
      app.cleanup()
    }
  })
})
