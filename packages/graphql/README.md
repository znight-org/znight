# @znight/graphql

Code-first GraphQL for [Znight](../../README.md): **the TypeScript types are the schema**. Resolvers
are providers marked with `@Resolver`, `@Query`, `@Mutation`, `@Subscription` and `@ResolveField`;
the compiler extension (`@znight/graphql/compiler`) follows every type their signatures reach and
derives the complete schema at build time, with descriptions and deprecations taken from JSDoc.
At runtime, `GraphQLPlugin` serves it on graphql-js 17 through `HttpPlugin`, with DataLoader
batching per execution and subscriptions over Server-Sent Events. The design is
[RFC 0005](../../rfcs/0005-graphql.md).

- **Schema errors at build time.** A `Uint8Array` reached from a query, two types named `Review`, a
  type used as input and output, a union that cannot be told apart at runtime, a field resolver
  without parent, a loader of the wrong type: each is a `ZNIGHT06x` diagnostic with a code frame
  and the path from the root field (`reached from Query.book → Book`).
- **No schema work at boot beyond graphql-js constructors.** The generated metadata holds the type
  graph as data and one `invoke` arrow per resolver method; no SDL parsing, no reflection.
- **DI everywhere.** Resolvers, guards, loaders and error mappers are providers, bound and
  scope-checked by the compiler. Request-scoped providers work in resolvers as in controllers.
- **One transport for every adapter.** The endpoint is a route of `HttpPlugin`: built-in server,
  Fastify, Express and Hono, on Node.js and Bun, through the same pipeline as controllers.
- **One access-control vocabulary.** The route decorators of `@znight/http` (`createRouteDecorator`,
  with required groups) apply to resolvers, and one guard class can protect routes and fields.

No `@ObjectType`, no `@Field(() => Int)`, no `reflect-metadata`, no SDL file to keep in sync.

Your `.graphql` files are the contract? The opt-in [schema-first mode](#schema-first) reads them
instead, binds resolvers to their fields by name (NestJS style) and checks at build time that every
field is resolved and that every resolver signature conforms to the SDL
([RFC 0007](../../rfcs/0007-graphql-schema-first.md)).

**Example:** [`graphql-api`](https://github.com/znight-org/znight/tree/main/examples/graphql-api) (a
book catalog with loaders, subscriptions over SSE, per-field access decisions and a committed
`schema.graphql`, on Node.js and Bun).

```sh
# bun
bun add @znight/core @znight/http @znight/graphql graphql
bun add -d @znight/compiler vite

# npm
npm install @znight/core @znight/http @znight/graphql graphql
npm install -D @znight/compiler vite
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only). `@znight/http` and `graphql` 17 are required peer
dependencies, `dataloader` is a dependency, `@znight/testing` an optional peer (for
`@znight/graphql/testing`), `graphql-yoga` 6 an optional peer (for the Yoga driver,
`@znight/graphql/yoga`).

## Contents

- [Quick start](#quick-start)
- [Types are the schema](#types-are-the-schema)
- [Resolvers](#resolvers)
- [Arguments and validation](#arguments-and-validation)
- [Loaders](#loaders)
- [Subscriptions and PubSub](#subscriptions-and-pubsub)
- [Unions, generic types and scalars](#unions-generic-types-and-scalars)
- [Context and injection](#context-and-injection)
- [Authorization](#authorization)
- [Errors](#errors)
  - [Errors as data](#errors-as-data)
- [Plugin options](#plugin-options)
- [GraphQL over HTTP and SSE](#graphql-over-http-and-sse)
- [Drivers and the engine](#drivers-and-the-engine)
- [Security defaults and limits](#security-defaults-and-limits)
- [Testing](#testing)
- [The generated SDL and the compiler options](#the-generated-sdl-and-the-compiler-options)
- [Schema-first](#schema-first)
- [Observability](#observability)
- [Performance](#performance)
- [Diagnostics](#diagnostics)
- [Compiler contract](#compiler-contract)
- [Limitations](#limitations)

## Quick start

```ts
// src/catalog/book.ts
import type { ID, Int } from '@znight/graphql'

/** A book of the catalog. */
export interface Book {
  readonly id: ID
  readonly title: string
  /** Year of first publication, `null` when unknown. */
  readonly publishedYear: Int | null
}
```

```ts
// src/catalog/book.resolver.ts
import { Args, type ID, Query, Resolver } from '@znight/graphql'

import type { Book } from './book.js'
import { CatalogService } from './catalog.service.js'

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

```ts
// src/main.ts
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

The compiler extension is discovered as soon as the code imports `@znight/graphql`: nothing else to
configure. The schema it derives:

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

```sh
curl -H 'content-type: application/json' -d '{"query":"{ book(id: \"1\") { title } }"}' http://localhost:3000/graphql
```

## Types are the schema

The schema is made of the root fields (`@Query`, `@Mutation`, `@Subscription`) and of every type
they reach. **Output position** is a resolver return type (`Promise<T>` unwrapped) and the fields
of object types; **input position** is an argument and the fields of input types.

| TypeScript                                                                                  | GraphQL                                                                         | Position                    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| `string`, one string literal                                                                | `String`                                                                        | both                        |
| `number`, one number literal                                                                | `Float` (`'Int'` with the `number` compiler option)                             | both                        |
| `Int` / `Float` / `ID` (aliases of `@znight/graphql`)                                       | `Int` / `Float` / `ID`                                                          | both                        |
| `boolean`, `true`, `false`                                                                  | `Boolean`                                                                       | both                        |
| `Date`                                                                                      | `DateTime` (RFC 3339 with offset)                                               | both                        |
| `bigint`                                                                                    | `BigInt` (a decimal string on the wire)                                         | both                        |
| `JSONValue` (`@znight/graphql`)                                                             | `JSON`, always nullable (the type includes `null`)                              | both                        |
| the `T` of a `scalar<T>(name, ...)` declaration                                             | the scalar `name`                                                               | both                        |
| TypeScript `enum` (string or numeric members)                                               | enum: names = member names, internal values = member values                     | both                        |
| named alias of a union of string literals (`type BookSort = 'title' \| 'newest'`)           | enum named after the alias, names = values = the literals                       | both                        |
| class, interface, named alias of an object type or of an intersection of those              | object type (output) or input object type (input)                               | both                        |
| generic instance (`Page<Book>`)                                                             | `BookPage` (type arguments, then the declaration name), or the name of an alias | both                        |
| named alias of `Partial`, `Required`, `Readonly`, `Pick`, `Omit` of an object type          | object or input type named after the alias                                      | both                        |
| named alias of a union of object types                                                      | union                                                                           | output                      |
| `T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>`                                       | `[T]`                                                                           | both                        |
| `Set<T>`, `ReadonlySet<T>`, `Iterable<T>`                                                   | `[T]`                                                                           | output                      |
| `AsyncIterable<T>`, `AsyncGenerator<T>`, `AsyncIterableIterator<T>` (also in a `Promise`)   | the field type `T`                                                              | `@Subscription` return only |
| `T \| null`, `T \| undefined`, an optional property or parameter                            | nullable `T`                                                                    | both                        |
| anything else (`any`, `unknown`, `object`, `void`, functions, tuples, `Map`, `Record`, ...) | [ZNIGHT060](#diagnostics), with a hint                                          |                             |

Non-null is the default: a type without `null`, `undefined` or `?` is `T!`, and list items follow
the same rule (`readonly (Book | null)[]` is `[Book]!`). `ID`, `Int`, `Float` and `JSONValue` are
plain aliases (`type Int = number`): values need no cast, and the compiler recognises them by
identity.

**Object and input types.** Their fields are the public, non-static properties (constructor
parameter properties included), getters (output only), and the members of analysable base classes
and extended interfaces, in declaration order, base members first. Methods, function-typed
properties, `#private`, `private` and `protected` members, symbol and computed keys and `@gqlHidden`
members are left out. Only types reachable from a root field are part of the schema.

**Input or output, not both.** A declaration reached in both positions is ZNIGHT063, with the fix
`export interface MoneyInput extends Money {}`. Input types take no getters, unions, sets or async
iterables, and a cycle of non-null input fields is ZNIGHT063 (no value could be written).

**Naming.** A type's GraphQL name is its declaration name, the name of the alias the annotation goes
through, or its `@gqlName`. Nothing is case-converted: enum member names, literals and properties
are used as written. `Query`, `Mutation`, `Subscription`, names starting with `__`, the specified
scalar names, invalid names and the enum values `true`, `false` and `null` are ZNIGHT061, and so are
two declarations with one GraphQL name.

**JSDoc** is read on types, properties, enum members and resolver methods:

| Tag / text           | On                                               | Effect                                                                     |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| Comment text         | type, property, enum member, resolver method     | `description`                                                              |
| `@param name text`   | resolver method                                  | description of the argument `name`                                         |
| `@deprecated reason` | property, enum member, resolver method, argument | `@deprecated(reason:)` (on arguments and input fields: only when nullable) |
| `@default value`     | property of an args or input type                | default value (a JSON literal checked against the type, ZNIGHT063)         |
| `@gqlHidden`         | property, getter                                 | not part of the GraphQL type                                               |
| `@gqlName Name`      | type declaration                                 | GraphQL name of the type                                                   |

```ts
import type { ID, Int } from '@znight/graphql'

/** A book of the catalog. */
export interface Book {
  readonly kind: 'book'
  readonly id: ID
  readonly title: string
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
}

/** A page of results. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly total: Int
  readonly hasMore: boolean
}

/** Sort orders of the book list. */
export type BookSort = 'title' | 'newest'
```

## Resolvers

```ts
import {
  Args,
  Ctx,
  type GraphQLContext,
  type ID,
  Loader,
  Mutation,
  Parent,
  PubSub,
  Query,
  ResolveField,
  Resolver,
  Subscription,
} from '@znight/graphql'

@Resolver()
export class BookResolver {
  constructor(
    private readonly catalog: CatalogService,
    private readonly events: PubSub<CatalogEvents>,
  ) {}

  /** Books of the catalog, filtered and paginated. */
  @Query()
  books(@Args() filter: BookFilter): Promise<Page<Book>> {
    return this.catalog.list(filter)
  }

  /** Adds a book to the catalog. */
  @Mutation()
  async addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<Book> {
    const book = await this.catalog.add(input)
    await this.events.publish('bookAdded', book)
    return book
  }

  /** Who wrote the book. Batched: one repository call per execution. */
  @ResolveField()
  author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
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

- `@Resolver({ scope? })` registers the class as a provider, a singleton by default; `request`
  creates one resolver per operation. A class is the provider of one extension: `@Resolver` and
  `@Controller` on one class is ZNIGHT005 (both may call the same service).
- `@Query(name?)`, `@Mutation(name?)` and `@Subscription(name?)` declare root fields named after the
  method unless a name is given. Two root fields with one name, across classes, are ZNIGHT061.
- `@ResolveField(name?)` adds a field to the type of the `@Parent()` parameter, which is mandatory
  (ZNIGHT062), or replaces the property of the same name: it must then resolve the same GraphQL
  type (ZNIGHT061). Field resolvers come after the properties, ordered by resolver class then source
  order. A field resolver whose parent type no root field reaches is a ZNIGHT062 warning.
- Field methods are public, non-static, non-generic instance methods with an **explicit return
  type** (the compiler does not infer; ZNIGHT060 otherwise). They are not inherited: a field
  decorator on a class without `@Resolver` is ZNIGHT062.
- Every parameter carries exactly one GraphQL parameter decorator: `@Args`, `@Parent()`, `@Ctx()`,
  `@Info()` (graphql-js `GraphQLResolveInfo`, an escape hatch) or `@Loader()`. An undecorated
  parameter, or `Ctx` / `Query` imported from `@znight/http` by mistake, is ZNIGHT005 with the
  import to use.
- A `@Subscription` method returns an async iterable: an `async *` generator, or
  `pubsub.subscribe(...)`.
- Resolvers in a compiled provider library (`library: true`) are ZNIGHT062: the schema is derived
  from sources, so publish such a package as a source library.

## Arguments and validation

```ts
import type { Int, StandardSchemaV1 } from '@znight/graphql'
import { z } from 'zod'

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
  isbn: z.string().regex(/^\d{13}$/),
  authorId: z.string(),
  genre: z.enum(Genre), // receives the internal value ('fantasy'): GraphQL already mapped the name
  publishedYear: z.number().int().nullish(),
})
```

- `@Args()` without name spreads the properties of the parameter type into arguments:
  `books(search: String, genre: Genre, sort: BookSort = title, limit: Int = 20)`. It is not a
  GraphQL type. `@Args('name')` declares one argument; mixing both is fine when names differ.
- `@Args('input', Schema)` (or `@Args(Schema)` for the whole arguments object) validates the value
  with any [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType...) **after** GraphQL
  coerced it. The resolver receives the schema output (transforms applied); a failure is a
  `BAD_USER_INPUT` error with `extensions.issues: [{ path, message }]`. The annotation stays the
  GraphQL type: the compiler never executes schemas. A schema and an interface may share a name
  (`export interface NewBookInput` + `export const NewBookInput`).
- Defaults: a `@default` JSDoc tag or a statically evaluable parameter default
  (`@Args('limit') limit: Int = 20`, which gives `limit: Int! = 20`) is the schema default, checked
  against the type (ZNIGHT063), printed in the SDL and applied by graphql-js. A default the compiler
  cannot evaluate leaves the argument nullable, and TypeScript applies it.
- **`null` versus `undefined`**: an argument or input field whose TypeScript type does not accept
  `null` (`limit?: Int`) receives `undefined` when the client sends `null`; types that accept `null`
  receive it as is. The resolver always gets values of its declared type.

## Loaders

```ts
import { Injectable } from '@znight/core'
import { type BatchLoad, type ID, orderByKeys } from '@znight/graphql'

