/**
 * Resolver analysis (RFC 0005 §6.1, §6.5): providers and roots, method and parameter checks
 * (ZNIGHT005, ZNIGHT060, ZNIGHT062), guards and loaders bound with lazy edges (ZNIGHT001,
 * ZNIGHT003, ZNIGHT065), route decorators and required decisions (ZNIGHT023).
 */
import { ACCESS } from './fixtures.ts'
import { analyzeFiles, cleanupApps, render } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const IMPORTS = `import {
  Args,
  Ctx,
  type GraphQLContext,
  type GraphQLGuard,
  Info,
  Loader,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
  Subscription,
  UseGuard,
} from '@znight/graphql'
`

/** A resolver file: the imports above, then `body`. */
function resolverFile(body: string): Record<string, string> {
  return {
    'src/r.resolver.ts': `${IMPORTS}
void [Args, Ctx, Info, Loader, Mutation, Parent, Query, ResolveField, Resolver, Subscription, UseGuard]
void (0 as unknown as [GraphQLContext, GraphQLGuard])

${body}`,
  }
}

const PING = `  @Query()
  ping(): boolean {
    return true
  }`

describe('resolvers', () => {
  it('registers @Resolver classes as providers and roots, with their scope', async () => {
    const result = await analyzeFiles(
      resolverFile(`@Resolver({ scope: 'request' })
export class R {
${PING}
}
`),
    )
    expect(render(result)).toEqual([])
    const provider = result.graph.providers.find(node => node.token === 'src/r.resolver.ts#R')
    expect(provider).toMatchObject({ scope: 'request', registeredBy: 'graphql' })
    expect(result.graph.roots).toContainEqual(
      expect.objectContaining({ token: 'src/r.resolver.ts#R', reason: 'GraphQL resolver' }),
    )
    expect(result.stored[0]).toMatchObject({
      kind: 'resolver',
      scope: 'request',
      fields: [{ method: 'ping', operation: 'query', name: 'ping', complete: true, params: [] }],
    })
  })

  it('rejects invalid options, @Resolver on a controller, abstract and generic classes', async () => {
    const result = await analyzeFiles({
      ...resolverFile(`import { Controller } from '@znight/http'

@Resolver({ scope: 'forever', cache: true })
export class R {
${PING}
}

@Resolver()
@Controller('/c')
export class Both {}

@Resolver()
export abstract class Base {}

@Resolver()
export class Generic<T> {
  value?: T
}
`),
    })
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT005 src/r.resolver.ts:22:11 @Resolver: invalid scope "forever"',
      'error ZNIGHT005 src/r.resolver.ts:22:11 @Resolver: unknown option "cache"',
      'error ZNIGHT005 src/r.resolver.ts:30:1 Both cannot be both a @Resolver and a @Controller',
      'error ZNIGHT005 src/r.resolver.ts:34:1 @Resolver cannot be applied to the abstract class Base',
      'error ZNIGHT005 src/r.resolver.ts:37:1 @Resolver cannot be applied to the generic class Generic<T>',
    ])
  })

  it('rejects resolvers in compiled provider libraries (ZNIGHT062)', async () => {
    const result = await analyzeFiles(resolverFile(`@Resolver()\nexport class R {\n${PING}\n}\n`), { library: true })
    expect(render(result)).toEqual([
      [
        'error ZNIGHT062 src/r.resolver.ts:20:1 R is a @Resolver in a compiled provider library: the schema is derived from the sources',
        '  = Publish the package as a source library (without library: true), so that applications compile its resolvers',
      ].join('\n'),
    ])
  })

  it('rejects field methods outside resolvers: methods are not inherited (ZNIGHT062)', async () => {
    const result = await analyzeFiles(
      resolverFile(`export abstract class Base {
  @Query()
  shared(): boolean {
    return true
  }
}

export class Forgotten {
  @Mutation()
  run(@Args('x') x: string): string {
    return x
  }
}

@UseGuard(Forgotten as never)
export class Guarded {}

@Resolver()
export class R extends Base {
${PING}
}
`),
    )
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT062 src/r.resolver.ts:21:3 @Query Base.shared is declared on a class that is not a @Resolver',
      'error ZNIGHT062 src/r.resolver.ts:28:3 @Mutation Forgotten.run is declared on a class that is not a @Resolver',
      'error ZNIGHT005 src/r.resolver.ts:34:1 @UseGuard has no effect: Guarded is not a @Resolver',
    ])
    expect(render(result)[0]).toContain(
      'Resolver methods are not inherited: declare the field on the concrete @Resolver() class (it may call shared of the base class)',
    )
  })
})

