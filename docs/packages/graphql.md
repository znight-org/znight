---
description: "@znight/graphql - code-first GraphQL whose schema is derived from TypeScript types at build time, on graphql-js 17: resolvers, loaders, subscriptions over SSE, route decisions and guards."
---

# @znight/graphql <Badge type="tip" text="new in v0.2" />

Code-first GraphQL where **the TypeScript types are the schema**. Resolvers are providers marked
with `@Resolver`, `@Query`, `@Mutation`, `@Subscription` and `@ResolveField`; the compiler follows
every type their signatures reach and derives the schema at build time, with descriptions and
deprecations from JSDoc. `GraphQLPlugin` serves it on graphql-js 17 through `HttpPlugin`.

- **Schema errors at build time.** Unmappable types, name clashes, a type used as input and
  output, a union that cannot be told apart, a loader of the wrong type: each is a `ZNIGHT06x`
  diagnostic with the path from the root field ([`ZNIGHT060`](/reference/error-codes#znight060) to
  [`ZNIGHT066`](/reference/error-codes#znight066)).
- **No duplication.** No `@ObjectType`, no `@Field(() => Int)`, no `reflect-metadata`, no SDL file to
  keep in sync: domain interfaces are exposed as they are, and the SDL is an output you can commit.
- **Fast.** No schema work at boot beyond graphql-js constructors, a document cache, synchronous
  resolvers stay synchronous, guards and null handling only where declared, batching per execution.
- **One pipeline.** The endpoint is an `HttpPlugin` route on every adapter (built-in server,
  Fastify, Express, Hono) and runtime: request scope, hooks, guards, CORS, body limits, drain.
- **One access-control vocabulary.** Route decorators made with `createRouteDecorator` and RFC 0001's
  required groups apply to resolvers; one guard class protects routes and fields.

```sh
npm install @znight/graphql graphql
```

`@znight/http` and `graphql` 17 are required peers. The full reference is the
[package README](../../packages/graphql/README.md); the [GraphQL guide](/guide/graphql) walks
through a complete API, and the [`graphql-api` example](/examples#graphql-api) runs it.

## Quick start

```ts [src/catalog/book.resolver.ts]
import { Args, type ID, type Int, Query, Resolver } from '@znight/graphql'

/** A book of the catalog. */
export interface Book {
  readonly id: ID
  readonly title: string
  /** Year of first publication, `null` when unknown. */
  readonly publishedYear: Int | null
}

@Resolver()
export class BookResolver {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * One book.
   * @param id The id of the book.
   */
  @Query()
  book(@Args('id') id: ID): Promise<Book | null> {
    return this.catalog.find(id)
  }
}
```

```ts [src/main.ts]
import { Application } from '@znight/core'
import { GraphQLPlugin } from '@znight/graphql'
import { HttpPlugin } from '@znight/http'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000 }), GraphQLPlugin.configure()],
})
await app.start() // POST /graphql, GET /graphql (queries; GraphiQL in development), SSE subscriptions
```

The compiler extension (`@znight/graphql/compiler`) is discovered from the package manifest: there
is nothing to configure.

```graphql
"""
A book of the catalog.
"""
type Book {
  id: ID!
  title: String!

  """
  Year of first publication, `null` when unknown.
  """
  publishedYear: Int
}

type Query {
  """
  One book.
  """
  book(
    """
    The id of the book.
    """
    id: ID!
  ): Book
}
```

## How types map

| TypeScript                                                       | GraphQL                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `string`, `boolean`, `number`                                    | `String`, `Boolean`, `Float` (`Int` with `number: 'Int'`)   |
| `ID`, `Int`, `Float`, `JSONValue` (aliases of `@znight/graphql`) | `ID`, `Int`, `Float`, `JSON`                                |
| `Date`, `bigint`                                                 | `DateTime` (RFC 3339), `BigInt` (decimal string)            |
| `scalar<T>(name, definition)`                                    | a custom scalar `name` wherever `T` appears                 |
| `enum`, named union of string literals                           | enum                                                        |
| class, interface, named object alias                             | object type (output) or input type (input), never both      |
| `Page<Book>`                                                     | `BookPage` (or the name of an alias)                        |
| named union of object types                                      | union, told apart by class, `__typename` or a literal field |
| arrays (`Set` and `Iterable` in output)                          | lists                                                       |
| `T \| null`, `T \| undefined`, `?`                               | nullable `T`; everything else is non-null                   |

JSDoc gives descriptions, `@param` argument descriptions, `@deprecated`, `@default`, and two
escape hatches: `@gqlHidden` (leave a property out) and `@gqlName` (rename a type). Anything else is
[`ZNIGHT060`](/reference/error-codes#znight060) with a hint.

## Resolvers, arguments and loaders

```ts
@Resolver()
export class BookResolver {
  constructor(
    private readonly catalog: CatalogService,
    private readonly events: PubSub<CatalogEvents>,
  ) {}

  /** Books of the catalog, filtered and paginated. */
  @Query()
  books(@Args() filter: BookFilter): Promise<Page<Book>> {
    return this.catalog.list(filter) // each property of BookFilter is an argument
  }

  /** Adds a book to the catalog. */
  @Mutation()
  async addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<Book> {
    const book = await this.catalog.add(input) // validated with the Standard Schema NewBookInput
    await this.events.publish('bookAdded', book)
    return book
  }

  /** Who wrote the book: one batch per execution. */
  @ResolveField()
  author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
  }
}
```

- `@Args()` spreads an args type into arguments, `@Args('name')` declares one, and a Standard
  Schema (`@Args('input', Schema)`) validates and transforms the value (`BAD_USER_INPUT` with the
  issues). `@default` tags and literal parameter defaults are schema defaults.
- A client `null` reaches an argument whose type does not accept `null` as `undefined`.
- A loader is a provider implementing `BatchLoad<K, V>`; `@Loader()` injects the DataLoader of the
  current execution, renewed per operation and per subscription event. `orderByKeys()` reorders
  rows and fails missing keys with `NOT_FOUND`.

## Subscriptions

`@Subscription` methods return an async iterable, usually from the injectable `PubSub<Events>`
(in memory by default, bounded per subscriber). Clients subscribe with GraphQL over SSE:

```ts
@Subscription()
async *bookAdded(@Args('genre') genre: Genre | undefined, @Ctx() ctx: GraphQLContext): AsyncGenerator<Book> {
  for await (const book of this.events.subscribe('bookAdded', { signal: ctx.signal })) {
    if (genre === undefined || book.genre === genre) yield book
  }
}
```

```sh
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"query":"subscription { bookAdded { title } }"}' http://localhost:3000/graphql
```

A client that leaves aborts `ctx.signal`; on shutdown the stream ends without `complete` so clients
reconnect elsewhere; `subscriptions.maxActive` caps the number of streams (503 beyond).

## Access control

```ts
GraphQLPlugin.configure({
  guards: [AccessGuard], // implements GraphQLGuard: canResolve(ctx: ResolverContext)
  http: { meta: [Public.meta()] }, // the endpoint is open; decisions are taken per field
})
```

Route decorators (`@Public()`, `@Roles([...])`) on a resolver class or method are field decisions;
a required group must be decided on every root field (build-time
[`ZNIGHT023`](/reference/error-codes#znight023)) and enforced by a guard (boot check). Global guards
run on root fields and on field resolvers carrying metadata; `@UseGuard` adds class and method
guards. `false` is a `FORBIDDEN` error on that field. See the [guide](/guide/graphql#authorization).

## Plugin options

| Option          | Default                                                                | What                                                                            |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `path`          | `'/graphql'`                                                           | Endpoint path, under the `HttpPlugin` prefix                                    |
| `http`          | `{}`                                                                   | `false` (no transport) or `{ meta?, guards?, bodyLimit = '100kb', get = true }` |
| `guards`        | `[]`                                                                   | Global GraphQL guards                                                           |
| `errorMappers`  | `[]`                                                                   | `GraphQLErrorMapper`s, tried in order                                           |
| `exposeErrors`  | `false`                                                                | Unmasked messages for unexpected errors                                         |
| `introspection` | `NODE_ENV !== 'production'`                                            | Off: introspection rejected and suggestions hidden                              |
| `graphiql`      | `NODE_ENV === 'development'`                                           | GraphiQL on `GET path` with `accept: text/html`                                 |
| `limits`        | `{ maxTokens: 2000, maxDepth: 12, maxAliases: 30, maxDirectives: 50 }` | Request limits, `false` disables one                                            |
| `documentCache` | `1000`                                                                 | Parsed and validated documents kept (LRU)                                       |
| `subscriptions` | `{ maxActive: 10_000, bufferSize: 100 }`                               | `false`, or caps, buffer, `heartbeat`, `maxDuration`                            |
| `pubsub`        | a `MemoryPubSub`                                                       | The `PubSub` of the application                                                 |
| `enforcement`   | `'error'`                                                              | Field decisions not enforced by a guard: fail the boot or `'warn'`              |

The instance exposes `schema`, `printSchema()`, `execute(request)`, `subscribe(request)`, `pubsub`
and `activeSubscriptions`, for custom transports and controllers calling GraphQL.

## Errors

A thrown `GraphQLException(message, { code, extensions })` is sent as is; other errors go through
the `errorMappers`, then `HttpException`s are mapped by status (`UNAUTHENTICATED`, `FORBIDDEN`,
`NOT_FOUND`...), and anything else is masked as `Unexpected error.` (`INTERNAL_SERVER_ERROR`) and
logged once with the request id and the field. Request errors carry `GRAPHQL_PARSE_FAILED`,
`GRAPHQL_VALIDATION_FAILED`, `BAD_USER_INPUT` or `QUERY_TOO_COMPLEX`.

## Testing

```ts
import { executeOperation, fakeLoader, subscribeOperation } from '@znight/graphql/testing'

const res = await executeOperation(app, { query: '{ books { total } }' }) // through app.inject()
expect(res.status).toBe(200)
expect(res.errors).toBeUndefined()

await using events = await subscribeOperation(app, { query: 'subscription { bookAdded { title } }' })

const authors = fakeLoader<AuthorsById>({ a1: herbert }) // for TestBed unit tests of resolvers
```

`TestApp` boots the resolvers with their guards and loaders. See
[Test GraphQL code](/guide/graphql#testing).

## The SDL artifact

```ts [znight.config.ts]
import graphql from '@znight/graphql/compiler'
import type { ZnightOptions } from '@znight/compiler'

export default {
  extensions: [graphql.configure({ sdl: 'schema.graphql' })],
} satisfies ZnightOptions
```

The compiler writes `schema.graphql` with the generated module, byte-identical to graphql-js
`printSchema()`, and `znight generate --check` fails when it is stale. Commit it to review schema
changes in pull requests. The other option, `number: 'Int'`, maps `number` to `Int`.

## Limitations

No GraphQL interfaces (use unions), no `graphql-ws` subscriptions, `@defer` / `@stream`, trusted
documents, cost analysis or federation in this version: they are follow-ups on the
[roadmap](/roadmap#considered).

## Diagnostics

| Code                                            | When                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`ZNIGHT060`](/reference/error-codes#znight060) | A TypeScript type without GraphQL mapping, a resolver without return type                      |
| [`ZNIGHT061`](/reference/error-codes#znight061) | Name conflicts, reserved or invalid names, a field resolver changing a property's type         |
| [`ZNIGHT062`](/reference/error-codes#znight062) | Resolver structure: no `@Parent()`, a subscription without async iterable, no `@Query`...      |
| [`ZNIGHT063`](/reference/error-codes#znight063) | Input position: a type used as input and output, getters or unions in inputs, invalid defaults |
| [`ZNIGHT064`](/reference/error-codes#znight064) | Union members that cannot be told apart at runtime                                             |
| [`ZNIGHT065`](/reference/error-codes#znight065) | Loaders: not `Loader<L>`, not a `BatchLoad`, a batch returning the wrong number of values      |
| [`ZNIGHT066`](/reference/error-codes#znight066) | Boot: invalid metadata, schema or options, `HttpPlugin` missing                                |

Shared codes also apply: [`ZNIGHT001`](/reference/error-codes#znight001) (a dependency, guard or
loader without provider), [`ZNIGHT005`](/reference/error-codes#znight005) (decorator usage),
[`ZNIGHT023`](/reference/error-codes#znight023) (field decisions).
