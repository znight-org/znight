import type { GraphQLGuard, ResolverContext } from '../src/index.ts'

import { ErrorCode } from '@znight/core'
import { createRouteDecorator } from '@znight/http'

import { bind, boot, field, graphqlMetadata } from './support/app.ts'
import { describe, expect, it } from 'bun:test'

const Public = createRouteDecorator('public', { group: 'access', required: true })
const Roles = createRouteDecorator<readonly string[]>('roles', { group: 'access', required: true })

/** What the guards saw, in order. */
let calls: string[] = []

class GlobalGuard implements GraphQLGuard {
  static readonly enforces = [Public, Roles]
  canResolve(ctx: ResolverContext): boolean {
    calls.push(`global ${ctx.route.coordinate}`)
    if (Public.get(ctx) === true) return true
    return Roles.get(ctx)?.includes('admin') === true && ctx.operation.state.get('admin') !== false
  }
}

class ClassGuard implements GraphQLGuard {
  canResolve(ctx: ResolverContext): Promise<boolean> {
    calls.push(`class ${ctx.parentType}.${ctx.field}`)
    return Promise.resolve(ctx.args['deny'] !== 'class')
  }
}

class MethodGuard implements GraphQLGuard {
  canResolve(ctx: ResolverContext): boolean {
    calls.push(`method ${ctx.parentType}.${ctx.field}`)
    return ctx.args['deny'] !== 'method'
  }
}

class Books {
  static created = 0
  constructor() {
    Books.created++
  }
  book(args: { deny?: string }): { id: string; deny: string | undefined } {
    return { id: '1', deny: args.deny }
  }
  secret(): string {
    return 'secret'
  }
  author(_args: unknown, parent: { id: string }): string {
    return `author of ${parent.id}`
  }
  reviews(_args: unknown, parent: { id: string }): string[] {
    return [`review of ${parent.id}`]
  }
}

function guardedMetadata() {
  return graphqlMetadata({
    providers: [Books, GlobalGuard, ClassGuard, MethodGuard],
    groups: { access: { keys: ['public', 'roles'], required: true } },
    types: [
      {
        kind: 'object',
        name: 'Book',
        fields: [
          { name: 'id', type: 'ID!' },
          // no metadata: covered by the root field's decision, global guards skip it
          field('author', 'String!', bind(Books, 'author', { operation: 'field', guards: [MethodGuard] })),
          // own metadata: global guards run
          field('reviews', '[String!]!', bind(Books, 'reviews', { operation: 'field', meta: { roles: ['admin'] } })),
        ],
      },
      {
        kind: 'object',
        name: 'Query',
        fields: [
          field('book', 'Book', bind(Books, 'book', { guards: [ClassGuard, MethodGuard], meta: { public: true } }), {
            args: [{ name: 'deny', type: 'String' }],
          }),
          field('secret', 'String', bind(Books, 'secret', { meta: { roles: ['admin'] } })),
        ],
      },
    ],
  })
}