describe('field methods', () => {
  it('rejects static, private, accessor, generic and foreign handler methods (ZNIGHT005)', async () => {
    const result = await analyzeFiles(
      resolverFile(`import { Get } from '@znight/http'

@Resolver()
export class R {
${PING}

  @Query()
  static count(): number {
    return 0
  }

  @Query()
  private hidden(): number {
    return 0
  }

  @Query()
  get size(): number {
    return 0
  }

  @Query()
  first<T>(): T {
    return null as never
  }

  @Query()
  @Get('/x')
  both(): number {
    return 0
  }
}
`),
    )
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT005 src/r.resolver.ts:29:3 @Query cannot be applied to the static method R.count',
      'error ZNIGHT005 src/r.resolver.ts:34:3 R.hidden must be public: @Query methods are called by the generated code',
      'error ZNIGHT005 src/r.resolver.ts:39:3 @Query cannot be applied to the accessor R.size',
      'error ZNIGHT005 src/r.resolver.ts:44:3 @Query cannot be applied to the generic method R.first<T>',
      'error ZNIGHT005 src/r.resolver.ts:50:3 @Get has no effect: R is not a controller',
      'error ZNIGHT005 src/r.resolver.ts:50:3 R.both cannot be both a GraphQL field (@Query) and a @Get handler',
    ])
  })

  it('requires @Parent() in field resolvers only (ZNIGHT062)', async () => {
    const result = await analyzeFiles(
      resolverFile(`interface Book {
  readonly id: string
}

@Resolver()
export class R {
  @Query()
  book(@Parent() parent: Book): Book {
    return parent
  }

  @ResolveField()
  author(@Args('x') x: string): string {
    return x
  }

  @ResolveField()
  twice(@Parent() a: Book, @Parent() b: Book): string {
    return a.id + b.id
  }
}
`),
    )
    expect(render(result)).toEqual([
      [
        '@Parent() is only available in @ResolveField methods, not in the @Query R.book',
        'error ZNIGHT062 src/r.resolver.ts:27:8',
      ]
        .reverse()
        .join(' ')
        .concat('\n  = Root fields have no parent object: remove the parameter'),
      [
        'error ZNIGHT062 src/r.resolver.ts:31:3 @ResolveField R.author has no @Parent() parameter',
        '  = Declare the parent object first: author(@Parent() parent: ParentType, ...)',
      ].join('\n'),
      [
        'error ZNIGHT062 src/r.resolver.ts:37:28 R.twice has several @Parent() parameters',
        '  = Declare the parent object once',
      ].join('\n'),
    ])
  })
})

