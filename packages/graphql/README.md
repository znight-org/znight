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
`@znight/graphql/testing`).

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
- [Plugin options](#plugin-options)
- [GraphQL over HTTP and SSE](#graphql-over-http-and-sse)
- [Security defaults and limits](#security-defaults-and-limits)
- [Testing](#testing)
- [The generated SDL and the compiler options](#the-generated-sdl-and-the-compiler-options)
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

`PubSub<Events>` is an injectable abstract class (singleton, provided by `GraphQLPlugin`), where
`Events` maps topics to payload types:

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
- Several instances need a shared implementation (Redis, a broker): pass any object with
  `publish(topic, payload)` and `subscribe(topic, { signal })` as the `pubsub` option.
- `subscribe()` ends when its `signal` aborts: the client left, the application shuts down, or the
  stream reached `subscriptions.maxDuration`. Always pass `ctx.signal`.
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
| `transport`                       | `'http'`, `'sse'` or `'direct'` (`plugin.execute()` / `subscribe()`)                                                 |
| `http`                            | The `HttpContext` of the request, `undefined` for direct executions outside a request                                |
| `operationType` / `operationName` | `'query'`, `'mutation'` or `'subscription'`; the selected operation name                                             |
| `document` / `variables`          | The parsed document (shared by the document cache: never mutate it) and the coerced variables                        |
| `signal`                          | Over HTTP, the request's `ctx.signal`: client gone, SSE stream closed; passed to graphql-js as `abortSignal`         |
| `state`                           | A `Map` for per-operation storage                                                                                    |
| `loader(Class \| token)`          | The DataLoader of the current execution for a loader                                                                 |

- Resolvers receive it with `@Ctx()`; request-scoped providers inject `GraphQLContext`, singletons
  `Lazy<GraphQLContext>`, exactly like `HttpContext`.
- The context is not a bag for user data: the authenticated user is a request-scoped provider
  filled by a guard (see [Authorization](#authorization)).
- Over HTTP, one request scope per HTTP request, which carries exactly one operation (no batching).
  `plugin.execute()` and `plugin.subscribe()` run in the current scope when one is active (a
  controller calling GraphQL), otherwise in a scope of their own.

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
   `{ message, locations, path, extensions: { ...extensions, code } }`;
2. the `errorMappers`, in order (synchronous: `map(error, ctx)`; the first exception wins, a mapper
   that throws is logged and skipped);
3. an `HttpException` of `@znight/http` is mapped by status: a `ValidationException` is
   `BAD_USER_INPUT` with `extensions.issues`, 400 `BAD_USER_INPUT`, 401 `UNAUTHENTICATED`, 403
   `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`, 429 `TOO_MANY_REQUESTS`, another 4xx `BAD_REQUEST`,
   5xx masked;
4. anything else is masked as `Unexpected error.` with `INTERNAL_SERVER_ERROR`, and logged once at
   `error` level with the request id, the schema coordinate, the path and the cause (with
   `exposeErrors: true`, the original message is sent).

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
| `exposeErrors`  | `false`                                                                | Unmasked messages for unexpected errors (development)                                                                                                                    |
| `introspection` | `NODE_ENV !== 'production'`                                            | Off: graphql-js `NoSchemaIntrospectionCustomRule`, and suggestions are hidden                                                                                            |
| `graphiql`      | `NODE_ENV === 'development'`                                           | `GET path` with `accept: text/html` serves GraphiQL                                                                                                                      |
| `limits`        | `{ maxTokens: 2000, maxDepth: 12, maxAliases: 30, maxDirectives: 50 }` | Request limits (introspection fields exempt from `maxDepth`); `false` disables one                                                                                       |
| `documentCache` | `1000`                                                                 | Distinct documents kept parsed and validated (LRU); `0` disables                                                                                                         |
| `subscriptions` | `{ maxActive: 10_000, bufferSize: 100 }`                               | `false` disables subscriptions over SSE. `heartbeat` (ms or `false`) and `maxDuration` (ms) are passed to `HttpResponse.sse()` (default: the `HttpPlugin` `sse` options) |
| `pubsub`        | a `MemoryPubSub`                                                       | The `PubSub` provided to the container                                                                                                                                   |
| `enforcement`   | `'error'`                                                              | How the boot check of field decisions reports a problem: `'error'` fails the boot (ZNIGHT023), `'warn'` logs                                                             |

`HttpPlugin` must be registered unless `http: false` (ZNIGHT066). The plugin instance exposes:

| Member                         | What                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                       | The graphql-js `GraphQLSchema` (after bootstrap)                                                                                  |
| `printSchema()`                | Its SDL (graphql-js `printSchema`), byte-identical to the compiler's SDL artifact                                                 |
| `execute(request, options?)`   | A query or mutation outside of HTTP; returns the result directly when every resolver is synchronous (`await` it)                  |
| `subscribe(request, options?)` | A stream of results, one per event, until the source ends, `options.signal` aborts, `return()` is called or the application stops |
| `pubsub`                       | The `PubSub` of the application                                                                                                   |
| `activeSubscriptions`          | Active subscriptions, every transport                                                                                             |
| `initRoots()` / `httpRoutes()` | The `PluginInitRoots` contract (`TestApp`) and the `PluginHttpRoutes` contract of `@znight/http`                                  |

`request` is `{ query, operationName?, variables?, extensions? }`; `options` is `{ signal?,
requestId? }`. A direct execution has no HTTP guards.

```ts
const plugin = app.getPlugin<GraphQLPlugin>('graphql')
const result = await plugin?.execute({ query: '{ books { total } }' })
```

`onStart` logs `GraphQL endpoint ready` with the path, the number of types and the schema hash
(`GraphQL schema ready` with `http: false`). On shutdown, `onStop` ends the direct subscriptions;
`HttpPlugin` drains the requests in flight and closes the SSE streams (their `ctx.signal` aborts with
`'shutdown'`, then the stream ends with a jittered `retry` and **no** `complete` event, so clients
reconnect to another instance). Plugin order does not matter.

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
| A subscription without `accept: text/event-stream`     | 400, with a hint                                                       |
| `accept` that lists none of the produced types         | 406                                                                    |

The `accept` header picks the answer: `application/graphql-response+json` when listed (200 with
`data`, 400 for parse, validation, variable and limit errors), otherwise `application/json` (200 for
every well-formed request; no `accept` header, `*/*` and `application/*` mean `application/json`),
or `text/event-stream` for GraphQL over SSE (distinct connections mode, any operation): one `next`
event per result, then `complete`. The stream is RFC 0006's `HttpResponse.sse()` with the
`subscriptions` options (`heartbeat`, `maxDuration`): a client that leaves aborts `ctx.signal` and
ends the source, a stream closed by the shutdown ends without `complete`, and past
`subscriptions.maxActive` a new subscription is 503. An asynchronous query whose client leaves is
aborted (graphql-js `abortSignal`). The endpoint passes the `serverAudits()` of `graphql-http` on
the four adapters, on Node.js and Bun.

Adapters need nothing specific. With Express, do not mount `express.json()` before Znight routes
(the body would be consumed). In tests, `TestApp.inject()` runs queries and mutations through every
adapter in memory and `injectStream()` / `injectSse()` stream subscriptions.

## Security defaults and limits

- **Introspection** off in production (`NODE_ENV === 'production'`), and suggestions hidden with it
  (`hideSuggestions`), so validation errors do not leak field names. graphql-js 17's
  `MaxIntrospectionDepthRule` is always on.
- **Error masking** on: unexpected errors are `Unexpected error.` unless `exposeErrors`.
- **Limits**: `maxTokens` (2 000) is passed to `parse`; `maxDepth` (12, introspection fields exempt),
  `maxAliases` (30) and `maxDirectives` (50) are checked in one pass before the validation rules, so
  an abusive document is rejected before the expensive rules run (`QUERY_TOO_COMPLEX`).
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
  guards then). It resolves once the subscription is started; its `next({ timeoutMs? })` rejects
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

An invalid option is a `TypeError` when `znight.config.ts` is loaded. The SDL artifact is
byte-identical to graphql-js `printSchema()` of the schema the plugin builds (descriptions on one
line print as `"""text"""`), types sorted by name. Commit it: every pull request then shows its
schema diff, and `znight generate --check` fails when it is stale. Without the option,
`plugin.printSchema()` gives the same text at runtime.

## Observability

Every operation goes through the `graphql:operation` hook of `@znight/core` (`GraphQLOperationEvent`:
`operationType`, `operationName`, `documentId` (SHA-256 of the query text), `transport`,
`requestId`, `context`, `startTime`, then `outcome` (`success`, `partial`, `error`, `rejected`) and
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

The endpoint is an HTTP route, so `@znight/observability` already logs, measures and traces it like
any request (route `/graphql`). Per-operation spans and metrics in `@znight/observability` are not
implemented yet: use the hook.

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
  pipeline in process (`GET` and `POST`, both JSON media types), next to bare graphql-js and to a
  controller route answering a constant. `ABORT_REASON=1` removes the cost graphql-js 17.0 adds to
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
  | { kind: 'object'; name: string; description?: string; fields: GraphQLFieldDefinition[] }
  | { kind: 'input'; name: string; description?: string; fields: GraphQLInputFieldDefinition[] }
  | { kind: 'enum'; name: string; description?: string; values: GraphQLEnumValueDefinition[] }
  | { kind: 'union'; name: string; description?: string; members: string[]; discriminator: GraphQLDiscriminator }
  | { kind: 'scalar'; name: string; description?: string; builtin: true } // DateTime, BigInt, JSON
  | { kind: 'scalar'; name: string; scalar: ScalarDefinition<unknown> | GraphQLScalarType } // imported from user code

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
  invoke: (resolver, parent, args: GraphQLArgs, context: GraphQLContext, info: GraphQLResolveInfo) => unknown
}
```

Type references are strings in graphql-js' canonical form, parsed by
[`src/type-ref.ts`](./src/type-ref.ts). `schemaHash` covers the SDL printed by
[`src/sdl.ts`](./src/sdl.ts) (import-free, shared with the runtime), byte-identical to graphql-js
`printSchema()` of the schema the plugin builds. `groups` (the shape of RFC 0001's
`extensions.http.groups`) is emitted only when a group is required or holds several keys.

`invoke` maps the graphql-js arguments to the method parameters: `@Args('x')` → `a['x']`,
`@Args()` → `a`, `@Parent()` → `p`, `@Ctx()` → `c`, `@Info()` → `i`, `@Loader()` →
`c.loader(token)`. Unused middle parameters are `_`-prefixed and trailing ones omitted, so the code
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
`effectiveRouteMeta`, `requiredRouteGroups`).

## Limitations

- **No GraphQL interfaces** in this version: unions cover polymorphic results. No custom
  directives, no `@oneOf`.
- **Subscriptions over SSE only.** No `graphql-ws` (WebSocket), no SSE single connection mode, no
  multipart subscriptions.
- No `@defer` / `@stream`, no persisted or trusted documents, no query cost analysis, no response
  cache, no federation or schema stitching, no file uploads (use an HTTP upload route), no operation
  batching.
- `MemoryPubSub` serves one process; a multi-instance `PubSub` is the application's (`pubsub`
  option).
- Types must be written: the compiler reads annotations, it never infers return or property types.
- The SDL artifact and `schemaHash` see the `description` and `specifiedByURL` of a
  `ScalarDefinition` written as literals only; a graphql-js `GraphQLScalarType` (`graphql-scalars`)
  is printed without them at build time, so its runtime `printSchema()` may differ.
- `@znight/observability` has no GraphQL-specific spans or metrics yet (the HTTP request is
  observed); resolver-level tracing is planned on graphql-js tracing channels.
- Two concurrent `plugin.execute()` calls inside one request scope share the scope's
  `GraphQLContext` entry: `@Ctx()` always gets its own operation, a `GraphQLContext` injected
  through DI sees the latest.
- graphql-js 17.0 creates and aborts an `AbortController` per execution, which costs about 3 µs on
  Node.js (0.4 µs on Bun); bare graphql-js pays it too.
