/**
 * The shared contract as user code and generated code see it: decorators applied with
 * `experimentalDecorators`, loader and context types, guards reading route decorators, scalars,
 * errors, the PubSub contract and hand-written metadata. Most checks are type-level: `bun run
 * typecheck` compiles this file.
 */
import type { ZnightMetadata } from '@znight/core'

import { createRouteDecorator } from '@znight/http'
import { GraphQLScalarType } from 'graphql'

import {
  Args,
  type BatchLoad,
  Ctx,
  type GraphQLArgs,
  type GraphQLContext,
  type GraphQLErrorMapper,
  GraphQLException,
  type GraphQLGuard,
  type GraphQLMetadata,
  type ID,
  Info,
  type Int,
  type JSONValue,
  Loader,
  Mutation,
  Parent,
  PubSub,
  Query,
  ResolveField,
  Resolver,
  type ResolverContext,
  Subscription,
  scalar,
  UseGuard,
} from '../src/index.ts'
import { schemaHash } from '../src/schema-hash.ts'
import { printSdl } from '../src/sdl.ts'
import { describe, expect, it } from 'bun:test'

/** Compile-time equality of two types. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<T extends true>(_check?: T): void {}

const Public = createRouteDecorator('public', { group: 'access', required: true })
const Roles = createRouteDecorator<readonly string[]>('roles', { group: 'access', required: true })

interface Author {
  readonly kind: 'author'
  readonly id: ID
  readonly name: string
}

interface Book {
  readonly kind: 'book'
  readonly id: ID
  readonly title: string
  readonly year: Int | null
  readonly authorId: ID
  readonly extra: JSONValue
}

class AuthorsById implements BatchLoad<ID, Author> {
  readonly options = { maxBatchSize: 100, cacheKeyFn: (key: ID) => key.toLowerCase() }

  load(ids: readonly ID[]): Promise<readonly (Author | Error)[]> {
    return Promise.resolve(ids.map(id => ({ kind: 'author' as const, id, name: `Author ${id}` })))
  }
}

class AccessGuard implements GraphQLGuard {
  static readonly enforces = [Public, Roles]

  canResolve(ctx: ResolverContext): boolean {
    if (Public.get(ctx)) return true
    return Roles.get(ctx)?.includes('editor') === true
  }
}

class CatalogErrorMapper implements GraphQLErrorMapper {
  map(error: unknown, ctx: GraphQLContext): GraphQLException | undefined {
    return error instanceof RangeError
      ? new GraphQLException(error.message, { code: 'NOT_FOUND', extensions: { requestId: ctx.requestId } })
      : undefined
  }
}

interface CatalogEvents {
  bookAdded: Book
}

@Resolver({ scope: 'request' })
@Public()
@UseGuard(AccessGuard)
class BookResolver {
  constructor(private readonly events: PubSub<CatalogEvents>) {}

  @Query()
  book(@Args('id') id: ID, @Info() _info: unknown): Book | null {
    return id === '1' ? { kind: 'book', id, title: 'Dune', year: 1965, authorId: 'a1', extra: { tags: ['sf'] } } : null
  }

  @Mutation('renameBook')
  @Roles(['editor'])
  rename(@Args() args: { readonly id: ID; readonly title: string }): Book {
    return { kind: 'book', id: args.id, title: args.title, year: null, authorId: 'a1', extra: null }
  }

  @ResolveField()
  author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
  }

  @Subscription()
  async *bookAdded(@Ctx() ctx: GraphQLContext): AsyncGenerator<Book> {
    for await (const book of this.events.subscribe('bookAdded', { signal: ctx.signal })) yield book
  }
}

describe('loaders', () => {
  it('derive the key and value types of Loader<L> from the provider', () => {
    type L = Loader<AuthorsById>
    assertType<Equals<Parameters<L['load']>[0], ID>>()
    assertType<Equals<Awaited<ReturnType<L['load']>>, Author>>()
    assertType<Equals<Awaited<ReturnType<L['loadMany']>>, (Author | Error)[]>>()
    expect(new AuthorsById().options.maxBatchSize).toBe(100)
  })

  it('are reachable from the context by class or by token', () => {
    const fake = { load: async (key: unknown) => key } as unknown as Loader<AuthorsById>
    const context = { loader: () => fake } as unknown as GraphQLContext
    const byClass = context.loader(AuthorsById)
    assertType<Equals<typeof byClass, Loader<AuthorsById>>>()
    expect(context.loader('src/authors.loader.ts#AuthorsById')).toBe(fake)
  })
})

describe('guards', () => {
  it('read route decorators from a ResolverContext', () => {
    const resolverContext = (meta: Record<string, unknown>): ResolverContext =>
      ({ route: { meta, coordinate: 'Query.book' } }) as ResolverContext
    const guard = new AccessGuard()
    expect(guard.canResolve(resolverContext({ public: true }))).toBe(true)
    expect(guard.canResolve(resolverContext({ roles: ['editor'] }))).toBe(true)
    expect(guard.canResolve(resolverContext({ roles: ['reader'] }))).toBe(false)
    expect(AccessGuard.enforces.map(decorator => decorator.group)).toEqual(['access', 'access'])
  })
})

describe('scalar()', () => {
  type EmailAddress = string & { readonly __brand: 'EmailAddress' }

  it('returns its definition, typed by T', () => {
    const definition = {
      description: 'An e-mail address',
      serialize: (value: EmailAddress) => value,
      parseValue: (value: unknown) => String(value).toLowerCase() as EmailAddress,
    }
    const email = scalar<EmailAddress>('EmailAddress', definition)
    expect(email).toBe(definition)
    assertType<Equals<ReturnType<typeof email.parseValue>, EmailAddress>>()

    const graphqlScalar = new GraphQLScalarType({ name: 'URL' })
    const url = scalar<URL>('URL', graphqlScalar)
    expect(url as unknown).toBe(graphqlScalar)
  })
})

describe('GraphQLException', () => {
  it('carries a code, extensions and a cause', () => {
    const cause = new RangeError('No book 7')
    const exception = new GraphQLException('Not found', { code: 'NOT_FOUND', extensions: { id: '7' }, cause })
    expect(exception).toBeInstanceOf(Error)
    expect(exception.name).toBe('GraphQLException')
    expect(exception.message).toBe('Not found')
    expect(exception.code).toBe('NOT_FOUND')
    expect(exception.extensions).toEqual({ id: '7' })
    expect(exception.cause).toBe(cause)
    expect(new GraphQLException('x', { code: 'APP_CODE' }).extensions).toBeUndefined()
    expect('cause' in new GraphQLException('x', { code: 'APP_CODE' })).toBe(false)
  })

  it('is what mappers return', () => {
    const mapper = new CatalogErrorMapper()
    const context = { requestId: 'r1' } as GraphQLContext
    expect(mapper.map(new RangeError('gone'), context)?.extensions).toEqual({ requestId: 'r1' })
    expect(mapper.map(new Error('other'), context)).toBeUndefined()
  })
})

describe('PubSub', () => {
  it('is an injectable abstract class typed by its events', async () => {
    class OneShot extends PubSub<CatalogEvents> {
      readonly published: Book[] = []

      publish<K extends keyof CatalogEvents & string>(_topic: K, payload: CatalogEvents[K]): Promise<void> {
        this.published.push(payload)
        return Promise.resolve()
      }

      async *subscribe<K extends keyof CatalogEvents & string>(): AsyncIterableIterator<CatalogEvents[K]> {
        // nothing is ever published to this subscriber
      }
    }
    const pubsub = new OneShot()
    const resolver = new BookResolver(pubsub)
    const book = resolver.book('1', undefined)
    if (book !== null) await pubsub.publish('bookAdded', book)
    expect(pubsub.published).toHaveLength(1)
    expect(pubsub).toBeInstanceOf(PubSub)
  })
})

describe('metadata', () => {
  /** Hand-written metadata, shaped like the generated module of RFC 0005 §7.2. */
  const graphql: GraphQLMetadata = {
    ['version']: 1,
    ['schemaHash']: '0000000000000000',
    ['roots']: { ['query']: 'Query', ['mutation']: 'Mutation' },
    ['types']: [
      {
        ['kind']: 'object',
        ['name']: 'Author',
        ['fields']: [
          { ['name']: 'kind', ['type']: 'String!' },
          { ['name']: 'id', ['type']: 'ID!' },
          { ['name']: 'name', ['type']: 'String!' },
        ],
      },
      {
        ['kind']: 'object',
        ['name']: 'Book',
        ['description']: 'A book.',
        ['fields']: [
          { ['name']: 'id', ['type']: 'ID!' },
          { ['name']: 'year', ['type']: 'Int' },
          { ['name']: 'extra', ['type']: 'JSON!' },
          {
            ['name']: 'author',
            ['type']: 'Author!',
            ['resolver']: {
              ['token']: 'src/book.resolver.ts#BookResolver',
              ['method']: 'author',
              ['operation']: 'field',
              ['guards']: [],
              ['meta']: { ['public']: true },
              ['loaders']: ['src/authors.loader.ts#AuthorsById'],
              ['invoke']: (r: BookResolver, p: unknown, _a: GraphQLArgs, c: GraphQLContext) =>
                r.author(p as never, c.loader('src/authors.loader.ts#AuthorsById') as never),
            },
          },
        ],
      },
      {
        ['kind']: 'scalar',
        ['name']: 'Email',
        ['scalar']: scalar<string>('Email', { serialize: v => v, parseValue: String }),
      },
      { ['kind']: 'scalar', ['name']: 'JSON', ['builtin']: true },
      {
        ['kind']: 'object',
        ['name']: 'Mutation',
        ['fields']: [
          {
            ['name']: 'renameBook',
            ['type']: 'Book!',
            ['args']: [
              { ['name']: 'id', ['type']: 'ID!' },
              { ['name']: 'title', ['type']: 'String!', ['nullAsUndefined']: true },
            ],
            ['resolver']: {
              ['token']: 'src/book.resolver.ts#BookResolver',
              ['method']: 'rename',
              ['operation']: 'mutation',
              ['guards']: ['src/access.guard.ts#AccessGuard'],
              ['meta']: { ['roles']: ['editor'] },
              ['invoke']: (r: BookResolver, _p: unknown, a: GraphQLArgs) => r.rename(a as never),
            },
          },
        ],
      },
      {
        ['kind']: 'object',
        ['name']: 'Query',
        ['fields']: [
          {
            ['name']: 'book',
            ['type']: 'Book',
            ['args']: [{ ['name']: 'id', ['type']: 'ID!' }],
            ['resolver']: {
              ['token']: 'src/book.resolver.ts#BookResolver',
              ['method']: 'book',
              ['operation']: 'query',
              ['guards']: [],
              ['meta']: { ['public']: true },
              ['invoke']: (r: BookResolver, _p: unknown, a: GraphQLArgs, _c: GraphQLContext, i: unknown) =>
                r.book(a['id'] as never, i),
            },
          },
          {
            ['name']: 'search',
            ['type']: '[SearchResult!]!',
            ['args']: [{ ['name']: 'sort', ['type']: 'Sort', ['defaultValue']: 'title' }],
          },
        ],
      },
      {
        ['kind']: 'union',
        ['name']: 'SearchResult',
        ['members']: ['Author', 'Book'],
        ['discriminator']: {
          ['by']: 'property',
          ['property']: 'kind',
          ['values']: { ['author']: 'Author', ['book']: 'Book' },
        },
      },
      {
        ['kind']: 'enum',
        ['name']: 'Sort',
        ['values']: [
          { ['name']: 'title', ['value']: 'title' },
          { ['name']: 'Newest', ['value']: 1, ['deprecationReason']: 'Use title' },
        ],
      },
    ],
    ['groups']: { ['access']: { ['keys']: ['public', 'roles'], ['required']: true } },
  }

  it('augments ZnightExtensionsMetadata', () => {
    const metadata: ZnightMetadata = {
      version: 1,
      providers: {},
      resolutionOrder: [],
      extensions: { ['graphql']: graphql },
    }
    const section = metadata.extensions?.graphql
    assertType<Equals<typeof section, GraphQLMetadata | undefined>>()
    expect(section?.roots.query).toBe('Query')
  })

  it('accepts every discriminator', () => {
    const discriminators: readonly GraphQLMetadata['types'][number][] = [
      { kind: 'union', name: 'A', members: ['Author', 'Book'], discriminator: { by: 'typename' } },
      {
        kind: 'union',
        name: 'B',
        members: ['Author', 'Book'],
        discriminator: {
          by: 'class',
          classes: [
            [BookResolver, 'Book'],
            [AuthorsById, 'Author'],
          ],
        },
      },
    ]
    expect(discriminators).toHaveLength(2)
  })

  it('carries invoke functions the runtime calls with the resolver instance', async () => {
    const query = graphql.types.find(type => type.name === 'Query')
    const field = query?.kind === 'object' ? query.fields[0] : undefined
    const resolver = new BookResolver({} as PubSub<CatalogEvents>)
    const result = field?.resolver?.invoke(resolver, undefined, { id: '1' }, {} as GraphQLContext, {} as never)
    expect(result).toMatchObject({ title: 'Dune' })

    const book = graphql.types.find(type => type.name === 'Book')
    const author = book?.kind === 'object' ? book.fields.find(entry => entry.name === 'author') : undefined
    const loader = { load: async (id: string) => ({ kind: 'author', id, name: 'Frank Herbert' }) }
    const context = { loader: (token: string) => (token.endsWith('#AuthorsById') ? loader : undefined) }
    const invoked = author?.resolver?.invoke(resolver, { authorId: 'a1' }, {}, context as never, {} as never)
    expect(await invoked).toEqual({ kind: 'author', id: 'a1', name: 'Frank Herbert' })
  })

  it('is printable as SDL (the functions are ignored) and hashable', () => {
    const sdl = printSdl(graphql)
    expect(sdl).toContain('union SearchResult = Author | Book')
    expect(sdl).toContain('search(sort: Sort = title): [SearchResult!]!')
    expect(sdl).toContain('  Newest @deprecated(reason: "Use title")')
    expect(sdl).toContain('scalar Email\n')
    expect(schemaHash(sdl)).toHaveLength(16)
  })
})
