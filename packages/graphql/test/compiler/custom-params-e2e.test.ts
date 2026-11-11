/**
 * End to end: custom parameter decorators (RFC 0010) on GraphQL resolvers, code-first. One
 * definition serves HTTP routes and GraphQL fields; function and class resolvers, data arguments,
 * guards sharing the `ResolverContext`, errors in `errors[]`, through the built-in transport and
 * the Yoga driver (RFC 0009). The generated module type-checks.
 */
import type { CompileResult } from '@znight/compiler'
import type { ZnightMetadata } from '@znight/core'
import type { GraphQLMetadata } from '../../src/index.ts'
import type { TempApp } from './helpers.ts'

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'

import { GraphQLPlugin } from '../../src/index.ts'
import { executeOperation } from '../../src/testing.ts'
import { yogaDriver } from '../../src/yoga.ts'
import { captureLogger } from '../support/app.ts'
import { analyzeSchemaFirst, cleanupApps, compileApp, render, tempApp, typecheck } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const FILES: Readonly<Record<string, string>> = {
  'src/user.ts': `export interface User {
  readonly id: string
}

/** Resolver calls, in order. */
export const calls: string[] = []
`,
  'src/current-user.ts': `import type { ParamResolver } from '@znight/core'
import type { HttpContext } from '@znight/http'
import type { ResolverContext } from '@znight/graphql'
import { createParamDecorator, Injectable } from '@znight/core'
import { GraphQLErrorCode, GraphQLException } from '@znight/graphql'
import { calls, type User } from './user.ts'

function userOf(header: string | undefined): User {
  if (header === undefined) throw new GraphQLException('Not authenticated', { code: GraphQLErrorCode.Unauthenticated })
  return { id: header }
}

let created = 0

@Injectable({ scope: 'request' })
export class LoadedUserResolver implements ParamResolver<ResolverContext, User> {
  readonly #instance = ++created
  async resolve(ctx: ResolverContext): Promise<User> {
    calls.push(\`loaded \${this.#instance} \${ctx.route.coordinate}\`)
    return userOf(ctx.http?.header('x-user'))
  }
}

export const CurrentUser = createParamDecorator<User>({
  http: (ctx: HttpContext) => userOf(ctx.header('x-user')),
  graphql: ctx => {
    calls.push(\`current \${ctx.route.coordinate} \${String(ctx.operation.state.get('guarded') ?? false)}\`)
    return userOf(ctx.http?.header('x-user'))
  },
})
export const Prefixed = createParamDecorator<string, string>({
  graphql: (ctx, prefix) => \`\${prefix}:\${ctx.parentType}.\${ctx.field}\`,
})
export const LoadedUser = createParamDecorator<User>({ graphql: LoadedUserResolver })

/** \`resolve\` inherited from a base class. */
class BaseFieldResolver {
  resolve(ctx: ResolverContext): string {
    return ctx.field
  }
}
export class FieldNameResolver extends BaseFieldResolver {}

/** \`resolve\` from a base the compiler cannot analyse (a mixin): its arity is unknown. */
// biome-ignore lint/suspicious/noExplicitAny: the constructor type TypeScript requires of a mixin
function withResolve<T extends new (...args: any[]) => object>(base: T) {
  return class extends base {
    resolve(ctx: ResolverContext): string {
      return ctx.route.coordinate
    }
  }
}
const Mixed = withResolve(class {})
export class CoordinateResolver extends Mixed {
  constructor() {
    super()
  }
}

/** \`resolve()\` reads nothing from the context. */
export class ConstantResolver {
  resolve(): string {
    return 'constant'
  }
}

export const FieldName = createParamDecorator<string>({ graphql: FieldNameResolver })
export const Constant = createParamDecorator<string>({ graphql: ConstantResolver })
export const Coordinate = createParamDecorator<string>({ graphql: CoordinateResolver })
`,
  'src/guard.ts': `import type { GraphQLGuard, ResolverContext } from '@znight/graphql'
import { Injectable } from '@znight/core'

@Injectable()
export class MarkGuard implements GraphQLGuard {
  canResolve(ctx: ResolverContext): boolean {
    ctx.operation.state.set('guarded', true)
    return true
  }
}
`,
  'src/me.resolver.ts': `import { Args, Query, Resolver, UseGuard } from '@znight/graphql'
import { Constant, Coordinate, CurrentUser, FieldName, LoadedUser, Prefixed } from './current-user.ts'
import { MarkGuard } from './guard.ts'
import type { User } from './user.ts'

@Resolver()
export class MeResolver {
  @Query()
  me(@CurrentUser() user: User): string {
    return user.id
  }

  @Query()
  @UseGuard(MarkGuard)
  guarded(@CurrentUser() user: User, @Prefixed('field') where: string): string {
    return \`\${user.id} \${where}\`
  }

  @Query()
  echo(@Args('text') text: string, @Prefixed('echo') where: string): string {
    return \`\${text} \${where}\`
  }

  @Query()
  loaded(@LoadedUser() first: User, @LoadedUser() second: User): boolean {
    return first.id === second.id
  }

  @Query()
  constant(@Constant() value: string): string {
    return value
  }

  @Query()
  inherited(@FieldName() field: string, @Coordinate() coordinate: string): string {
    return \`\${field} \${coordinate}\`
  }
}
`,
  'src/me.controller.ts': `import { Controller, Get } from '@znight/http'
import { CurrentUser } from './current-user.ts'
import type { User } from './user.ts'

@Controller('/rest')
export class MeController {
  @Get('/me')
  me(@CurrentUser() user: User): User {
    return user
  }
}
`,
}