describe('resolver pipeline', () => {
  it('runs global, class then method guards on root fields', async () => {
    await using booted = await boot(guardedMetadata(), { guards: [GlobalGuard] })
    calls = []
    const result = await booted.plugin.execute({ query: '{ book { id author } }' })
    expect(result).toEqual({ data: { book: { id: '1', author: 'author of 1' } } })
    expect(calls).toEqual(['global Query.book', 'class Query.book', 'method Query.book', 'method Book.author'])
  })

  it('runs global guards on field resolvers carrying their own metadata only', async () => {
    await using booted = await boot(guardedMetadata(), { guards: [GlobalGuard] })
    calls = []
    const result = await booted.plugin.execute({ query: '{ book { reviews } }' })
    expect(calls).toEqual(['global Query.book', 'class Query.book', 'method Query.book', 'global Book.reviews'])
    expect(result.data).toEqual({ book: { reviews: ['review of 1'] } })
  })

  it('fails a field with FORBIDDEN when a guard returns false', async () => {
    await using booted = await boot(guardedMetadata(), { guards: [GlobalGuard] })
    calls = []
    const denied = await booted.plugin.execute({ query: '{ book(deny: "class") { id } secret }' })
    expect(denied).toEqual({
      data: { book: null, secret: 'secret' },
      errors: [
        {
          message: 'Not allowed to resolve Query.book',
          locations: [{ line: 1, column: 3 }],
          path: ['book'],
          extensions: { code: 'FORBIDDEN' },
        },
      ],
    })
    // the method guard did not run once the class guard denied
    expect(calls).toEqual(['global Query.book', 'class Query.book', 'global Query.secret'])
    const method = await booted.plugin.execute({ query: '{ book(deny: "method") { id } }' })
    expect(method.errors?.[0]?.extensions).toEqual({ code: 'FORBIDDEN' })
  })

  it('reads guards and resolvers of narrower scopes in the current scope', async () => {
    let created = 0
    class Scoped {
      readonly id = ++created
      who(): number {
        return this.id
      }
    }
    const metadata = graphqlMetadata({
      providers: [{ class: Scoped, scope: 'request' }],
      types: [
        {
          kind: 'object',
          name: 'Query',
          fields: [field('a', 'Int', bind(Scoped, 'who')), field('b', 'Int', bind(Scoped, 'who'))],
        },
      ],
    })
    await using booted = await boot(metadata)
    expect(await booted.plugin.execute({ query: '{ a b }' })).toEqual({ data: { a: 1, b: 1 } })
    expect(await booted.plugin.execute({ query: '{ a b }' })).toEqual({ data: { a: 2, b: 2 } })
  })

  it('resolves singleton resolvers once, at boot', async () => {
    Books.created = 0
    await using booted = await boot(guardedMetadata(), { guards: [GlobalGuard] })
    for (let index = 0; index < 3; index++) await booted.plugin.execute({ query: '{ secret }' })
    expect(Books.created).toBe(1)
  })

  it('turns null into undefined where the TypeScript type does not accept null', async () => {
    let received: unknown
    class Echo {
      echo(args: unknown): string {
        received = args
        return 'ok'
      }
    }
    const metadata = graphqlMetadata({
      providers: [Echo],
      types: [
        {
          kind: 'input',
          name: 'Filter',
          fields: [
            { name: 'search', type: 'String', nullAsUndefined: true },
            { name: 'tag', type: 'String' },
            { name: 'nested', type: '[Filter]' },
          ],
        },
        {
          kind: 'object',
          name: 'Query',
          fields: [
            field('echo', 'String', bind(Echo, 'echo'), {
              args: [
                { name: 'limit', type: 'Int', nullAsUndefined: true },
                { name: 'cursor', type: 'String' },
                { name: 'filter', type: 'Filter' },
              ],
            }),
          ],
        },
      ],
    })
    await using booted = await boot(metadata)
    await booted.plugin.execute({
      query: 'query($f: Filter) { echo(limit: null, cursor: null, filter: $f) }',
      variables: { f: { search: null, tag: null, nested: [{ search: null, tag: 'x' }, null] } },
    })
    expect(received).toEqual({
      limit: undefined,
      cursor: null,
      filter: { search: undefined, tag: null, nested: [{ search: undefined, tag: 'x' }, null] },
    })
    expect(Object.hasOwn(received as object, 'limit')).toBe(true)
  })

  it('checks route decisions of root fields at boot (ZNIGHT023)', async () => {
    const metadata = graphqlMetadata({
      providers: [Books, GlobalGuard],
      groups: { access: { keys: ['public', 'roles'], required: true } },
      types: [
        {
          kind: 'object',
          name: 'Query',
          fields: [
            field('book', 'String', bind(Books, 'secret')),
            field('secret', 'String', bind(Books, 'secret', { meta: { roles: ['admin'] } })),
          ],
        },
      ],
    })
    // no decision on Query.book, and nothing enforces the access group
    let error: unknown
    try {
      await boot(metadata)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: ErrorCode.MissingRouteDecision })
    expect((error as Error).message).toBe(
      'ZNIGHT023: GraphQLPlugin: 1 field has no "access" decision: Query.book (Books.secret); no guard enforces the "access" group on 1 field: Query.secret (Books.secret)',
    )
    // with the enforcing guard, only the missing decision remains; warn mode logs it
    await using warned = await boot(metadata, { guards: [GlobalGuard], enforcement: 'warn' })
    expect(warned.logs.messages('warn')).toEqual([
      'GraphQLPlugin: 1 field has no "access" decision: Query.book (Books.secret)',
    ])
  })

  it('rejects guards without canResolve() at boot', async () => {
    class NotAGuard {}
    const metadata = graphqlMetadata({
      providers: [Books, NotAGuard],
      types: [
        {
          kind: 'object',
          name: 'Query',
          fields: [field('secret', 'String', bind(Books, 'secret', { guards: [NotAGuard] }))],
        },
      ],
    })
    await expect(boot(metadata)).rejects.toMatchObject({ code: ErrorCode.InvalidGraphQLSetup })
    await expect(
      boot(
        graphqlMetadata({
          providers: [Books, NotAGuard],
          types: [{ kind: 'object', name: 'Query', fields: [field('secret', 'String', bind(Books, 'secret'))] }],
        }),
        { guards: [NotAGuard as never] },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidGraphQLSetup })
  })

  it('reports a resolver that is not a provider (ZNIGHT001)', async () => {
    class Unknown {
      x(): number {
        return 1
      }
    }
    const metadata = graphqlMetadata({
      types: [{ kind: 'object', name: 'Query', fields: [field('x', 'Int', bind(Unknown, 'x'))] }],
    })
    await expect(boot(metadata)).rejects.toMatchObject({ code: ErrorCode.MissingProvider })
  })
})