@Injectable()
export class AuthorsById implements BatchLoad<ID, Author> {
  /** Optional: DataLoader options, read once per loader class. */
  readonly options = { maxBatchSize: 100 }

  constructor(private readonly authors: AuthorRepository) {}

  async load(ids: readonly ID[]): Promise<readonly (Author | Error)[]> {
    return orderByKeys(ids, await this.authors.findMany(ids), author => author.id)
  }
}
```

- A loader is a provider implementing `BatchLoad<K, V>`: `load(keys)` returns one value (or an
  `Error` failing that key only) per key, in the order of the keys. Another number of values fails
  every key of the batch with ZNIGHT065.
- `@Loader() authors: Loader<AuthorsById>` injects the DataLoader of the **current execution**:
  created on first use, cached for the operation (or for one subscription event), then dropped. The
  compiler binds `AuthorsById` like a constructor dependency (ZNIGHT001 when it is not a provider,
  ZNIGHT065 when it does not implement `BatchLoad` or the parameter is not typed `Loader<L>`). The
  edge is lazy: a singleton resolver may use a request-scoped loader.
- `ctx.loader(AuthorsById)` on the `GraphQLContext` returns the same DataLoader to services called
  by a resolver.
- `options` (`LoaderOptions`): `maxBatchSize`, `cache` (default `true`), `cacheKeyFn` (for object
  keys). Batches are scheduled per tick; `batchScheduleFn` is not exposed.
- `orderByKeys(keys, rows, keyOf, { missing? })` reorders rows to match the keys; a missing key gets
  a `NOT_FOUND` `GraphQLException` (`missing: 'error'`, the default) or `null` (`missing: 'null'`).

## Subscriptions and PubSub

A `@Subscription` method returns an `AsyncIterable<T>`; each value is the field value of one event.
Clients subscribe over Server-Sent Events (GraphQL over SSE, distinct connections mode):

```sh
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"query":"subscription { bookAdded(genre: Fantasy) { title } }"}' http://localhost:3000/graphql
# event: next
# data: {"data":{"bookAdded":{"title":"The Hobbit"}}}
```

The events of a subscription are born elsewhere (a mutation, a scheduled job, a message consumer),
while the stream stays open. `PubSub<Events>` is the mailbox between them: producers
`publish(topic, payload)`, every open subscription `subscribe(topic, { signal })`s and receives what
is published on the topic from then on (nothing is stored or replayed). It is an injectable abstract
class (singleton, provided by `GraphQLPlugin`), where `Events` maps topics to payload types:

```ts
/** Topics of the application PubSub and their payloads. */
export interface CatalogEvents {
  bookAdded: Book
}

// in a provider: constructor(private readonly events: PubSub<CatalogEvents>) {}
await this.events.publish('bookAdded', book)
for await (const book of this.events.subscribe('bookAdded', { signal: ctx.signal })) yield book
```

- The default is a `MemoryPubSub`: in-process fan-out, one bounded `EventChannel` (RFC 0006) per
  subscriber (`subscriptions.bufferSize`, 100 events). A subscriber that falls behind gets a final
  `SUBSCRIPTION_OVERFLOW` error and its stream ends, rather than losing events silently or buffering
  without bound. The plugin closes the `MemoryPubSub` it created when the application is disposed.
- `MemoryPubSub` reaches the subscribers of its own process only. Several instances need a shared
  implementation (Redis pub/sub, NATS, Postgres `LISTEN`/`NOTIFY`, a broker): extend `PubSub` and
  pass an instance as the `pubsub` option. `subscribe()` returns its iterator synchronously, ends
  when `signal` aborts or `return()` is called, buffers a bounded number of events per subscriber
  (`SUBSCRIPTION_OVERFLOW` beyond), and payloads must survive serialization. The plugin does not
  close a `PubSub` it did not create. The guide's
  [Write your own PubSub](../../docs/guide/graphql.md#custom-pubsub) recipe is a tested Redis
  implementation (ioredis).
- `subscribe()` ends when its `signal` aborts: the client left, the application shuts down, the
  stream reached `subscriptions.maxDuration`, or (`plugin.subscribe()`) its `return()` was called.
  Always pass `ctx.signal`.
- The source starts with the subscription: the plugin requests its first event before the SSE
  response starts (or `plugin.subscribe()` resolves), so a generator that calls `subscribe()` before
  its first `await` has subscribed to the PubSub by the time the client is connected, and an event
  published right after is not lost. The stream reads
  that one event ahead; the next ones are read as the client consumes them.
- The request scope of a subscription lasts as long as its stream: request-scoped providers live
  for the subscription, while loaders are renewed for every event. Root subscription guards run
  once, when the subscription starts (per-event authorization is the generator's job).
- `subscriptions.maxActive` (10 000) caps active subscriptions on every transport: beyond it, a new
  subscription is answered 503 (`SERVICE_UNAVAILABLE`). `plugin.activeSubscriptions` gives the
  count.

## Unions, generic types and scalars

```ts
/** A search hit: told apart at runtime by `kind`, found by the compiler. */
export type SearchResult = Book | Author
// search(text: String!): [SearchResult!]!   union SearchResult = Author | Book
```

A union is a **named** alias of a union of object types. The compiler picks the runtime
discriminator: `instanceof` when every member is an exported class (subclasses first), otherwise
`__typename` or a property whose literal type differs in every member (`kind` here). Neither is
ZNIGHT064.

Generic object types are named after their type arguments: `Page<Book>` is `BookPage`,
`Page<Edge<Book>>` is `BookEdgePage`. An alias wins: `export type BookList = Page<Book>` names it
`BookList`. Generic instances count per instance for the input/output rule.

```ts
import { scalar } from '@znight/graphql'

export type Isbn = string & { readonly __brand: 'Isbn' }

export const IsbnScalar = scalar<Isbn>('Isbn', {
  description: 'An ISBN-13, thirteen digits.',
  specifiedByURL: 'https://www.isbn-international.org/content/what-isbn',
  serialize: value => value,
  parseValue: value => {
    if (typeof value !== 'string' || !/^[0-9]{13}$/.test(value)) throw new TypeError('An ISBN has 13 digits')
    return value as Isbn
  },
})
```

`scalar<T>(name, definition)` maps the TypeScript type `T` (a branded alias, or a global such as
`URL`) to the GraphQL scalar `name` wherever it appears. `name` is static; the result must be an
exported `const` (the generated module imports it). The definition is a `ScalarDefinition`
(`serialize`, `parseValue`, optional `parseLiteral`, `description`, `specifiedByURL`, mapped to the
graphql-js 17 coercers) or a graphql-js `GraphQLScalarType` such as those of `graphql-scalars`,
whose name must be `name` (ZNIGHT066 at boot otherwise).

Built-in scalars appear in the schema only when used: `String`, `Float`, `Int`, `ID`, `Boolean`,
`DateTime` (`Date`; RFC 3339 with a mandatory offset, `@specifiedBy` RFC 3339), `BigInt`
(`bigint`; a decimal string on the wire) and `JSON` (`JSONValue`).

## Context and injection

`GraphQLContext` is the context of one operation, a request-scoped external
(`@znight/graphql#GraphQLContext`, `GraphQLTokens.Context`):