describe('parameters', () => {
  it('rejects undecorated parameters, @znight/http look-alikes and several decorators (ZNIGHT005)', async () => {
    const result = await analyzeFiles(
      resolverFile(`import { Ctx as HttpCtx, Query as HttpQuery } from '@znight/http'

@Resolver()
export class R {
  @Query()
  a(plain: string, @HttpCtx() ctx: unknown, @HttpQuery('q') q: string, @Args('x') @Ctx() both: string): string {
    return plain + String(ctx) + q + both
  }

  @Query()
  b(@Args(42 as never) x: string, @Args('not-a-name') y: string, @Args('z', { notASchema: true } as never) z: string): string {
    return x + y + z
  }

  @Query()
  c(@Ctx() ...rest: unknown[]): string {
    return String(rest)
  }
}
`),
    )
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      "error ZNIGHT005 src/r.resolver.ts:25:5 Parameter 'plain' of R.a has no @Args(), @Parent(), @Ctx(), @Info() or @Loader() decorator",
      "error ZNIGHT005 src/r.resolver.ts:25:20 @Ctx on parameter 'ctx' of R.a is imported from '@znight/http': resolver parameters use @Ctx() from '@znight/graphql'",
      "error ZNIGHT005 src/r.resolver.ts:25:45 @Query on parameter 'q' of R.a is imported from '@znight/http': resolver parameters use @Args() from '@znight/graphql'",
      "error ZNIGHT005 src/r.resolver.ts:25:83 Parameter 'both' of R.a has several GraphQL decorators (@Args, @Ctx)",
      "error ZNIGHT005 src/r.resolver.ts:30:11 @Args on parameter 'x' of R.b expects an argument name or a schema, got 42",
      "error ZNIGHT061 src/r.resolver.ts:30:41 'not-a-name' is not a valid GraphQL argument name (parameter 'y' of R.b)",
      "error ZNIGHT005 src/r.resolver.ts:30:77 The schema of @Args on parameter 'z' of R.b must be a reference to an exported schema",
      "error ZNIGHT005 src/r.resolver.ts:35:5 @Ctx cannot be applied to the rest parameter '...rest' of R.c",
    ])
    expect(render(result)[1]).toContain("= Import it from '@znight/graphql': import { Ctx } from '@znight/graphql'")
  })

  it('stores what each parameter receives', async () => {
    const result = await analyzeFiles({
      'src/schema.ts': `import type { StandardSchemaV1 } from '@znight/graphql'
export interface A {
  readonly a: string
}
export const Input: StandardSchemaV1<unknown, A> = {
  '~standard': { version: 1, vendor: 'test', validate: value => ({ value: value as A }) },
}
`,
      ...resolverFile(`import type { GraphQLResolveInfo } from 'graphql'
import { type A, Input } from './schema.ts'

@Resolver()
export class R {
  @Query()
  a(@Args() all: { readonly x?: string }, @Args('input', Input) input: A, @Args(Input) checked: A, @Ctx() ctx: GraphQLContext, @Info() info: GraphQLResolveInfo): string {
    return String([all, input, checked, ctx, info])
  }
}
`),
    })
    expect(render(result)).toEqual([])
    const params = result.stored[0]?.fields[0]?.params
    expect(params).toMatchObject([
      { kind: 'args', name: undefined, schema: undefined },
      { kind: 'args', name: 'input', schema: { identity: 'src/schema.ts#Input' } },
      { kind: 'args', name: undefined, schema: { identity: 'src/schema.ts#Input' } },
      { kind: 'ctx' },
      { kind: 'info' },
    ])
  })
})

