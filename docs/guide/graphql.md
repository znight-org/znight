---
description: Build a GraphQL API with Znight - types as the schema, resolvers, validated arguments, loaders against N+1 queries, subscriptions over SSE, access control, errors, tests and production settings.
---

# GraphQL

`@znight/graphql` serves a GraphQL API whose schema is **derived from your TypeScript types at build
time**. This guide builds a small book catalog step by step. When the `.graphql` files are your
contract, the [schema-first mode](#schema-first) checks resolvers against them instead. The [package page](/packages/graphql)
summarises the API, and the [package README](../../packages/graphql/README.md) is the complete
reference.

::: info The graphql-api example
The catalog of this guide is a complete application:
[`examples/graphql-api`](https://github.com/znight-org/znight/tree/main/examples/graphql-api), running
on Node.js 24 and Bun (Hono). Its [resolvers](../../examples/graphql-api/src/catalog/book.resolver.ts),
[loaders](../../examples/graphql-api/src/catalog/authors-by-id.loader.ts),
[access guard](../../examples/graphql-api/src/auth/access.guard.ts) and committed
[`schema.graphql`](../../examples/graphql-api/schema.graphql) are the full versions of the snippets
below, and its tests cover each section: batching, the access matrix of every root field,
subscriptions, GraphQL over HTTP and the build-time diagnostics.
:::

## Set up {#setup}

```sh
npm install @znight/core @znight/http @znight/graphql graphql
npm install -D @znight/compiler vite
```

`GraphQLPlugin` serves its endpoint through `HttpPlugin`, so both are registered:

```ts [src/main.ts]
import { Application } from '@znight/core'
import { GraphQLPlugin } from '@znight/graphql'
import { HttpPlugin } from '@znight/http'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000 }), GraphQLPlugin.configure()],
})
await app.start()
```

The compiler extension is discovered from the package: as soon as a file imports
`@znight/graphql`, `znight dev`, `znight build`, the Vite plugin and the Bun preload derive the
schema. With `NODE_ENV=development`, `http://localhost:3000/graphql` opens GraphiQL in a browser.

## Describe the data {#types}

Write the types you would write anyway. They are the schema:

```ts [src/catalog/book.ts]
import type { ID, Int } from '@znight/graphql'

/** A book of the catalog. */
export interface Book {
  readonly kind: 'book'
  readonly id: ID
  readonly title: string
  /** Year of first publication, `null` when unknown. */
  readonly publishedYear: Int | null
  readonly genre: Genre
  readonly tags: readonly string[]
  readonly createdAt: Date
  /** @deprecated Use `tags`. */
  readonly category?: string
  /** @gqlHidden Exposed as `author` by BookResolver. */
  readonly authorId: ID
}

/** Literary genres. */
export enum Genre {
  Fantasy = 'fantasy',
  ScienceFiction = 'science-fiction',
  Mystery = 'mystery',
}

export interface Author {
  readonly kind: 'author'
  readonly id: ID
  readonly name: string
}

/** A page of results. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly total: Int
  readonly hasMore: boolean
}

/** Sort orders of the book list. */
export type BookSort = 'title' | 'newest'

/** A search hit: told apart at runtime by `kind`. */
export type SearchResult = Book | Author
```

A few rules cover most of it:

- **Nullability comes from the type.** `T` is `T!`; `T | null`, `T | undefined` and `?` are nullable.
  `readonly string[]` is `[String!]!`.
- **Numbers are `Float`** unless typed `Int` (or `ID`): `ID`, `Int`, `Float` and `JSONValue` are
  plain aliases exported by `@znight/graphql`, so values need no cast. Set the compiler option
  `number: 'Int'` if most of your numbers are counts.
- **`Date` is `DateTime`**, `bigint` is `BigInt`. Other types with a wire format of their own are
  [custom scalars](#scalars).
- **Enums**: a TypeScript `enum` (the member names are the GraphQL values, resolvers see the member
  values) or a named union of string literals (`BookSort`).
- **Generics** are named after their arguments: `Page<Book>` is `BookPage`. An alias names it
  otherwise: `export type BookList = Page<Book>`.
- **Unions** are named aliases of object types. The compiler finds how to tell the members apart: a
  literal property with a different value in each (`kind` here), `__typename`, or `instanceof`
  when the members are exported classes.
- **JSDoc** becomes descriptions and deprecations; `@gqlHidden` leaves a property out, `@gqlName`
  renames a type.

What GraphQL cannot express fails the build, at the property, with the path from the query that
reaches it:

```txt
✗ ZNIGHT060: Cannot map binary data to a GraphQL type (Book.cover)
  --> src/catalog/book.ts:14:19
   |
14 |   readonly cover: Uint8Array | null
   |                   ^^^^^^^^^^^^^^^^^
   |
  ::: src/catalog/book.resolver.ts:13:3
   |
13 |   book(@Args('id') id: ID): Promise<Book | null> {
   |   ---- reached from Query.book → Book
   = hint: Expose a URL (coverUrl: string), hide the property with /** @gqlHidden */, or declare a scalar: export const Base64 = scalar<Uint8Array>('Base64', { ... })
```

## Write resolvers {#resolvers}

A resolver is a provider: constructor injection, scopes and AOP work as everywhere else.

```ts [src/catalog/book.resolver.ts]
import { Args, type ID, Query, Resolver } from '@znight/graphql'

import type { BookFilter } from './book.args.js'
import type { Book, Page, SearchResult } from './book.js'
import { CatalogService } from './catalog.service.js'

@Resolver()
export class BookResolver {
  constructor(private readonly catalog: CatalogService) {}

  /** Books of the catalog, filtered and paginated. */
  @Query()
  books(@Args() filter: BookFilter): Promise<Page<Book>> {
    return this.catalog.list(filter)
  }

  /**
   * One book.
   * @param id The id of the book.
   */
  @Query()
  book(@Args('id') id: ID): Promise<Book | null> {
    return this.catalog.find(id)
  }

  /** Books whose title, and authors whose name, contain the text. */
  @Query()
  search(@Args('text') text: string): Promise<readonly SearchResult[]> {
    return this.catalog.search(text)
  }
}
```

Annotate every return type: the compiler reads annotations, it does not infer. Keep resolvers thin:
they map GraphQL to your services, which stay reusable from controllers, consumers and jobs. A
synchronous method stays synchronous all the way: return a `Promise` only when there is I/O.

## Arguments and validation {#arguments}

```ts [src/catalog/book.args.ts]
import type { Int } from '@znight/graphql'

import type { BookSort, Genre } from './book.js'

/** Criteria of `Query.books`: each property becomes an argument. */
export interface BookFilter {
  /** Case-insensitive search in titles. */
  readonly search?: string
  readonly genre?: Genre
  /** @default "title" */
  readonly sort?: BookSort
  /** @default 20 */
  readonly limit?: Int
}
```

`@Args() filter: BookFilter` gives `books(search: String, genre: Genre, sort: BookSort = title,
limit: Int = 20)`. When the client sends `null` for `limit`, the resolver receives `undefined`: the
type of `limit` does not accept `null`, so values always match their declared type.

Inputs that need more than GraphQL's type checks get a [Standard Schema](https://standardschema.dev)
of the same name:

```ts [src/catalog/book.inputs.ts]
import type { Int, StandardSchemaV1 } from '@znight/graphql'
import { z } from 'zod'

import { Genre } from './book.js'

/** A new book. The interface is the GraphQL input type, the schema of the same name validates it. */
export interface NewBookInput {
  readonly title: string
  readonly isbn: string
  readonly authorId: string
  readonly genre: Genre
  readonly publishedYear?: Int | null | undefined
}

export const NewBookInput: StandardSchemaV1<unknown, NewBookInput> = z.object({
  title: z.string().trim().min(1, 'A title is required'),
  isbn: z.string().regex(/^\d{13}$/, 'An ISBN has 13 digits'),
  authorId: z.string(),
  genre: z.enum(Genre),
  publishedYear: z.number().int().max(2100, 'Not published yet').nullish(),
})
```

```ts
@Mutation()
async addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<Book> {
  return this.catalog.add(input) // the schema output: trimmed title, checked ISBN
}
```

The interface is the GraphQL type and the schema validates the value after GraphQL coerced it. A
rejected value is a `BAD_USER_INPUT` error whose `extensions.issues` lists `{ path, message }`. A
schema that validates synchronously (Zod, Valibot) adds no promise to the call.

A declaration is either an output or an input type. When the same shape is both, extend it:
`export interface MoneyInput extends Money {}` ([`ZNIGHT063`](/reference/error-codes#znight063)
shows the fix).

## Batch with loaders {#loaders}

A field resolver that loads something per parent is the classic N+1 trap: twenty books, twenty
author queries. A loader batches the keys requested during one execution:

```ts [src/catalog/authors-by-id.loader.ts]
import { Injectable } from '@znight/core'
import { type BatchLoad, type ID, orderByKeys } from '@znight/graphql'

import { AuthorRepository } from './author.repository.js'
import type { Author } from './book.js'

@Injectable()
export class AuthorsById implements BatchLoad<ID, Author> {
  constructor(private readonly authors: AuthorRepository) {}

  async load(ids: readonly ID[]): Promise<readonly (Author | Error)[]> {
    return orderByKeys(ids, await this.authors.findMany(ids), author => author.id)
  }
}
```

```ts
/** Who wrote the book: one repository call per execution, whatever the number of books. */
@ResolveField()
author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
  return authors.load(book.authorId)
}
```

- `@ResolveField()` adds `author` to `Book` (the type of the `@Parent()` parameter). The hidden
  `authorId` stays out of the schema.
- `@Loader()` injects the DataLoader of the **current execution**: a fresh cache per operation and
  per subscription event, so values never leak between requests or go stale between events.
- `load(keys)` returns one value per key, in order: `orderByKeys()` does it and turns a missing key
  into a `NOT_FOUND` error for that key only. A wrong number of values fails the whole batch with
  [`ZNIGHT065`](/reference/error-codes#znight065).
- Loaders may be request-scoped (a per-tenant repository) even when the resolver is a singleton:
  they are resolved per execution, in the current scope.

## Stream with subscriptions {#subscriptions}

Subscriptions use Server-Sent Events: plain HTTP through the same route, adapters and proxies, no
WebSocket server. Publish events through the injectable `PubSub`:

```ts [src/catalog/catalog.events.ts]
import type { Book } from './book.js'

/** Topics of the application PubSub and their payloads. */
export interface CatalogEvents {
  bookAdded: Book
}
```

```ts
@Resolver()
export class BookResolver {
  constructor(
    private readonly catalog: CatalogService,
    private readonly events: PubSub<CatalogEvents>,
  ) {}

  @Mutation()
  async addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<Book> {
    const book = await this.catalog.add(input)
    await this.events.publish('bookAdded', book)
    return book
  }

  /** Books added from now on, optionally of one genre. */
  @Subscription()
  async *bookAdded(@Args('genre') genre: Genre | undefined, @Ctx() ctx: GraphQLContext): AsyncGenerator<Book> {
    for await (const book of this.events.subscribe('bookAdded', { signal: ctx.signal })) {
      if (genre === undefined || book.genre === genre) yield book
    }
  }
}
```

```sh
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"query":"subscription { bookAdded(genre: Fantasy) { title } }"}' http://localhost:3000/graphql
```

- Always pass `ctx.signal` to `subscribe()`: it aborts when the client leaves, when the application
  shuts down and after `subscriptions.maxDuration`.
- The generator starts with the subscription: it has subscribed to the PubSub by the time the client
  is connected, so an event published right after reaches it, provided it calls `subscribe()` before
  its first `await` (subscribe first, then await anything else).
- The default `MemoryPubSub` buffers 100 events per subscriber (`subscriptions.bufferSize`). A
  subscriber that falls behind ends with a `SUBSCRIPTION_OVERFLOW` error instead of growing memory.
- With several instances, events published on one must reach subscribers on all: give the `pubsub`
  option an implementation backed by Redis or your broker (`publish(topic, payload)`,
  `subscribe(topic, { signal })`).
- On shutdown, streams end **without** the `complete` event, which GraphQL-over-SSE clients treat
  as a lost connection: they reconnect to another instance.

## Protect fields {#authorization}

Access decisions are the route decorators of `@znight/http`, shared with controllers. With a
**required** group, a root field without a decision fails the build:

```ts [src/auth/access.ts]
import { createRouteDecorator } from '@znight/http'

export type Role = 'reader' | 'editor'

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
```

```ts
@Resolver()
@Public() // the default decision of every field of the class
export class BookResolver {
  @Mutation()
  @Roles(['editor']) // replaces the class decision
  async addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<Book> {
    // ...
  }
}
```

```txt
✗ ZNIGHT023: Root field Mutation.deleteBook (BookResolver.deleteBook) has no "access" decision
  --> src/catalog/book.resolver.ts:18:3
   = hint: Add @Public(), @Authenticated() or @Roles(...) to the method or to BookResolver
```

A guard enforces the decisions. One class can serve HTTP routes (`canActivate`) and GraphQL fields
(`canResolve`), since `ResolverContext` is a `RouteMetaCarrier`:

```ts [src/auth/access.guard.ts]
import { Injectable, type Lazy } from '@znight/core'
import type { GraphQLGuard, ResolverContext } from '@znight/graphql'
import type { CanActivate, HttpContext, RouteMetaCarrier } from '@znight/http'

import { Authenticated, Public, Roles } from './access.js'
import type { CurrentUser } from './current-user.js'

@Injectable()
export class AccessGuard implements CanActivate, GraphQLGuard {
  static readonly enforces = [Public, Authenticated, Roles]

  constructor(private readonly user: Lazy<CurrentUser>) {}

  canActivate(ctx: HttpContext): boolean {
    return this.#decide(ctx)
  }

  canResolve(ctx: ResolverContext): boolean {
    return this.#decide(ctx)
  }

  #decide(ctx: RouteMetaCarrier): boolean {
    if (Public.get(ctx)) return true
    const principal = this.user.get().principal // throws UnauthorizedException: UNAUTHENTICATED
    const roles = Roles.get(ctx)
    if (roles !== undefined) return roles.some(role => principal.roles.includes(role))
    return Authenticated.get(ctx) === true
  }
}
```

```ts [src/main.ts]
HttpPlugin.configure({ port: 3000, guards: [AuthenticationGuard, AccessGuard] })
GraphQLPlugin.configure({
  guards: [AccessGuard],
  http: { meta: [Public.meta()] }, // the endpoint is open: decisions are taken per field
})
```

- `AuthenticationGuard` (an HTTP guard, see the [Security guide](/guide/security)) identifies the
  caller once per request and fills the request-scoped `CurrentUser`; `AccessGuard` decides per
  field.
- Global GraphQL guards run on root fields, and on field resolvers that carry their own decorator.
  A field resolver without one is covered by the root field it descends from: authorization
  happens at entry points, and plain properties never run guards.
- `@UseGuard(Guard)` on a class or method adds guards after the global ones.
- A guard returning `false` gives `FORBIDDEN` on that field only; other fields of the response
  still resolve. Guards run once per call (once per item of a list), so keep them cheap.
- Subscription guards run once, when the subscription starts.

## Report errors {#errors}

Throw a `GraphQLException` for an error the client should see, with a code clients can switch on:

```ts
import { GraphQLException } from '@znight/graphql'

throw new GraphQLException(`No book ${id}`, { code: 'NOT_FOUND', extensions: { bookId: id } })
```

Domain errors are converted in one place with an error mapper:

```ts [src/shared/catalog-error.mapper.ts]
import { Injectable } from '@znight/core'
import { GraphQLException, type GraphQLErrorMapper } from '@znight/graphql'

import { BookNotFoundError, DuplicateIsbnError } from '../catalog/errors.js'

@Injectable()
export class CatalogErrorMapper implements GraphQLErrorMapper {
  map(error: unknown): GraphQLException | undefined {
    if (error instanceof BookNotFoundError) return new GraphQLException(error.message, { code: 'NOT_FOUND' })
    if (error instanceof DuplicateIsbnError) return new GraphQLException(error.message, { code: 'CONFLICT' })
    return undefined
  }
}
```

```ts
GraphQLPlugin.configure({ errorMappers: [CatalogErrorMapper] })
```

`HttpException`s of `@znight/http` are mapped by status (`UNAUTHENTICATED`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`...). Everything else is masked as `Unexpected error.` and logged once with
the request id, the field (`Query.book`) and the cause: stack traces and SQL never reach clients.
Set `exposeErrors: true` in development to see the real messages.

## Test GraphQL code {#testing}

Unit-test a resolver like any provider, with `TestBed` and a fake loader:

```ts [test/book.resolver.test.ts]
import { expect, test } from 'bun:test'
import { fakeLoader } from '@znight/graphql/testing'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import type { AuthorsById } from '../src/catalog/authors-by-id.loader.js'
import { BookResolver } from '../src/catalog/book.resolver.js'
import { CatalogService } from '../src/catalog/catalog.service.js'
import { dune, herbert } from './support/fixtures.js'

test('book() returns the book of the service', async () => {
  const { instance, mocks } = await TestBed.create(BookResolver, { metadata })
  mocks.get(CatalogService).find.mockResolvedValue(dune)
  expect(await instance.book(dune.id)).toBe(dune)
})

test('author() goes through the loader', async () => {
  const { instance } = await TestBed.create(BookResolver, { metadata })
  const authors = fakeLoader<AuthorsById>({ [herbert.id]: herbert })
  expect(await instance.author(dune, authors)).toBe(herbert)
  expect(authors.load).toHaveBeenCalledWith(herbert.id)
})
```

Run operations through the whole stack, guards and loaders included, with `TestApp`:

```ts [test/books.graphql.test.ts]
import { expect, spyOn, test } from 'bun:test'
import { GraphQLPlugin } from '@znight/graphql'
import { executeOperation, subscribeOperation } from '@znight/graphql/testing'
import { HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'

import { __ZNIGHT_METADATA__ } from '../src/.znight/container.generated.js'
import { AuthorRepository } from '../src/catalog/author.repository.js'

const BOOKS = `query Books($genre: Genre) { books(genre: $genre, limit: 2) { total items { title author { name } } } }`
const ADD_DUNE = `mutation { addBook(input: { title: "Dune", isbn: "9780441013593", authorId: "a1", genre: ScienceFiction }) { id } }`

function createTestApp(): Promise<TestApp> {
  return TestApp.create({
    metadata: __ZNIGHT_METADATA__,
    plugins: [HttpPlugin.configure({ port: 0 }), GraphQLPlugin.configure()],
  })
}

test('lists books with their authors in a single batch', async () => {
  await using app = await createTestApp()
  const findMany = spyOn(app.get(AuthorRepository), 'findMany')
  const res = await executeOperation(app, { query: BOOKS, variables: { genre: 'Fantasy' } }) // enum names
  expect(res.status).toBe(200)
  expect(res.errors).toBeUndefined()
  expect(findMany).toHaveBeenCalledTimes(1) // no N+1
})

test('bookAdded streams new books', async () => {
  await using app = await createTestApp()
  await using events = await subscribeOperation(app, { query: 'subscription { bookAdded { title } }' })
  await executeOperation(app, { query: ADD_DUNE })
  expect((await events.next()).value).toEqual({ data: { bookAdded: { title: 'Dune' } } })
})
```

`executeOperation()` sends a `POST` through `app.inject()`: HTTP guards, hooks and the adapter run
as in production, and the response carries `status`, `headers`, `data` and `errors`.
`subscribeOperation()` streams over SSE in memory and resolves once the subscription is
established (the resolver's generator has subscribed, when it subscribes before its first `await`),
so the mutation can publish right away; its
`next()` times out after 2 s, so a missing event fails the test instead of hanging it.

## Review the schema in pull requests {#sdl}

```ts [znight.config.ts]
import graphql from '@znight/graphql/compiler'
import type { ZnightOptions } from '@znight/compiler'

export default {
  extensions: [graphql.configure({ sdl: 'schema.graphql' })],
} satisfies ZnightOptions
```

The compiler writes `schema.graphql` next to the generated module, exactly as graphql-js would
print it. Commit it: a change to a TypeScript type now shows as a schema diff in the pull request,
and `znight generate --check` in CI fails when the committed file is stale. Client code generators
(GraphQL Code Generator, gql.tada) can read it without starting the server.

The committed file is compared byte for byte with the compiler's output, so keep formatters away
from it. With Biome, exclude it in `biome.jsonc` (the repository does so for `examples/graphql-api`):

```jsonc [biome.jsonc]
{
  "files": {
    "includes": ["**", "!schema.graphql"]
  }
}
```

## Go to production {#production}

The defaults are production-safe, keyed on `NODE_ENV`:

| Concern       | Default                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Introspection | Off in production, with suggestions hidden; `introspection: true` to keep it                            |
| GraphiQL      | Only with `NODE_ENV=development`                                                                        |
| Errors        | Masked (`Unexpected error.`), logged with the request id                                                |
| Abuse         | 2 000 tokens, depth 12, 30 aliases, 50 directives per document; 100 KiB bodies; no batching             |
| CSRF          | JSON-only `POST`, queries only over `GET`: cross-site requests are always preflighted                   |
| Streams       | 10 000 active subscriptions at most (503 beyond), bounded buffers, heartbeats from the `HttpPlugin` SSE |

Raise `limits` only for the operations that need it, and prefer pagination arguments (`limit`,
`offset` or cursors) to large lists. The document cache (1 000 distinct documents) means a client
sending the same queries pays parsing and validation once.

The `graphql:operation` hook observes every operation (type, name, outcome, error codes), for logs
and metrics of your own. [`@znight/observability`](/packages/observability#graphql-operations)
wraps it: a span per operation under the HTTP request span, `graphql_operations_total` and
`graphql_operation_duration_seconds` by type and (capped) operation name, and opt-in operation logs
(`logging: { graphql: true }`).

## Schema-first {#schema-first}

Code-first suits a schema owned by the server. When the `.graphql` files are the contract, shared
with clients and with [GraphQL Code Generator](https://the-guild.dev/graphql/codegen), switch the
compiler extension to schema-first: the SDL becomes the schema, resolvers are bound to its fields
by name, and the compiler checks at build time that every field is resolved and that every
resolver signature conforms to the SDL ([RFC 0007](../../rfcs/0007-graphql-schema-first.md)).

```ts [znight.config.ts]
import graphql from '@znight/graphql/compiler'
import type { ZnightOptions } from '@znight/compiler'

export default {
  extensions: [graphql.configure({ schema: 'src/**/*.graphql' })],
} satisfies ZnightOptions
```

The globs are relative to the project root; the files are inputs of the compile, so `znight dev`
rebuilds when one changes or appears. The two modes do not mix: with `schema`, TypeScript types
only get checked. The runtime is the same, and so are the generated metadata, `schemaHash` and the
`sdl` artifact (the served schema, without custom directives).

```graphql [src/catalog/catalog.graphql]
type Book {
  id: ID!
  title: String!
  author: Author!
}

extend type Query {
  books(limit: Int = 10): [Book!]!
}
```

```ts [src/catalog/book.resolver.ts]
import { Args, Loader, Parent, Query, ResolveField, Resolver } from '@znight/graphql'

import { AuthorsById } from './authors-by-id.loader.ts'
import { CatalogService } from './catalog.service.ts'
import type { Author, Book, QueryBooksArgs } from './graphql.generated.ts'

@Resolver('Book')
export class BookResolver {
  constructor(private readonly catalog: CatalogService) {}

  @Query()
  books(@Args('limit') limit: QueryBooksArgs['limit']): Promise<Book[]> {
    return this.catalog.list(limit ?? 10)
  }

  @ResolveField()
  author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
  }
}
```

- Root fields are bound by method name, or by the name given to `@Query('name')`, `@Mutation()` or
  `@Subscription()`. Fields of other types need the type name: `@Resolver('Book')` +
  `@ResolveField()` (the method name, or `@ResolveField('name')`); `@Parent()` is optional.
- `@Args('name')` receives one argument, `@Args()` all of them; `@Args('input', Schema)` validates
  with a Standard Schema, as in code-first. Guards, route decorators, loaders and subscriptions
  work the same way.
- Descriptions, deprecations and default values come from the SDL. `extend type`, enums, unions,
  **interfaces**, input objects and `@specifiedBy` are supported. Enum values are their SDL names
  on both sides. Union members and interface implementations are told apart by `__typename`, or
  by `instanceof` when the resolvers return exported classes.
- Every custom scalar is declared once in TypeScript with `scalar<T>('Name', definition)`, `T` being
  the type of its values; `DateTime`, `BigInt` and `JSON` are built in. A custom directive is
  ignored with a warning.

**What the compiler checks.** A root field without resolver, a resolver for a field the SDL does not
declare, an unknown argument, `@Resolver('Bok')`, or an object field that neither a resolver nor the
returned TypeScript type provides: each is a [ZNIGHT068](/reference/error-codes#znight068) with a
suggestion. Then the types: a resolver returning `Book | null` for `Book!`, a `string` for an
`Int`, a value outside an enum, an argument typed `string` for a nullable `String` (it may be
omitted), a union member the SDL does not list: one ZNIGHT068 per mismatch, on the TypeScript
annotation, with the SDL definition next to it. SDL errors are
[ZNIGHT067](/reference/error-codes#znight067), located in the `.graphql` file. `any`, `unknown` and
missing annotations are not checked.

**TypeScript types from the SDL.** Generate them with GraphQL Code Generator's `typescript` plugin,
mapping the custom scalars to the types of their `scalar<T>()` declarations; its output passes the
checks as is (`Scalars['X']['output']`, `Maybe<T>`, the `QueryXxxArgs` types, `__typename` on every
object type):

```ts [codegen.ts]
import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: 'src/**/*.graphql',
  generates: {
    'src/graphql.generated.ts': {
      plugins: ['typescript'],
      config: {
        scalars: { DateTime: 'Date', EventId: './events/event-id.ts#EventId' },
        namingConvention: { enumValues: 'keep' },
        useTypeImports: true,
      },
    },
  },
}

export default config
```

`typescript-resolvers` adds its `Resolvers` types: not needed, the decorated methods are checked
directly. Models that leave out the fields a field resolver computes (`authorId` instead of
`author`) work too: only the fields without resolver must be properties of the returned type.

## Coming from `@nestjs/graphql` {#nestjs}

Schema-first NestJS applications (`typePaths`) move with the [schema-first mode](#schema-first):
the same `.graphql` files, the same decorators bound by name (`@Resolver('Book')`,
`@ResolveField()`, `@Args('id')`), `@Context()` becoming `@Ctx()`. The table below maps code-first
NestJS.

| NestJS (code first)                                  | Znight                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `@ObjectType()`, `@Field(() => Int)`, `@InputType()` | Plain interfaces and classes; `Int`, `ID` aliases                  |
| `GraphQLModule.forRoot({ driver, autoSchemaFile })`  | `GraphQLPlugin.configure()`; `graphql.configure({ sdl })` at build |
| `@Resolver(() => Book)` + `@ResolveField()`          | `@Resolver()` + `@ResolveField()` with a `@Parent()` parameter     |
| `@Args('id', { type: () => ID })`                    | `@Args('id') id: ID`                                               |
| `class-validator` on input classes, `ValidationPipe` | A Standard Schema: `@Args('input', NewBookInput)`                  |
| `registerEnumType`, `createUnionType`                | A TypeScript `enum` or literal union; a named union alias          |
| `dataloader` wiring per request in the context       | A `BatchLoad` provider and `@Loader()`                             |
| `graphql-subscriptions` `PubSub`, `graphql-ws`       | The injectable `PubSub`, subscriptions over SSE                    |
| `@UseGuards()` with `GqlExecutionContext`            | `GraphQLGuard.canResolve(ctx: ResolverContext)`, route decorators  |
| Schema errors at boot or at the first request        | Schema errors at build time (`ZNIGHT060`–`ZNIGHT068`)              |

## Limits {#limits}

- Code-first maps no TypeScript type to a GraphQL interface: use unions, or the schema-first mode,
  which supports interfaces.
- Schema-first: no custom directives with behaviour, no `@oneOf` inputs, no `__resolveType`
  methods (return objects carrying `__typename`).
- Subscriptions are over SSE only (`graphql-ws` is a follow-up), and `MemoryPubSub` serves one
  process.
- No `@defer` / `@stream`, trusted documents, cost analysis or federation in this version.
- Types must be written: return types and property types are read from annotations.