| Member                            | What                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `requestId`                       | Id of the request carrying the operation (`HttpContext.requestId` over HTTP, a UUID or `requestId` option otherwise) |
| `transport`                       | `'http'`, `'sse'` or `'direct'` (`plugin.execute()` / `subscribe()`); `'ws'` is reserved for `graphql-ws`            |
| `http`                            | The `HttpContext` of the request, `undefined` for direct executions outside a request                                |
| `operationType` / `operationName` | `'query'`, `'mutation'` or `'subscription'`; the selected operation name                                             |
| `document` / `variables`          | The parsed document (shared by the document cache: never mutate it) and the coerced variables                        |
| `signal`                          | Over HTTP, the request's `ctx.signal`: client gone, SSE stream closed; passed to graphql-js as `abortSignal`         |
| `state`                           | A `Map` for per-operation storage                                                                                    |
| `loader(Class \| token)`          | The DataLoader of the current execution for a loader                                                                 |
| `serverContext`                   | With a [driver](#drivers-and-the-engine), the context its server gave the engine; `undefined` otherwise              |

- Resolvers receive it with `@Ctx()`; request-scoped providers inject `GraphQLContext`, singletons
  `Lazy<GraphQLContext>`, exactly like `HttpContext`.
- The context is not a bag for user data: the authenticated user is a request-scoped provider
  filled by a guard (see [Authorization](#authorization)).
- Over HTTP, one request scope per HTTP request, which carries exactly one operation (no batching).
  `plugin.execute()` and `plugin.subscribe()` run in the current scope when one is active (a
  controller calling GraphQL), otherwise in a scope of their own.

### Custom parameter decorators

A decorator defined with `createParamDecorator` (`@znight/core`, RFC 0010) works on resolver
methods when it has a `graphql` resolver, which receives the field's `ResolverContext` (`parent`,
`args`, `info`, `operation`, `http`, `route.meta`). One definition serves HTTP routes and GraphQL
fields:

```ts
import { createParamDecorator } from '@znight/core'
import type { User } from './user.ts'

export const CurrentUser = createParamDecorator<User>({
  http: ctx => ctx.state.get('user') as User,
  graphql: ctx => ctx.operation.state.get('user') as User,
})

// @Query() me(@CurrentUser() user: User): User { return user }
```

The resolver runs after the guards (it sees what they stored) and before the method; what it
throws fails the field like the method would (`errors[]`, or a result mapper). A custom parameter
is not a GraphQL argument: it never appears in the schema. Resolver classes implementing
`ParamResolver` are resolved in the operation scope. Custom parameters belong to the field
resolvers of the schema, so they work the same through the built-in transport, `plugin.execute()`
and a driver such as `yogaDriver()` (RFC 0009).

## Authorization

The route decorators of `@znight/http` (`createRouteDecorator`, with RFC 0001's groups) apply to
resolver classes and methods, and one guard class can implement `CanActivate` (routes) and
`GraphQLGuard` (fields):

```ts
// src/auth/access.ts: shared by controllers and resolvers
import { createRouteDecorator } from '@znight/http'

export type Role = 'reader' | 'editor'

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
```

```ts
// src/auth/access.guard.ts
import { Injectable, type Lazy } from '@znight/core'
import type { GraphQLGuard, ResolverContext } from '@znight/graphql'
import type { CanActivate, HttpContext, RouteMetaCarrier } from '@znight/http'

import { Authenticated, Public, Roles } from './access.js'
import type { CurrentUser } from './current-user.js'

@Injectable()
export class AccessGuard implements CanActivate, GraphQLGuard {
  /** This guard enforces the "access" group, on routes and on root fields. */
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
    const principal = this.user.get().principal // UnauthorizedException → 401 / UNAUTHENTICATED
    const roles = Roles.get(ctx)
    if (roles !== undefined) return roles.some(role => principal.roles.includes(role))
    return Authenticated.get(ctx) === true
  }
}
```

```ts
HttpPlugin.configure({ guards: [AuthenticationGuard, AccessGuard] })
GraphQLPlugin.configure({
  guards: [AccessGuard],
  http: { meta: [Public.meta()] }, // the endpoint itself is open: decisions are taken per field
})
```

- **The endpoint** is an HTTP route: the global HTTP guards run on it, `http.meta` and `http.guards`
  give it route metadata and guards, and with a required group it needs a decision like any route.
- **Fields** follow RFC 0001: the decorators of a group are alternatives, the method's decision
  replaces the class's, a `required` group must be decided on every **root field** (ZNIGHT023 at
  build time, the code HTTP routes use), and every decided group must be enforced by a guard of the
  field's chain (`static enforces`, checked at boot: ZNIGHT023, or a warning with
  `enforcement: 'warn'`).
- `ResolverContext` satisfies `RouteMetaCarrier`, so `Roles.get(ctx)` works: `route: { meta,
  coordinate }` (effective metadata, schema coordinate `Query.books`), `operation`
  (`GraphQLContext`), `parentType`, `field`, `args`, `parent`, `info`, `http`.
- Guards run global (`GraphQLPlugin.configure({ guards })`), then class `@UseGuard`, then method
  `@UseGuard`. `false` fails the field with `FORBIDDEN`; a thrown error is mapped like any error
  ([Errors](#errors)). Guards stay synchronous until one returns a promise.
- Global guards run on **root fields** and on **field resolvers carrying their own metadata** (a
  route decorator on the method or its class). Other field resolvers are covered by the decision
  of the root field the selection descends from; plain property fields never run guards.
- Guards run once per resolver call (a guard on a field resolver of a list runs once per item): keep
  them cheap. `@UseGuard` classes are bound with lazy edges, so a singleton resolver may use a
  request-scoped guard.

## Errors

```ts
import { Injectable } from '@znight/core'
import { GraphQLException, type GraphQLErrorMapper } from '@znight/graphql'

@Injectable()
export class CatalogErrorMapper implements GraphQLErrorMapper {
  map(error: unknown): GraphQLException | undefined {
    if (error instanceof BookNotFoundError) {
      return new GraphQLException(error.message, { code: 'NOT_FOUND', extensions: { bookId: error.bookId } })
    }
    return undefined
  }
}
```

Every error of `errors[]` is resolved in this order:

1. a `GraphQLException` (or a graphql-js `GraphQLError` thrown by user code) is shown as is:
   `{ message, locations, path, extensions: { ...extensions, code } }`; its `cause`
   (`new GraphQLException(message, { code, cause })`) is never sent, and logged once at `error`
   level with the request id, the schema coordinate, the path and the code;
2. the `errorMappers`, in order (synchronous: `map(error, ctx)`; the first exception wins, a mapper
   that throws is logged and skipped);
3. an `HttpException` of `@znight/http` is mapped by status: a `ValidationException` is
   `BAD_USER_INPUT` with `extensions.issues`, 400 `BAD_USER_INPUT`, 401 `UNAUTHENTICATED`, 403
   `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`, 429 `TOO_MANY_REQUESTS`, another 4xx `BAD_REQUEST`,
   5xx masked;
4. anything else is masked as `Unexpected error.` with `INTERNAL_SERVER_ERROR`, and logged once at
   `error` level with the request id, the schema coordinate, the path and the cause (with
   `exposeErrors: true`, the original message is sent). This includes the errors graphql-js raises
   while completing a resolver's value, whose message holds that value: a built-in scalar or an enum
   that cannot represent it (`String cannot represent value: { passwordHash: ... }`), a list value
   that is not iterable, a union value that resolves to no member.

`HttpException` headers (`www-authenticate`) are not sent from field errors: one response carries
many fields. Request errors (parse, validation, variables, limits) are never logged above `debug`.

| `GraphQLErrorCode`     | `extensions.code`           | When                                                                     |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `ParseFailed`          | `GRAPHQL_PARSE_FAILED`      | The document does not parse (syntax, `limits.maxTokens`)                 |
| `ValidationFailed`     | `GRAPHQL_VALIDATION_FAILED` | The document is not valid against the schema                             |
| `BadUserInput`         | `BAD_USER_INPUT`            | Invalid variables, a schema of `@Args` rejecting a value, HTTP 400       |
| `QueryTooComplex`      | `QUERY_TOO_COMPLEX`         | `limits.maxDepth`, `maxAliases` or `maxDirectives` exceeded              |
| `BadRequest`           | `BAD_REQUEST`               | Unknown operation name, several operations without a name, another 4xx   |
| `Unauthenticated`      | `UNAUTHENTICATED`           | HTTP 401                                                                 |
| `Forbidden`            | `FORBIDDEN`                 | A guard returned `false`, HTTP 403                                       |
| `NotFound`             | `NOT_FOUND`                 | HTTP 404, a key missing from `orderByKeys`                               |
| `Conflict`             | `CONFLICT`                  | HTTP 409                                                                 |
| `TooManyRequests`      | `TOO_MANY_REQUESTS`         | HTTP 429                                                                 |
| `SubscriptionOverflow` | `SUBSCRIPTION_OVERFLOW`     | A subscriber fell behind its buffer: its stream ends with this error     |
| `ServiceUnavailable`   | `SERVICE_UNAVAILABLE`       | `subscriptions.maxActive` reached (HTTP 503)                             |
| `InternalServerError`  | `INTERNAL_SERVER_ERROR`     | An unexpected error (masked), or an error graphql-js raised on execution |

Applications may use their own codes: `new GraphQLException(message, { code: 'OUT_OF_STOCK' })`.

### Errors as data

Errors a client is expected to handle can be **values** of the field instead of entries of
`errors[]` (the "result union" pattern, RFC 0008). The field says which ones it can return through
its TypeScript return type, a union; a result mapper turns errors into those values:

```ts
import { Injectable } from '@znight/core'
import {
  Args,
  GraphQLErrorCode,
  GraphQLException,
  GraphQLPlugin,
  type GraphQLResultMapper,
  Query,
  Resolver,
} from '@znight/graphql'
import { NotFoundException } from '@znight/http'

export interface NotFoundRejection {
  readonly __typename: 'NotFoundRejection'
  readonly message: string
}

export interface ValidationRejection {
  readonly __typename: 'ValidationRejection'
  readonly issues: readonly string[]
}

export type BookResult = Book | NotFoundRejection | ValidationRejection

@Resolver()
export class BookResolver {
  constructor(private readonly books: BookService) {}

  @Query()
  book(@Args('id') id: string): Promise<BookResult> {
    return this.books.get(id) // throws NotFoundException
  }
}

@Injectable()
export class Rejections implements GraphQLResultMapper {
  /** The object types this mapper produces: only fields whose union holds one of them use it. */
  static readonly types = ['NotFoundRejection', 'ValidationRejection']

  toResult(error: unknown): NotFoundRejection | ValidationRejection | undefined {
    if (error instanceof NotFoundException) return { __typename: 'NotFoundRejection', message: error.message }
    if (error instanceof GraphQLException && error.code === GraphQLErrorCode.BadUserInput) {
      const issues = (error.extensions?.['issues'] ?? []) as readonly { readonly message: string }[]
      return { __typename: 'ValidationRejection', issues: issues.map(issue => issue.message) }
    }
    return undefined
  }
}

GraphQLPlugin.configure({ resultMappers: [Rejections] })
```

`{ book(id: "7") { ... on Book { title } ... on NotFoundRejection { message } } }` answers
`{ "data": { "book": { "message": "No book 7" } } }`, without `errors`.

- **Which fields.** A resolver-backed field whose type, without `!`, is a union (not a list) holding
  one of the mapper's `types`; nothing else per field. This is decided at boot: every other field
  keeps its resolve function, with no wrapper and no cost.
- **Which errors.** Everything the field's pipeline throws or rejects: its guards (a guard returning
  `false` is a `GraphQLException` with code `FORBIDDEN`, a thrown `UnauthorizedException` is passed
  as is), the Standard Schema validation of `@Args` (`BAD_USER_INPUT`, with `extensions.issues`),
  the method (synchronously or as a rejected promise). Guards run before validation, so input
  errors are only shown to clients allowed to call the field. `toResult(error, ctx)` receives the
  raw error and the `ResolverContext` guards receive (the field's coordinate and metadata, the
  arguments, the parent, the operation).
- **The value.** The first mapper returning a value that the union resolves to one of its members
  (its discriminator, then `__typename`) wins. `undefined` passes to the next mapper; a value of
  another object type is skipped (logged at `debug`), a value of no type is skipped (`warn`), a
  mapper that throws is skipped (`error`). `toResult()` is synchronous: a returned promise is
  skipped (`error`). When no mapper produces a member, the error goes to `errors[]` as above.
- **Per field.** An error of a child field stays an error of the child, even when its parent's
  union holds the rejection; give the child a union to return a value there. A non-null union
  field resolved to a value is no longer nulled.
- **Masking and logs.** Values are data chosen by the application: never masked, and an error
  resolved as a value is logged at `debug` only. A mapper turning unexpected errors into values (an
  `InternalErrorRejection`) must log them itself; prefer leaving them in `errors[]`.
- **Hook and transports.** A value is data: an operation whose only failure became a value has
  the `success` outcome in `graphql:operation`, with no `errors`. HTTP, SSE and `plugin.execute()`
  send it like any result. On a root subscription field, an error when the subscription starts
  (a guard, or the method before it returns its stream) becomes a stream of that single event (one
  `next`, then `complete`). The body of an `async *` method runs in the stream, after the start: its
  errors stay in `errors[]`; check before returning the generator to map them.
- **At boot.** A result mapper is a provider of any scope (a class that is not a provider is
  ZNIGHT001) or an instance (its `types` property, or its class's `static types`), with a
  `toResult()` method. Its `types` must name
  object types of the schema: a typo is ZNIGHT066.

The thrown error can be the value itself (Pothos style) when its class is a member of the union:
`toResult: error => (error instanceof OutOfStock ? error : undefined)` with
`static types = ['OutOfStock']`.

## Plugin options

`GraphQLPlugin.configure(options | (container) => options)`, name `graphql`. A function is evaluated
once, when first needed after the container is initialised. Unknown keys and invalid values are
ZNIGHT066.

| Option          | Default                                                                | Description                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `path`          | `'/graphql'`                                                           | Path of the endpoint, joined with the `HttpPlugin` prefix                                                                                                                |
| `http`          | `{}`                                                                   | `false`: no HTTP transport (schema, `execute()` and `subscribe()` only). Object: `{ meta?, guards?, bodyLimit = '100kb', get = true }`                                   |
| `guards`        | `[]`                                                                   | Global GraphQL guards (classes or instances implementing `GraphQLGuard`)                                                                                                 |
| `errorMappers`  | `[]`                                                                   | `GraphQLErrorMapper` classes or instances, tried in order                                                                                                                |
| `resultMappers` | `[]`                                                                   | `GraphQLResultMapper` classes or instances, tried in order: errors as data on the fields whose union holds one of their `types` ([Errors as data](#errors-as-data))      |
| `exposeErrors`  | `false`                                                                | Unmasked messages for unexpected errors (development)                                                                                                                    |
| `introspection` | `NODE_ENV !== 'production'`                                            | Off: graphql-js `NoSchemaIntrospectionCustomRule`, and suggestions are hidden                                                                                            |
| `graphiql`      | `NODE_ENV === 'development'`                                           | `GET path` with `accept: text/html` serves GraphiQL; with a `driver`, the driver's IDE                                                                                   |
| `limits`        | `{ maxTokens: 2000, maxDepth: 12, maxAliases: 30, maxDirectives: 50 }` | Request limits (introspection fields exempt from `maxDepth`); `false` disables one                                                                                       |
| `documentCache` | `1000`                                                                 | Distinct documents kept parsed and validated (LRU); `0` disables                                                                                                         |
| `subscriptions` | `{ maxActive: 10_000, bufferSize: 100 }`                               | `false` disables subscriptions over SSE. `heartbeat` (ms or `false`) and `maxDuration` (ms) are passed to `HttpResponse.sse()` (default: the `HttpPlugin` `sse` options) |
| `pubsub`        | a `MemoryPubSub`                                                       | The `PubSub` provided to the container                                                                                                                                   |
| `enforcement`   | `'error'`                                                              | How the boot check of field decisions reports a problem: `'error'` fails the boot (ZNIGHT023), `'warn'` logs                                                             |
| `driver`        | the built-in transport                                                 | The GraphQL server serving the schema ([Drivers and the engine](#drivers-and-the-engine)); `heartbeat` and `maxDuration` are refused with one (ZNIGHT066)                |

`HttpPlugin` must be registered unless `http: false` (ZNIGHT066). The plugin instance exposes:

| Member                         | What                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                       | The graphql-js `GraphQLSchema` (after bootstrap)                                                                                  |
| `printSchema()`                | Its SDL (graphql-js `printSchema`), byte-identical to the compiler's SDL artifact                                                 |
| `execute(request, options?)`   | A query or mutation outside of HTTP; returns the result directly when every resolver is synchronous (`await` it)                  |
| `subscribe(request, options?)` | A stream of results, one per event, until the source ends, `options.signal` aborts, `return()` is called or the application stops |
| `pubsub`                       | The `PubSub` of the application                                                                                                   |
| `activeSubscriptions`          | Active subscriptions, every transport                                                                                             |
| `engine`                       | The `GraphQLEngine` drivers call (after bootstrap): [Drivers and the engine](#drivers-and-the-engine)                             |
| `initRoots()` / `httpRoutes()` | The `PluginInitRoots` contract (`TestApp`) and the `PluginHttpRoutes` contract of `@znight/http`, `onHttpDrain()` included        |

`request` is `{ query, operationName?, variables?, extensions? }`; `options` is `{ signal?,
requestId? }`. A direct execution has no HTTP guards of its own: inside a controller, it runs in the
route's request scope, after the route's guards. With `http: false`, a controller can hand its
requests to another GraphQL server that delegates the execution to `execute()` and `subscribe()`;
a [driver](#drivers-and-the-engine) does it without the copying, on the parsed document (GraphQL
Yoga: [`yogaDriver()`](#graphql-yoga)).

```ts
const plugin = app.getPlugin<GraphQLPlugin>('graphql')
const result = await plugin?.execute({ query: '{ books { total } }' })
```

`onStart` logs `GraphQL endpoint ready` with the path, the number of types and the schema hash
(`GraphQL schema ready` with `http: false`). On shutdown, `onStop` ends the direct subscriptions
and those of the engine; `HttpPlugin` drains the requests in flight and closes the SSE streams
(their `ctx.signal` aborts with `'shutdown'`, then the stream ends with a jittered `retry` and **no**
`complete` event, so clients reconnect to another instance). When `HttpPlugin` starts draining, it
calls `GraphQLPlugin.onHttpDrain()`, which ends the engine's subscriptions too (a driver serves them
as streams `HttpPlugin` does not close) and refuses new ones (503). A route-mounted driver stops in
`onDispose`, once the drain is over: requests in flight are served. Plugin order does not matter.

## GraphQL over HTTP and SSE

`GraphQLPlugin` contributes two routes to `HttpPlugin` on `path`: `GET` (when `http.get` or
`graphiql` is on) and `POST`, with the route metadata, guards and body limit of the `http` option.
They run through the HTTP pipeline like a controller route (request scope, request id,
`http:request` hooks, global then endpoint guards, exception mappers, CORS and security headers,
drain), without interceptors. A path colliding with an HTTP route is ZNIGHT007 at boot. The
endpoint follows the GraphQL-over-HTTP specification draft:

| Request                                                | Answer                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `POST` with `content-type: application/json`           | `{ query, operationName?, variables?, extensions? }` executed          |
| `POST` with another content type or a content encoding | 415 (no form or text body: cross-site requests are always preflighted) |
| `POST` with an array body (batching)                   | 400                                                                    |
| `POST` with malformed JSON, a non-object, no `query`   | 400                                                                    |
| `POST` past the body limit                             | 413, with a GraphQL error body                                         |
| `GET ?query=...&variables=...` (JSON parameters)       | queries only; a mutation or a subscription is 405 with `allow: POST`   |
| `GET` with `http.get: false`                           | 405 with `allow: POST`                                                 |
| `GET` with `accept: text/html` and `graphiql` on       | the GraphiQL page, with its own `content-security-policy`              |
| A subscription without `accept: text/event-stream`     | a request error with a hint: 400, or 200 in `application/json`         |
| `accept` that lists none of the produced types         | 406                                                                    |

The `accept` header picks the answer: `application/graphql-response+json` when listed (200 with
`data`, 400 for parse, validation, variable and limit errors), otherwise `application/json` (200 for
every well-formed request; no `accept` header, `*/*` and `application/*` mean `application/json`),
or `text/event-stream` for GraphQL over SSE (distinct connections mode): one `next` event per
result, then `complete`. An event stream preferred to the JSON types (a higher `q`), or the only
type listed, streams any operation; listed at the same quality as a JSON type (urql lists
`application/graphql-response+json, application/json, text/event-stream`), it streams subscriptions
only, and queries and mutations get one JSON body. The stream is RFC 0006's `HttpResponse.sse()` with the
`subscriptions` options (`heartbeat`, `maxDuration`): a client that leaves aborts `ctx.signal` and
ends the source, a stream closed by the shutdown ends without `complete`, and past
`subscriptions.maxActive` a new subscription is 503. An asynchronous query whose client leaves is
aborted (graphql-js `abortSignal`). The endpoint passes the `serverAudits()` of `graphql-http` on
the four adapters, on Node.js and Bun.

Adapters need nothing specific. With Express, do not mount `express.json()` before Znight routes
(the body would be consumed). In tests, `TestApp.inject()` runs queries and mutations through every
adapter in memory and `injectStream()` / `injectSse()` stream subscriptions.

## Drivers and the engine

The built-in GraphQL-over-HTTP and SSE endpoint is the default and the fastest path. A **driver**
serves the same schema with another GraphQL server, for its protocol features and its plugins
(RFC 0009): Znight stays the engine, the driver owns the transport.

```ts
import { yogaDriver } from '@znight/graphql/yoga'

GraphQLPlugin.configure({ guards: [AccessGuard], driver: yogaDriver() })
```

Resolvers, guards, loaders, result mappers, request-scoped providers and tests do not change: the
server calls `plugin.engine`, which runs the compiled schema with everything this README describes.
**GraphQL Yoga** is the first driver ([`@znight/graphql/yoga`](#graphql-yoga)); **Apollo Server**
follows once it accepts graphql-js 17. Any other graphql-js-shaped server takes the engine as it
is: a driver is a small object, checked with the [conformance suite](#driver-conformance).

**The engine.** `plugin.engine` (after bootstrap, and the first argument of `driver.start()`):

| Member                          | What                                                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                        | The executable schema; its resolvers are Znight's pipelines                                                                                                                                                                 |
| `settings`                      | The resolved options a server needs: `path` (prefix included), `introspection`, `ide` (`graphiql`), `exposeErrors`, `maxTokens`, `subscriptions` (`false` or `{ maxActive }`), `http` (`false` or `{ get, bodyLimit }`)     |
| `parse(source)`                 | graphql-js `parse` through the document cache, with `maxTokens` and the depth, aliases and directives limits; throws a `GraphQLError` (`GRAPHQL_PARSE_FAILED`, `QUERY_TOO_COMPLEX`)                                         |
| `validate(schema, doc, rules?)` | graphql-js `validate` with `rules` (default `specifiedRules`) plus the engine's, suggestions hidden without introspection; a valid document is cached (default rules), its errors carry `GRAPHQL_VALIDATION_FAILED`         |
| `rules`                         | The engine's own rules (the limits, `NoSchemaIntrospectionCustomRule` without introspection), for servers that validate themselves                                                                                          |
| `execute(args, options?)`       | A validated query or mutation, in the current request scope (or one of its own): the `GraphQLContext` is the `contextValue`, `args.contextValue` its `serverContext`; errors mapped and masked, as `GraphQLError` instances |
| `subscribe(args, options?)`     | A validated subscription: a stream of results (loaders renewed per event), or a single error result; the `maxActive` cap is shared with every transport, and the plugin ends the stream when the application stops          |

`options` is `{ transport?: 'http' | 'sse' | 'ws', signal?, requestId? }`; the signal defaults to
`args.abortSignal`, then to the HTTP request's. The functions are bound and have graphql-js's
signatures, so they fit `graphql-http`, `graphql-sse`, `graphql-ws` and Envelop's `useEngine` as
they are. Every operation produces one `graphql:operation` event with the driver's name, and
documents rejected by `parse` or `validate` are observed too.

**The driver contract.** A `GraphQLDriver` has a `name` (`builtin` is reserved), optional
`routes()`, `start(engine, context)` and an optional `stop()`:

```ts
import type { HttpContext } from '@znight/http'
import type { GraphQLDriver } from '@znight/graphql'

import { HttpResponse } from '@znight/http'
import { createHandler, type Handler } from 'graphql-http'

/** graphql-http's handler on the engine: GraphQL over HTTP served by the reference implementation. */
export function graphqlHttpDriver(): GraphQLDriver {
  let handler: Handler<HttpContext> | undefined
  return {
    name: 'graphql-http',
    routes: ({ path }) => {
      const handle = async (ctx: HttpContext) => {
        const body = ctx.method === 'POST' ? new TextDecoder().decode(await ctx.rawBody()) : null
        const [text, init] = await (handler as Handler<HttpContext>)({
          method: ctx.method,
          url: ctx.url,
          headers: { get: name => ctx.header(name.toLowerCase()) ?? null },
          body,
          raw: ctx,
          context: undefined,
        })
        return new HttpResponse(text ?? undefined, { status: init.status, headers: init.headers ?? {} })
      }
      return [
        { method: 'GET', path, name: 'graphql', handler: handle },
        { method: 'POST', path, name: 'graphql', handler: handle },
      ]
    },
    start(engine) {
      handler = createHandler<HttpContext>({
        schema: engine.schema,
        parse: engine.parse,
        validate: engine.validate,
        execute: args => engine.execute(args),
      })
    },
  }
}
```

- **Routes.** A route-mounted driver returns its routes: `GraphQLPlugin.httpRoutes()` gives them to
  `HttpPlugin` with the `http` option's `meta` and `guards`, and its `bodyLimit` on the routes that
  are not `GET`. They run in the HTTP pipeline like the built-in endpoint (request id, request
  scope, `http:request` hooks, global and endpoint guards, route decisions, CORS, security headers,
  drain), so the engine finds the request scope: `GraphQLContext.http` is the request, and HTTP
  guards and GraphQL guards see the same request-scoped providers. `routes()` is called once,
  possibly before `start()`. A driver without routes is server-mounted: it attaches itself to
  `context.http.adapter` in `start()` and runs outside the pipeline.
- **Lifecycle.** `onBootstrap` builds the engine, then awaits `start(engine, { logger, container,
  http })`; a failure fails the boot (ZNIGHT066, the original error as `cause`). The engine's
  subscriptions end when `HttpPlugin` starts draining (`onHttpDrain()`, whatever the plugin order)
  and in `onStop`; new ones are then refused (503). `stop()` is awaited in `onDispose` for a
  route-mounted driver, after `HttpPlugin` drained its requests, and in `onStop` for a
  server-mounted one (`onDispose` does, for an application that never started).
- **Options.** The engine options (`guards`, `errorMappers`, `resultMappers`, `exposeErrors`,
  `introspection`, `limits`, `documentCache`, `subscriptions: false`, `maxActive`, `bufferSize`,
  `pubsub`, `enforcement`) apply to every driver. `path`, `http` and `graphiql` are read by the
  driver through its routes and `engine.settings`. `subscriptions.heartbeat` and `maxDuration`
  configure the built-in SSE transport only: with a driver they are ZNIGHT066 (use the driver's
  keep-alives). A driver with routes needs `HttpPlugin` and refuses `http: false` (ZNIGHT066).
- **Errors.** The engine maps and masks errors once; a driver keeps the engine's errors as they
  are. Request errors raised by the server itself (malformed JSON, a persisted query not found) are
  the server's; an unexpected error thrown outside the engine is masked like the engine masks one.
- **Cost.** Without `driver`, the plugin runs the built-in transport's handlers, which call the
  internal executor directly: an application without driver pays nothing for the abstraction.

`executeOperation()` and `subscribeOperation()` of `@znight/graphql/testing` send their requests to
the driver's routes like to the built-in endpoint. The repository's tests run the `graphql-http`
audits against the driver above and the Yoga driver on the four adapters, on Node.js and Bun.

### GraphQL Yoga

`@znight/graphql/yoga` serves the schema with [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server)
6 (`graphql-yoga`, an optional peer dependency loaded by this entry only):

```ts
import { GraphQLPlugin } from '@znight/graphql'
import { yogaDriver } from '@znight/graphql/yoga'

GraphQLPlugin.configure({ driver: yogaDriver({ plugins: [usePersistedOperations({ getPersistedOperation })] }) })
```

| Export                             | What                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `yogaDriver(options?)`             | The driver (`name: 'yoga'`); `driver.yoga` is the Yoga server once started                                                 |
| `YogaDriverOptions`                | Yoga's options without those Znight owns (below); `graphiql` takes GraphiQL's options                                      |
| `yogaContext(ctx)`                 | Yoga's context of an operation (`request`, `params`, what plugins added, `znight`: the `HttpContext`), ZNIGHT066 otherwise |
| `YogaContext`, `YogaServerContext` | Their types                                                                                                                |

- **The engine is Yoga's engine.** The driver installs Envelop's `useEngine` with the engine's
  `parse`, `validate`, `execute` and `subscribe`, before the application's plugins: one document
  cache (Yoga's `parserAndValidationCache` is off), the engine's limits and introspection rule,
  rejected documents observed by the hook, one `graphql:operation` event per operation with
  `driver: 'yoga'` (`transport: 'sse'` for subscriptions). Plugins wrapping the execution
  (`useResponseCache`) call the engine; an operation executed by a plugin that replaces it
  (`useGraphQlJit`) fails with ZNIGHT066, logged once: its resolvers would not get the
  `GraphQLContext`.
- **Owned options**, refused with ZNIGHT066 (a type error first): `schema`, `context`,
  `graphqlEndpoint` (`path`), `maskedErrors` (the engine masks once, see below),
  `cors` (`HttpPlugin`'s), `maxRequestBodySize` (`http.bodyLimit`), `parserAndValidationCache`,
  `requestId` (Yoga uses `HttpContext.requestId`), `healthCheckEndpoint`, `landingPage`,
  `fetchAPI` (the runtime's own), `disposeOnProcessTerminate` (the application stops Yoga),
  `batching` (one operation per request: the operations of a batch would share the request scope,
  where each one's `GraphQLContext` would replace the other's) and `multipart` (JSON bodies only,
  below). Yoga's `logging` is off unless set.
- **Routes.** `GET` and `POST` on `path`. `GET` serves Yoga's GraphiQL with `graphiql` on, and
  queries with `http.get` on (405 with `allow: POST` otherwise); a mutation over `GET` is Yoga's 405
  (`allow: POST`). A `POST` body is `application/json` only, like the built-in transport: any other
  content type (a form, `multipart/form-data`, `text/plain`, `application/graphql`) is the built-in
  transport's 415, before Yoga parses it, so a cross-site page cannot run a mutation with the
  user's cookies (no CSRF: a JSON body always needs a CORS preflight).
- **Errors.** The engine's errors (masked already) and `GraphQLError`s thrown on purpose (a plugin's
  rate limit, Yoga's request errors) are sent as they are. Any other error thrown outside the engine
  (an Envelop plugin's hook, Yoga itself) is logged once by Znight and masked like the engine masks
  one: `Unexpected error.` with code `INTERNAL_SERVER_ERROR` (its message with `exposeErrors`), a
  500 for a request error.
- **The Fetch bridge.** On `honoAdapter()` the native Web `Request` is handed to Yoga as is (a `GET`,
  or a body with a `content-length` within the limit); otherwise a `Request` is built from
  `HttpContext` with the body read by `ctx.rawBody()`, so a body past `http.bodyLimit` is
  `HttpPlugin`'s 413 on every adapter. Yoga's `Response` is sent as is by `HttpPlugin`.
- **Subscriptions** use Yoga's SSE; the engine caps them (`subscriptions.maxActive`) and ends them
  when `HttpPlugin` starts draining, whatever the plugin order, when Yoga sends `complete` (not the
  built-in transport's `retry` hint); a subscription sent during the drain gets a
  `SERVICE_UNAVAILABLE` error. Queries in flight are served until the drain is over; `stop()` then
  awaits `yoga.dispose()` (the plugins' `onDispose`), and a request reaching the stopped driver gets
  a 503.
- **Cost.** Yoga's request parsing, its plugin chain and the Web objects cost about 13 to 18 µs per
  request on Bun and 27 to 45 µs on Node.js in the in-process benchmark (`test/bench/http.bench.ts`),
  against about 1.6 µs and 5.5 µs for the built-in transport.

### Driver conformance

`describeDriverConformance()` of `@znight/graphql/testing` describes the scenarios every driver
passes (RFC 0009 §12), with the test framework's own functions (`bun:test`, Vitest, Jest,
`node:test`) and `node:assert`: queries, mutations, a field guard reading a request-scoped
provider, loaders batching, request-scoped providers per request, result mappers, masking,
introspection off, limits, HTTP guards on the endpoint, the hook, `POST` bodies other than JSON
(415, never executed) and mutations over `GET` (405), and over SSE (unless `subscriptions: false`)
events, completion, client abort, `maxActive` and shutdown in both plugin orders.

```ts
import { describeDriverConformance } from '@znight/graphql/testing'
import { yogaDriver } from '@znight/graphql/yoga'
import { expressAdapter } from '@znight/http/express'
import { honoAdapter } from '@znight/http/hono'
import { afterAll, beforeAll, describe, it } from 'bun:test'

describeDriverConformance({
  driver: () => yogaDriver(), // a new driver per application; () => undefined for the built-in transport
  test: { describe, it, beforeAll, afterAll },
  adapters: { express: () => expressAdapter(), hono: () => honoAdapter() },
})
```

## Security defaults and limits

- **Introspection** off in production (`NODE_ENV === 'production'`), and suggestions hidden with it
  (`hideSuggestions`), so validation errors do not leak field names. graphql-js 17's
  `MaxIntrospectionDepthRule` is always on.
- **Error masking** on: unexpected errors are `Unexpected error.` unless `exposeErrors`.
- **Limits**: `maxTokens` (2 000) is passed to `parse`; `maxDepth` (12, introspection fields exempt),
  `maxAliases` (30) and `maxDirectives` (50) are checked in one pass before the validation rules, so
  an abusive document is rejected before the expensive rules run (`QUERY_TOO_COMPLEX`). Aliases count
  as written and as executed: a fragment spread several times counts its aliases each time, so a
  chain of fragments cannot multiply aliased fields past the limit.
- **Transport**: no batching, JSON-only `POST` (CSRF-safe), `GET` for queries only, body limit 100 KiB,
  active subscriptions capped.
- **Document cache** keyed by the exact query text, bounded in entries (LRU); documents rejected by
  the limits or by validation are not cached.
- **GraphiQL** only when enabled (development by default), loaded from a pinned version on
  `cdn.jsdelivr.net`, with a `content-security-policy` for that origin that overrides the strict API
  default of `@znight/http` on that response only.
- **Deny by default** for fields is opt-in through a `required` route decorator group
  ([Authorization](#authorization)), like HTTP routes.

## Testing

Resolvers are providers: `TestBed` unit-tests them with auto-mocks, and `fakeLoader<L>()` builds a
`Loader<L>` whose `load` and `loadMany` are spies.

```ts
import { expect, test } from 'bun:test'
import { fakeLoader } from '@znight/graphql/testing'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'

test('author() goes through the loader', async () => {
  const { instance } = await TestBed.create(BookResolver, { metadata })
  const authors = fakeLoader<AuthorsById>({ [herbert.id]: herbert })
  expect(await instance.author(dune, authors)).toBe(herbert)
  expect(authors.load).toHaveBeenCalledWith(herbert.id)
})
```

Operations run through the whole stack with `TestApp` (which boots the resolvers, their guards and
loaders) and `@znight/graphql/testing`:

```ts
import { expect, test } from 'bun:test'
import { GraphQLPlugin } from '@znight/graphql'
import { executeOperation, subscribeOperation } from '@znight/graphql/testing'
import { HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'

import { __ZNIGHT_METADATA__ } from '../src/.znight/container.generated.js'

const ADD_BOOK = `mutation Add($input: NewBookInput!) { addBook(input: $input) { id title } }`
const DUNE = { title: 'Dune', isbn: '9780441013593', authorId: 'a1', genre: 'ScienceFiction' } // enum names on the wire

test('bookAdded streams new books', async () => {
  await using app = await TestApp.create({
    metadata: __ZNIGHT_METADATA__,
    plugins: [HttpPlugin.configure({ port: 0 }), GraphQLPlugin.configure()],
  })
  await using events = await subscribeOperation(app, { query: 'subscription { bookAdded { title } }' })
  const res = await executeOperation(app, { query: ADD_BOOK, variables: { input: DUNE } })
  expect(res.status).toBe(200)
  expect(res.errors).toBeUndefined()
  expect((await events.next()).value).toEqual({ data: { bookAdded: { title: 'Dune' } } })
})
```

- `executeOperation(app, { query, variables?, operationName?, extensions?, headers? })` sends a
  `POST` through `app.inject()` (the whole HTTP pipeline, with
  `accept: application/graphql-response+json, application/json;q=0.9`) and resolves with
  `{ status, headers, body, data, errors, extensions }`. Without HTTP transport it calls
  `GraphQLPlugin.execute()` and reports the status the endpoint would answer.
- `subscribeOperation(app, request)` streams the operation over GraphQL over SSE in memory
  (`app.injectStream()`), or through `GraphQLPlugin.subscribe()` without HTTP transport (no HTTP
  guards then). It resolves once the subscription is established (its source started: a generator
  resolver that calls `subscribe()` before its first `await` has subscribed to the PubSub), so an event published right after, before any `next()`,
  is received. Its `next({ timeoutMs? })` rejects
  when no result arrives in time (2 s by default), and `return()` (or `await using`) disconnects,
  which the server sees as a client abort.
- `fakeLoader<L>(values | map | fn)` answers from a record by key, a `Map` or a function of the key;
  an `Error` value fails that key, a missing key rejects.

## The generated SDL and the compiler options

Options are given in `znight.config.ts`; the configured copy replaces the discovered extension:

```ts
import graphql from '@znight/graphql/compiler'
import type { ZnightOptions } from '@znight/compiler'

export default {
  extensions: [graphql.configure({ sdl: 'schema.graphql' })],
} satisfies ZnightOptions
```

| Option   | Default   | Description                                                                                                         |
| -------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `sdl`    | `false`   | Path of the SDL artifact, relative to the root, written with the generated module and checked by `generate --check` |
| `number` | `'Float'` | GraphQL type of `number` (`'Int'` suits applications whose numbers are counts and identifiers)                      |
| `schema` | `false`   | Glob(s) of the `.graphql` files of the [schema-first mode](#schema-first), relative to the root                     |

An invalid option is a `TypeError` when `znight.config.ts` is loaded. The SDL artifact is
byte-identical to graphql-js `printSchema()` of the schema the plugin builds (descriptions on one
line print as `"""text"""`), types sorted by name. Commit it: every pull request then shows its
schema diff, and `znight generate --check` fails when it is stale. Without the option,
`plugin.printSchema()` gives the same text at runtime.

The committed file is compared byte for byte with the compiler's output: keep formatters away from
it. With Biome, exclude it in `biome.jsonc` (as this repository does for `examples/graphql-api`):

```jsonc
{
  "files": {
    "includes": ["**", "!schema.graphql"]
  }
}
```

## Schema-first

With `schema`, the SDL files are the schema ([RFC 0007](../../rfcs/0007-graphql-schema-first.md)):

```ts
import graphql from '@znight/graphql/compiler'
import type { ZnightOptions } from '@znight/compiler'

export default {
  extensions: [graphql.configure({ schema: 'src/**/*.graphql', sdl: 'schema.graphql' })],
} satisfies ZnightOptions
```

- **Files.** The globs (a string or a list, `!` negations allowed) are relative to the project
  root; `node_modules` and dot-directories are excluded unless a pattern names them; the files are
  read in path order, files without definitions skipped, and the `sdl` artifact is never read back.
  They are inputs of the compile (`watchFiles`): editing, creating or deleting one recompiles in
  `znight dev`, the Vite plugin and `znight generate --watch` (the Bun preload recompiles on edits,
  and picks a new file up at its next start).
- **One source of truth.** TypeScript types never add to the schema: JSDoc, `@gqlName`,
  `@gqlHidden`, `@default` and `number` are ignored. Descriptions, deprecations and default values
  come from the SDL. The runtime is the code-first one: same metadata, `schemaHash` and `sdl`
  artifact (the served schema, semantically equal to the SDL without its custom directives).
- **SDL.** Parsed, merged (`extend` of every kind, across files) and validated with graphql-js at
  build time (`graphql/language`, `graphql/type`, `graphql/utilities`, loaded lazily in this mode
  only), with the SDL rules graphql-js keeps internal (directive locations, arguments and
  repetitions, unique names) checked too. Object types, interfaces (implementing interfaces too), unions, enums, input objects,
  `schema { ... }` root names, `@deprecated` and `@specifiedBy` are supported. Custom directives
  are a ZNIGHT067 warning and left out; `@oneOf` inputs are not supported yet (ZNIGHT067).
- **Scalars.** A scalar of the SDL binds the `scalar<T>('Name', definition)` declaration of its
  name (its description and `@specifiedBy` come from the SDL, emitted in the metadata with
  `sdl: true`: they replace the definition's, absent ones included, so the served schema is the
  artifact). Without one, `DateTime`, `BigInt` and `JSON` are the built-in scalars;
  any other scalar is ZNIGHT067.
- **Binding by name.** `@Query()`, `@Mutation()`, `@Subscription()` bind the root field named by the
  decorator, else by the method. `@ResolveField()` binds a field of the object type named by the
  class decorator: `@Resolver('Book')` (`@Resolver('Book', { scope: 'request' })` with a scope);
  `@Parent()` is optional. A class may hold both. `@Args('name')` receives one argument, `@Args()`
  every argument as an object, `@Args('name', Schema)` validates with a Standard Schema.
- **Enums and abstract types.** An enum value is its SDL name on both sides (graphql-codegen's
  enums compare by value, so any `namingConvention` works). Unions and interfaces resolve their
  members with `instanceof` for the exported classes the resolvers return (a class is matched to a
  member by its name, or its `__typename`), then from `__typename`. graphql-codegen declares
  `__typename` optional: the check accepts it, but the returned objects must carry it.

```graphql
type Book {
  id: ID!
  title: String!
  author: Author!
}

extend type Query {
  book(id: ID!): Book
}
```

```ts
import { Args, Loader, Parent, Query, ResolveField, Resolver } from '@znight/graphql'

@Resolver('Book')
export class BookResolver {
  constructor(private readonly catalog: CatalogService) {}

  @Query()
  book(@Args('id') id: QueryBookArgs['id']): Promise<Maybe<Book>> {
    return this.catalog.find(id)
  }

  @ResolveField()
  author(@Parent() book: BookModel, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
  }
}
```

**Coverage (ZNIGHT068).** A root field without resolver; a method naming no field (with a "did you
mean", or the root type that declares it); `@Resolver('X')` naming no type, an interface, a
non-object type, or a root type with field resolvers; `@Args('x')` or an `@Args()` property naming
no argument; an object field without resolver that the TypeScript type returned for its parent
lacks. Two methods bound to one field are ZNIGHT061; `@ResolveField` without a type name is
ZNIGHT062.

**Type conformance (ZNIGHT068).** Types are read with the compiler's type shapes. From every
binding, the return type (`Promise<T>` unwrapped, the events of a `@Subscription`), the `@Args`
parameters and the `@Parent()` type are compared with the SDL, following the fields without
resolver through the properties of the returned types:

| SDL                          | Output (return types, properties): assignable                             | Input (arguments, input fields): accepts every value                                              |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `T!` / `T`                   | `T!` rejects `null`, `undefined`, optional properties                     | `T` without default: accept `undefined`; with one: `null` or `undefined`; a nullable item: `null` |
| `[T]`                        | arrays, tuples, `Set`, `ReadonlySet`, `Iterable`                          | arrays                                                                                            |
| `String`, `ID`               | strings, string literals and enums, branded strings (`ID`: numbers too)   | `string` (a literal union is narrower)                                                            |
| `Int`, `Float`               | numbers, number literals and enums, `Int` / `Float`                       | `number`                                                                                          |
| `Boolean`                    | `boolean`, `true`, `false`                                                | `boolean`                                                                                         |
| `DateTime`, `BigInt`, `JSON` | `Date`; `bigint` or number; anything                                      | `Date`; `bigint`; anything                                                                        |
| custom scalar                | the `T` of its `scalar<T>()`                                              | the `T` of its `scalar<T>()`                                                                      |
| enum                         | literals or an enum whose values are SDL values                           | `string`, or literals / an enum covering every value                                              |
| object                       | an object type with a conforming property for each field without resolver | –                                                                                                 |
| union, interface             | each member matched by its `__typename` literal, else by name             | –                                                                                                 |
| input object                 | –                                                                         | an object type whose properties are fields of the input                                           |

When a nullable argument or input field is read by TypeScript types that accept `undefined` but not
`null`, the runtime turns `null` into `undefined` (`nullAsUndefined`), as in code-first (never for
list items). The `T` of another `scalar<T>()` declaration (a branded id for an `ID`) is accepted for
`String` and `ID`.
`any`, `unknown`, opaque types, missing annotations and arguments validated by a Standard Schema are
not checked. Each mismatch is one diagnostic on the TypeScript annotation, the SDL definition
related:

```txt
✗ ZNIGHT068: BookResolver.book returns Book | null, which may be null, but Query.book is Book! (non-null)
 --> src/book.resolver.ts:7:33
  |
7 |   book(@Args('id') id: string): Promise<Book | null> {
  |                                 ^^^^^^^^^^^^^^^^^^^^
  |
 ::: src/schema.graphql:7:3
  |
7 |   book(id: ID!): Book!
  |   ---- Query.book is declared here
  = hint: Return a value in every case, or make Query.book nullable in the SDL (Book)
```

**graphql-codegen.** The `typescript` plugin of GraphQL Code Generator writes the TypeScript types
of the SDL; map every custom scalar to the `T` of its `scalar<T>()` declaration:

```yaml
# codegen.yml
schema: src/**/*.graphql
generates:
  src/graphql.generated.ts:
    plugins: [ typescript ]
    config:
      scalars:
        DateTime: Date
        EventId: ./ids.ts#EventId
      namingConvention:
        enumValues: keep
      useTypeImports: true
```

Its output (`Scalars['X']['output']`, `Maybe<T>`, `InputMaybe<T>`, the `QueryXxxArgs` types,
`__typename` on object types, intersections with interface types) passes the checks as is; the
repository tests it with the verbatim output of graphql-codegen 7.4.6
([`test/fixtures/codegen`](./test/fixtures/codegen)). The `typescript-resolvers` plugin is optional:
decorated methods are checked directly. Models that replace the fields a field resolver computes
(`authorId` instead of `author`) conform, since only the fields without resolver must be properties.

**Performance.** The SDL is parsed and validated once per compile; the conformance walk visits each
(SDL type, TypeScript declaration) pair once, on shapes the compiler caches. An SDL of about 560
types (80 SDL files, 160 TypeScript files) compiles in about 200 ms on Bun
(`test/compiler/schema-first-performance.test.ts`).
Boot and execution are those of code-first.

## Observability

Every operation goes through the `graphql:operation` hook of `@znight/core` (`GraphQLOperationEvent`:
`operationType`, `operationName`, `documentId` (SHA-256 of the query text), `transport`, `driver`
(`builtin`, or the name of the [driver](#drivers-and-the-engine)), `requestId`, `context`,
`startTime`, then `outcome` (`success`, `partial`, `error`, `rejected`) and
`errors` with their codes). A subscription produces one event for its whole life. The event is built
only when the hook has wrappers or listeners, so it costs nothing otherwise.

```ts
import { Hooks, Injectable, type OnStart } from '@znight/core'

@Injectable()
export class OperationLog implements OnStart {
  constructor(private readonly hooks: Hooks) {}

  onStart(): void {
    this.hooks.on('graphql:operation', event => {
      if (event.outcome === 'error') console.warn(event.operationName ?? 'anonymous', event.errors)
    })
  }
}
```

The endpoint is an HTTP route, so `@znight/observability` logs, measures and traces it like any
request (route `/graphql`), and it also wraps this hook: a span `<type> <name>` per operation (child
of the HTTP span), the metrics `graphql_operations_total{type, name, outcome}` and
`graphql_operation_duration_seconds{type, name}` (operation names capped at `maxOperationNames`,
then `_OTHER`), and one log entry per operation with `logging: { graphql: true }` (off by default).
See [GraphQL operation spans](../observability/README.md#graphql-operation-spans).

## Performance

The plugin decides everything it can at boot: the schema is built from data, singleton resolvers
are resolved once, and each field gets the cheapest resolve function that fits it (a field without
guards nor null handling calls `invoke` directly, plain properties keep graphql-js' default
resolver). Per request, on the hot path (a cached query, synchronous resolvers): a memoised `accept`
lookup, the body or the query string read once, one document cache lookup, one context object,
graphql-js `execute`, and one `JSON.stringify`. Nothing is awaited that is not a promise, and
`invoke` is synchronous unless a schema validates asynchronously. Every answer stays on the fast
lane of `@znight/http` unless the application adds CORS, global guards or `http:request` hooks.

Two non-gating micro-benchmarks, run by hand from `packages/graphql` (`bun test` does not run them;
on Node.js, use `node --conditions=@znight/source` instead of `bun`):

- `bun --conditions=@znight/source test/bench/execute.bench.ts`: the per-operation overhead of
  `GraphQLPlugin.execute()` over graphql-js `execute()` for a cached 50-field query (target: under
  10 %; measured 0–9 % on Bun 1.4, 1–7 % on Node.js 24).
- `bun --conditions=@znight/source test/bench/http.bench.ts`: the endpoint through the `HttpPlugin`
  pipeline in process (`GET` and `POST`, both JSON media types), next to bare graphql-js, to a
  controller route answering a constant, and to `GraphQLEngine.execute()` (what a driver calls: on
  a cached `{ hello }`, within 2 % of `plugin.execute()`). `ABORT_REASON=1` removes the cost graphql-js 17.0 adds to
  every execution (a `DOMException` built when it aborts its own `AbortController`, about 3 µs on
  Node.js): compare with other servers at the same graphql-js version.

## Diagnostics

Build-time diagnostics carry a location, a hint and, for types, the path from the root field
(`reached from Query.book → Book`). Details and examples: the
[error reference](../../docs/reference/error-codes.md#znight060).

| Code      | When                                                                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZNIGHT001 | A resolver dependency, a `@UseGuard` class or a `Loader<L>` that is not a provider; at boot, a global guard or mapper class that is not a provider                                                                                                          |
| ZNIGHT005 | Method shape (static, `#private`, non-public, accessor, generic, computed name), parameters without or with several GraphQL decorators, `@znight/http` look-alikes, `@Resolver` on a controller, `@UseGuard` outside a resolver, unexported scalars         |
| ZNIGHT007 | The GraphQL path collides with an HTTP route (boot)                                                                                                                                                                                                         |
| ZNIGHT023 | A root field without a decision of a required route decorator group (build); a decision no guard of the field's chain enforces (boot)                                                                                                                       |
| ZNIGHT060 | A type without GraphQL mapping (`any`, `Map`, `Uint8Array`, `URL` without scalar, tuples, records, anonymous objects and unions, `Promise` or async iterables out of place), a missing return type                                                          |
| ZNIGHT061 | Two declarations or root fields with one name, reserved or invalid names, a field resolver changing the type of the property it replaces, two field resolvers adding one field, duplicate arguments                                                         |
| ZNIGHT062 | `@ResolveField` without `@Parent()`, `@Parent()` on a root field, a subscription not returning an async iterable, no `@Query`, field methods outside a `@Resolver`, resolvers in compiled libraries; a field resolver whose parent is unreachable (warning) |
| ZNIGHT063 | A declaration used as input and output (with the `extends` fix-it), getters, unions and sets in inputs, cycles of non-null input fields, defaults not matching their type                                                                                   |
| ZNIGHT064 | Union members that cannot be told apart (no exported classes, no `__typename`, no literal property with a distinct value per member)                                                                                                                        |
| ZNIGHT065 | A `@Loader()` parameter not typed `Loader<L>`, `L` not implementing `BatchLoad<K, V>`; at runtime, a batch returning another number of values than keys, invalid loader options                                                                             |
| ZNIGHT066 | Boot: malformed or version-skewed `extensions.graphql` (every problem listed in one error), graphql-js schema validation, invalid options, no `HttpPlugin` with the HTTP transport, a scalar implemented under another name                                 |
| ZNIGHT067 | Schema-first SDL: no file matches, syntax errors, duplicate or unknown types, fields and directives, invalid extensions, graphql-js schema validation, `@oneOf`, a scalar without `scalar()`; custom directives and built-in scalar overrides (warnings)    |
| ZNIGHT068 | Schema-first: a field without resolver, a resolver, type or argument the SDL does not declare, a field nothing provides, a signature that does not conform to the SDL                                                                                       |

## Compiler contract

The compiler extension generates `metadata.extensions.graphql` (`GraphQLMetadata`, declared in
[`src/metadata.ts`](./src/metadata.ts)): the schema as data, with one `invoke` function per resolver
method. The section is omitted when the application has no resolver.

```ts
interface GraphQLMetadata {
  version: 1 // GRAPHQL_METADATA_VERSION; another version is ZNIGHT066 at boot
  schemaHash: string // first 16 hex characters of the SHA-256 of the SDL printed by src/sdl.ts
  roots: { query: string; mutation?: string; subscription?: string }
  types: GraphQLTypeDefinition[] // every named type except the specified scalars, sorted by name
  groups?: Record<string, { keys: string[]; required: boolean }> // route decorator groups the runtime needs
}

type GraphQLTypeDefinition =
  | { kind: 'object'; name: string; description?: string; interfaces?: string[]; fields: GraphQLFieldDefinition[] }
  | {
      kind: 'interface' // schema-first only; its fields have no resolver
      name: string
      description?: string
      interfaces?: string[]
      fields: GraphQLFieldDefinition[]
      discriminator: GraphQLDiscriminator
    }
  | { kind: 'input'; name: string; description?: string; fields: GraphQLInputFieldDefinition[] }
  | { kind: 'enum'; name: string; description?: string; values: GraphQLEnumValueDefinition[] }
  | { kind: 'union'; name: string; description?: string; members: string[]; discriminator: GraphQLDiscriminator }
  | { kind: 'scalar'; name: string; description?: string; builtin: true } // DateTime, BigInt, JSON
  | {
      kind: 'scalar'
      name: string
      scalar: ScalarDefinition<unknown> | GraphQLScalarType // imported from user code
      description?: string // wins over the definition's
      specifiedByURL?: string
      sdl?: true // schema-first: description and specifiedByURL replace the definition's, absent ones included
    }

interface GraphQLFieldDefinition {
  name: string
  type: string // graphql-js canonical type reference: 'Book!', '[Book!]!', 'Int'
  description?: string
  deprecationReason?: string
  args?: GraphQLArgumentDefinition[]
  resolver?: GraphQLResolverBinding // absent: graphql-js default resolver (parent[name])
}

interface GraphQLArgumentDefinition /* = GraphQLInputFieldDefinition */ {
  name: string
  type: string
  description?: string
  deprecationReason?: string
  defaultValue?: unknown // external value: JSON-compatible, enum values by GraphQL name
  nullAsUndefined?: true // the TypeScript type does not accept null
}

type GraphQLDiscriminator =
  | { by: 'property'; property: string; values: Record<string, string> } // literal value → member name
  | { by: 'class'; classes: [Class, string][] } // subclasses first
  | { by: 'typename' }

interface GraphQLResolverBinding {
  token: Token // the resolver provider
  method: string
  operation: 'query' | 'mutation' | 'subscription' | 'field'
  guards: Token[] // class @UseGuard guards, then method ones
  meta: Record<string, unknown> // effective route metadata (method over class); {}: none
  loaders?: Token[] // informational: loaders the method injects
  context?: true // custom parameters (RFC 0010): the pipeline passes the ResolverContext as `f`
  paramResolvers?: Token[] // class resolvers of custom parameters, passed as `x`
  invoke(
    resolver,
    parent,
    args: GraphQLArgs,
    context: GraphQLContext,
    info: GraphQLResolveInfo,
    f?: ResolverContext,
    x?,
  ): unknown
}
```

Type references are strings in graphql-js' canonical form, parsed by
[`src/type-ref.ts`](./src/type-ref.ts). `schemaHash` covers the SDL printed by
[`src/sdl.ts`](./src/sdl.ts) (import-free, shared with the runtime), byte-identical to graphql-js
`printSchema()` of the schema the plugin builds. `groups` (the shape of RFC 0001's
`extensions.http.groups`) is emitted only when a group is required or holds several keys.

`invoke` maps the graphql-js arguments to the method parameters: `@Args('x')` → `a['x']`,
`@Args()` → `a`, `@Parent()` → `p`, `@Ctx()` → `c`, `@Info()` → `i`, `@Loader()` →
`c.loader(token)`, a custom parameter decorator (`createParamDecorator`, RFC 0010) →
`(D.resolvers.graphql as ParamFunctionOf<typeof D, 'graphql'>)(f, data)` or `x[i].resolve(f, data)`
(evaluated like a validated argument: synchronous while the resolvers return values). Unused middle parameters are `_`-prefixed and trailing ones omitted, so the code
type-checks with `noUnusedParameters`. It calls these runtime helpers, kept stable:

- `validateArgs(schema, value, label)`, exported from `@znight/graphql`: validates an argument with
  a Standard Schema and returns its output, synchronously when the schema validates synchronously
  (a promise otherwise); a failure is a `GraphQLException` `BAD_USER_INPUT` whose
  `extensions.issues` lists `{ path, message }`; a value that is not a Standard Schema v1 is a
  `TypeError`. `label` is the argument name, or `'arguments'` for `@Args(Schema)` without name.
  The generated code calls the method directly and resumes in an `async` arrow only when
  `isThenable()` (exported from `@znight/http`) says so:

  ```ts
  // generated
  ;(r: BookResolver, _p: unknown, a: GraphQLArgs) => {
    const v0 = validateArgs(NewBookInput, a['input'], 'input')
    if (isThenable(v0)) return (async () => r.addBook((await v0) as never))()
    return r.addBook(v0 as never)
  }
  ```

- `GraphQLContext.loader(token)`: the DataLoader of the current execution (one operation, or one
  subscription event) for a loader provider token, with no class lookup.

Everything else in the section is data the plugin interprets at boot: it checks the section
structurally (version, roots, names, kinds, type references, positions, bindings, discriminators,
scalars, groups), builds the schema with graphql-js constructors (every type passed in metadata
order, defaults as `default: { value }`), runs graphql-js schema validation, and fails with one
ZNIGHT066 error listing every problem. Null handling (`nullAsUndefined`) is applied before
`invoke`, by normalisers built at boot only for the fields that need one. Hand-written metadata is
accepted.

The extension is deterministic: types sorted by name (code-unit order), fields in declaration order
with field resolvers after the properties, enum values in declaration order, the same output in
`build` and `serve`, from sources or `dist`. Guards (`@UseGuard`) and loaders (`Loader<L>`) are
bound with lazy edges (no ZNIGHT003). The extension imports no `graphql`, `dataloader` nor runtime
entry; of `@znight/http` it only imports `@znight/http/compiler` (`readRouteMeta`,
`effectiveRouteMeta`, `requiredRouteGroups`). In schema-first mode only, it loads
`graphql/language`, `graphql/type` and `graphql/utilities` lazily (never the executor). Interfaces
are emitted by schema-first only: code-first sections, hashes and artifacts are unchanged.

## Limitations

- **Code-first maps no TypeScript type to a GraphQL interface**: unions cover polymorphic results
  (the schema-first mode supports interfaces). No custom directives, no `@oneOf`.
- Schema-first: no `__resolveType` methods (return objects carrying `__typename`, or classes), no
  custom internal enum values (an enum value is its SDL name).
- **Subscriptions over SSE only.** No `graphql-ws` (WebSocket), no SSE single connection mode, no
  multipart subscriptions.
- **Drivers**: the built-in transport and GraphQL Yoga (`@znight/graphql/yoga`); Apollo Server once it
  accepts graphql-js 17. Yoga plugins that replace the execution (`useGraphQlJit`) are refused.
- No `@defer` / `@stream`, no persisted or trusted documents, no query cost analysis, no response
  cache, no federation or schema stitching, no file uploads (use an HTTP upload route), no operation
  batching.
- `MemoryPubSub` serves one process; a multi-instance `PubSub` is the application's (`pubsub`
  option, Redis recipe in the guide).
- Types must be written: the compiler reads annotations, it never infers return or property types.
- The SDL artifact and `schemaHash` see the `description` and `specifiedByURL` of a
  `ScalarDefinition` written as literals only; a graphql-js `GraphQLScalarType` (`graphql-scalars`)
  is printed without them at build time, so its runtime `printSchema()` may differ.
- `@znight/observability` observes operations, not resolvers: resolver-level tracing is planned on
  graphql-js tracing channels.
- Two concurrent `plugin.execute()` calls inside one request scope share the scope's
  `GraphQLContext` entry: `@Ctx()` always gets its own operation, a `GraphQLContext` injected
  through DI sees the latest.
- graphql-js 17.0 creates and aborts an `AbortController` per execution, which costs about 3 µs on
  Node.js (0.4 µs on Bun); bare graphql-js pays it too.