describe('guards and loaders', () => {
  const PROVIDERS = `import { Injectable } from '@znight/core'
import type { BatchLoad, GraphQLGuard, ResolverContext } from '@znight/graphql'

@Injectable({ scope: 'request' })
export class CurrentUser {
  name = 'ada'
}

@Injectable({ scope: 'request' })
export class AccessGuard implements GraphQLGuard {
  constructor(private readonly user: CurrentUser) {}
  canResolve(ctx: ResolverContext): boolean {
    return ctx !== undefined && this.user.name !== ''
  }
}

@Injectable({ scope: 'request' })
export class NamesById implements BatchLoad<string, string> {
  constructor(private readonly user: CurrentUser) {}
  async load(ids: readonly string[]): Promise<readonly string[]> {
    return ids.map(id => id + this.user.name)
  }
}

@Injectable()
export class NotALoader {
  fetch(): string {
    return ''
  }
}

export class Unregistered implements BatchLoad<string, string> {
  async load(ids: readonly string[]): Promise<readonly string[]> {
    return ids
  }
}
`

  it('binds guards and loaders with lazy edges: a singleton resolver may use request-scoped ones', async () => {
    const result = await analyzeFiles({
      'src/providers.ts': PROVIDERS,
      ...resolverFile(`import { AccessGuard, NamesById } from './providers.ts'

@Resolver()
@UseGuard(AccessGuard)
export class R {
  @Query()
  @UseGuard(AccessGuard)
  name(@Loader() names: Loader<NamesById>): Promise<string> {
    return names.load('1')
  }
}
`),
    })
    expect(render(result)).toEqual([])
    const lazy = result.graph.edges.filter(edge => edge.from === 'src/r.resolver.ts#R')
    expect(lazy.map(edge => [edge.to, edge.kind])).toEqual([
      ['src/providers.ts#AccessGuard', 'lazy'],
      ['src/providers.ts#AccessGuard', 'lazy'],
      ['src/providers.ts#NamesById', 'lazy'],
    ])
    const resolver = result.stored[0]
    expect(resolver?.guards.map(guard => guard.token)).toEqual(['src/providers.ts#AccessGuard'])
    expect(resolver?.fields[0]?.guards.map(guard => guard.token)).toEqual(['src/providers.ts#AccessGuard'])
    expect(resolver?.fields[0]?.params[0]).toMatchObject({ kind: 'loader', identity: 'src/providers.ts#NamesById' })
  })

  it('rejects @Loader() parameters that are not Loader<L> and L that are not loaders (ZNIGHT065, ZNIGHT001)', async () => {
    const result = await analyzeFiles({
      'src/providers.ts': PROVIDERS,
      ...resolverFile(`import { NotALoader, Unregistered } from './providers.ts'

@Resolver()
export class R {
  @Query()
  a(@Loader() names: Map<string, string>): string {
    return String(names)
  }

  @Query()
  b(@Loader() names: Loader<NotALoader & never>): string {
    return String(names)
  }

  @Query()
  c(@Loader() names: Loader<Unregistered>): string {
    return String(names)
  }

  @Query()
  d(@Loader() names: Loader<NotALoader>): string {
    return String(names)
  }
}
`),
    })
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      "error ZNIGHT065 src/r.resolver.ts:25:22 @Loader() parameter 'names' of R.a must be typed Loader<L>, with L a loader class",
      "error ZNIGHT065 src/r.resolver.ts:30:22 @Loader() parameter 'names' of R.b must be typed Loader<L>, with L a loader class",
      "error ZNIGHT001 src/r.resolver.ts:35:22 Missing provider for 'Unregistered' required by R",
      'error ZNIGHT065 src/r.resolver.ts:40:22 NotALoader is not a loader: Loader<NotALoader> needs a provider implementing BatchLoad<K, V> (R.d)',
    ])
  })
})

describe('access decisions (RFC 0001)', () => {
  it('requires a decision of every required group on root fields (ZNIGHT023), not on field resolvers', async () => {
    const result = await analyzeFiles({
      'src/auth/access.ts': ACCESS,
      ...resolverFile(`import { Authenticated, Public, Roles } from './auth/access.ts'

interface Book {
  readonly id: string
}

@Resolver()
export class Open {
  @Query()
  @Public()
  books(): readonly Book[] {
    return []
  }

  @Mutation()
  deleteBook(@Args('id') id: string): boolean {
    return id !== ''
  }

  @ResolveField()
  author(@Parent() book: Book): string {
    return book.id
  }
}

@Resolver()
@Authenticated()
export class Closed {
  @Query()
  me(): string {
    return ''
  }

  @Mutation()
  @Roles(['admin'])
  purge(): boolean {
    return true
  }
}
`),
    })
    expect(render(result)).toEqual([
      [
        'error ZNIGHT023 src/r.resolver.ts:35:3 Root field Mutation.deleteBook (Open.deleteBook) has no "access" decision',
        '  = Add @Public(), @Authenticated() or @Roles(...) to the method or to Open',
        '  - The "access" group is required (src/auth/access.ts:5:14)',
      ].join('\n'),
    ])
    const closed = result.stored.find(resolver => resolver.host.name === 'Closed')
    expect(closed?.fields.map(field => field.meta.map(entry => [entry.key, entry.value]))).toEqual([
      [['authenticated', true]],
      [['roles', ['admin']]],
    ])
  })
})