describe('custom parameter decorators on GraphQL resolvers (e2e)', () => {
  let app: TempApp
  let result: CompileResult
  let section: GraphQLMetadata
  let test: TestApp
  let yoga: TestApp
  let calls: string[]

  beforeAll(async () => {
    app = tempApp(FILES)
    result = await compileApp(app.root, { mode: 'build' })
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    const generated = (await import(pathToFileURL(result.outFile).href)) as { metadata: ZnightMetadata }
    section = generated.metadata.extensions?.graphql as GraphQLMetadata
    calls = ((await import(pathToFileURL(app.path('src/user.ts')).href)) as { calls: string[] }).calls
    test = await TestApp.create({
      metadata: generated.metadata,
      plugins: [HttpPlugin.configure({ port: 0, host: '127.0.0.1' }), GraphQLPlugin.configure()],
      logger: captureLogger(),
    })
    yoga = await TestApp.create({
      metadata: generated.metadata,
      plugins: [
        HttpPlugin.configure({ port: 0, host: '127.0.0.1' }),
        GraphQLPlugin.configure({ driver: yogaDriver() }),
      ],
      logger: captureLogger(),
    })
  }, 60_000)

  afterAll(async () => {
    await yoga?.close()
    await test?.close()
    cleanupApps()
  })

  it('generates the ResolverContext and resolver parameters only for fields that use them', () => {
    const fields = section.types.flatMap(type => ('fields' in type ? (type.fields ?? []) : []))
    const binding = (name: string) => fields.find(field => field.name === name)?.resolver
    expect(binding('me')).toMatchObject({ context: true })
    expect(binding('loaded')).toMatchObject({
      context: true,
      paramResolvers: ['src/current-user.ts#LoadedUserResolver'],
    })
    expect(binding('me') && 'paramResolvers' in binding('me')!).toBe(false)
    expect(result.code).toContain(
      '(r: MeResolver, _p: unknown, _a: GraphQLArgs, _c: GraphQLContext, _i: GraphQLResolveInfo, f: ResolverContext) =>',
    )
    expect(result.code).toContain("CurrentUser.resolvers.graphql as ParamFunctionOf<typeof CurrentUser, 'graphql'>")
    expect(result.code).toContain('x: readonly [LoadedUserResolver]')
    expect(result.code).toContain('const v0 = x[0].resolve(f)')
    // a resolve() without parameter: \`f\` is not declared (noUnusedParameters)
    expect(result.code).toContain(
      '(r: MeResolver, _p: unknown, _a: GraphQLArgs, _c: GraphQLContext, _i: GraphQLResolveInfo, _f: ResolverContext, x: readonly [ConstantResolver]) => {',
    )
    // an inherited resolve method is read; an unreadable one is cast
    expect(result.code).toContain(
      'const v1 = (x[1] as { resolve(ctx: unknown, data: unknown): unknown }).resolve(f, undefined) as never',
    )
  })

  it('type-checks under max-strict settings', () => {
    expect(typecheck(app, [path.relative(app.root, result.outFile)])).toEqual([])
  }, 60_000)

  it('resolves custom parameters, after the guards and with their ResolverContext', async () => {
    calls.splice(0)
    const res = await executeOperation(test, {
      query: '{ me guarded echo(text: "hi") }',
      headers: { 'x-user': 'ada' },
    })
    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({ me: 'ada', guarded: 'ada field:Query.guarded', echo: 'hi echo:Query.echo' })
    expect(calls).toEqual(['current Query.me false', 'current Query.guarded true'])
  })

  it('calls inherited and unanalysable resolve methods', async () => {
    const res = await executeOperation(test, { query: '{ inherited constant }' })
    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({ inherited: 'inherited Query.inherited', constant: 'constant' })
  })

  it('reports resolver errors in errors[]', async () => {
    const res = await executeOperation(test, { query: '{ me }' })
    expect(res.data).toBeNull()
    expect(res.errors?.[0]).toMatchObject({ message: 'Not authenticated', extensions: { code: 'UNAUTHENTICATED' } })
  })

  it('resolves class resolvers in the operation scope', async () => {
    calls.splice(0)
    const first = await executeOperation(test, { query: '{ loaded }', headers: { 'x-user': 'ada' } })
    const second = await executeOperation(test, { query: '{ loaded }', headers: { 'x-user': 'lin' } })
    expect(first.data).toEqual({ loaded: true })
    expect(second.data).toEqual({ loaded: true })
    expect(calls).toEqual([
      'loaded 1 Query.loaded',
      'loaded 1 Query.loaded',
      'loaded 2 Query.loaded',
      'loaded 2 Query.loaded',
    ])
  })

  it('resolves custom parameters through the Yoga driver', async () => {
    calls.splice(0)
    const post = (query: string, headers: Record<string, string> = {}) =>
      yoga.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json', ...headers },
        body: JSON.stringify({ query }),
      })
    const ok = await post('{ me guarded echo(text: "hi") loaded constant }', { 'x-user': 'ada' })
    expect(ok.json()).toEqual({
      data: {
        me: 'ada',
        guarded: 'ada field:Query.guarded',
        echo: 'hi echo:Query.echo',
        loaded: true,
        constant: 'constant',
      },
    })
    expect(calls.slice(0, 2)).toEqual(['current Query.me false', 'current Query.guarded true'])
    const denied = (await post('{ me }')).json() as { data: unknown; errors?: unknown[] }
    expect(denied.data).toBeNull()
    expect(denied.errors?.[0]).toMatchObject({ message: 'Not authenticated', extensions: { code: 'UNAUTHENTICATED' } })
  })

  it('serves the same decorator on an HTTP route', async () => {
    const res = await test.inject({ method: 'GET', url: '/rest/me', headers: { 'x-user': 'lin' } })
    expect(res.json()).toEqual({ id: 'lin' })
  })
})

describe('custom parameter decorators in schema-first resolvers', () => {
  it('are not GraphQL arguments: the conformance skips them', async () => {
    const result = await analyzeSchemaFirst({
      'src/schema.graphql': 'type Query {\n  me(greeting: String!): String!\n}\n',
      'src/user.ts': FILES['src/user.ts'] as string,
      'src/current-user.ts': FILES['src/current-user.ts'] as string,
      'src/me.resolver.ts': `import { Args, Query, Resolver } from '@znight/graphql'
import { CurrentUser } from './current-user.ts'
import type { User } from './user.ts'

@Resolver()
export class MeResolver {
  @Query()
  me(@Args('greeting') greeting: string, @CurrentUser() user: User): string {
    return \`\${greeting} \${user.id}\`
  }
}
`,
    })
    expect(render(result)).toEqual([])
    const field = result.stored[0]?.fields[0]
    expect(field?.params.map(param => param?.kind)).toEqual(['args', 'custom'])
  })
})
