# RFC 0005: GraphQL (`@znight/graphql`)

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Deferred to v0.2                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Date     | 2026-10-27                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Affects  | New `@znight/graphql`; `@znight/compiler` (type shapes, alias provenance, lazy edges, extra outputs); `@znight/http` (routes contributed by plugins); `@znight/core` (one hook, error codes ZNIGHT050–056); `@znight/testing`, `@znight/observability`, `@znight/cli`; docs; examples. Builds on RFC 0001 (route decision groups), RFC 0003 (route metadata outside controllers) and RFC 0006 (SSE, `ctx.signal`, `EventChannel`) |
| Decision | **Ship `@znight/graphql` in v0.1, code-first only.** The compiler derives the GraphQL schema from TypeScript types at build time. Runtime on graphql-js 17, served by Znight's own GraphQL-over-HTTP transport mounted on `HttpPlugin`, subscriptions over SSE (`HttpResponse.sse`), DataLoader batching per execution, access control with the same route decorators and guards as HTTP                                          |

## 1. Summary

`@znight/graphql` brings GraphQL to Znight the Znight way: **the TypeScript types are the schema**.
Resolvers are ordinary providers marked with `@Resolver`, `@Query`, `@Mutation`, `@Subscription`
and `@ResolveField`. The compiler extension reads their signatures and follows every type they
reach (classes, interfaces, type aliases, enums, literal unions, generics, unions) to produce the
complete schema at build time, with its descriptions and deprecations taken from JSDoc. There is no
`@ObjectType`, no `@Field(() => Int)`, no `reflect-metadata` and no SDL file to keep in sync.

What only a compile-time framework can offer:

1. **Schema errors at build time.** `Uint8Array` reached from a query, two types named `Review`, a
   type used as both input and output, a union that cannot be told apart at runtime, a field
   resolver without parent, a loader with the wrong key type: each is a `ZNIGHT05x` diagnostic with
   a code frame and the path from the root field (`Query.book → Book.cover`).
2. **Zero schema construction cost at boot.** The generated metadata holds the type graph as data
   and one precompiled `invoke` arrow per resolver, like `@znight/http` routes. The runtime builds
   the `GraphQLSchema` with graphql-js constructors (no SDL parsing, no reflection).
3. **DI everywhere.** Resolvers, guards, loaders and error mappers are providers, bound and
   scope-checked by the compiler (ZNIGHT001, ZNIGHT003). Request-scoped providers work in resolvers
   exactly as in controllers.
4. **One transport for every adapter.** The endpoint is a route contributed to `HttpPlugin`, so it
   runs on the node, Fastify, Express and Hono adapters, on Node.js and Bun, through the same
   pipeline as controllers: request scope, request ids, `http:request` hooks, HTTP guards, CORS and
   security headers (RFC 0001), body limits, `ctx.signal` and SSE streams (RFC 0006), graceful
   drain.
5. **One access-control vocabulary.** `@Public()`, `@Roles([...])` made with `createRouteDecorator`
   work on controllers, WebSocket gateways (RFC 0003) and resolvers alike, with RFC 0001's
   deny-by-default groups checked at build time; one guard class can protect all three.

v0.1 ships queries, mutations, field resolvers, input types with Standard Schema validation,
enums, custom scalars, unions, generic object types, DataLoader batching, subscriptions over
Server-Sent Events, field-level guards, error masking and mapping, DoS limits, an operation hook
for observability and test helpers.
GraphQL interfaces, WebSocket subscriptions, `@defer`/`@stream`, trusted documents, cost analysis
and federation are v0.2 (§15).

## 2. What exists today (checked against the code)

| Fact                                                                                                                                                                                                 | Where                                                                                                                  | Consequence                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extensions receive `ClassInfo` (typed constructor params, methods with params and return types, properties) and the `Project` (`lookupIdentity`, `resolveType`, `evaluate`, `heritageOf`, `getFile`) | `packages/compiler/src/extensions/api.ts`                                                                              | Resolver signatures are fully available. Types reached from them must be walked by the extension                                                  |
| `TypeInfo` expands type aliases and makes object literal, mapped and recursive types opaque. Interfaces and enums stay references, without members                                                   | `packages/compiler/src/project/types.ts`, `type-resolver.ts:329`, architecture §4.4                                    | `type BookPage = Page<Book>` loses its name, `type Sort = 'a' \| 'b'` loses its name, interface members are not modelled: prerequisites C1 and C2 |
| The parser keeps comments (`SourceFile.comments`)                                                                                                                                                    | `packages/compiler/src/project/source-file.ts:26`                                                                      | Descriptions and `@deprecated` can come from JSDoc                                                                                                |
| There are no per-extension compiler options, but an explicit `extensions` entry wins over the discovered extension of the same name                                                                  | `packages/compiler/src/options.ts:60`, architecture §6.5                                                               | The extension is configured with `graphql.configure({ ... })` in `znight.config.ts`, no compiler change needed                                    |
| `HttpPlugin` registers only the routes of `extensions.http.controllers`                                                                                                                              | `packages/http/src/plugin.ts:485-494` (`httpMetadata`, `buildRegistrations`)                                           | Another plugin cannot add a route today: prerequisite H1                                                                                          |
| A handler may return a Web `Response`; a stream body is tracked and the request scope lasts until it is read or cancelled                                                                            | `packages/http/src/serialize.ts:63`, `pipeline.ts:291`                                                                 | SSE subscriptions fit the existing pipeline: the scope, the in-flight count and the drain cover them                                              |
| HTTP decorators on a class without `@Controller` are ZNIGHT005; a class owned by another extension gets a dedicated hint                                                                             | `packages/http/src/compiler/analyze.ts:153`                                                                            | GraphQL needs its own `@UseGuard` / `@Ctx`, like `@znight/messaging` has its own `@Headers` / `@Ctx`                                              |
| Extension edges count for ZNIGHT003: "a singleton controller using a request-scoped guard is reported"                                                                                               | architecture §6.5 (**Impl.**), `packages/compiler/src/validation/scopes.ts:3`                                          | A request-scoped loader used by a singleton resolver would be a false ZNIGHT003: prerequisite C3                                                  |
| `TestApp` boots only the closure of controllers and consumers, read structurally                                                                                                                     | `packages/testing/src/extensions.ts:80-94`                                                                             | Resolvers would be created on demand (async dependencies fail): add `extensions.graphql`                                                          |
| Hook event types live in `@znight/core` so that observers do not depend on producers                                                                                                                 | `packages/core/src/hooks.ts:18-30`                                                                                     | `graphql:operation` and its event go into core                                                                                                    |
| ZNIGHT022 is the last code; RFC 0001 takes ZNIGHT023. RFC 0003 (websocket) and RFC 0004 (schedule), written in parallel, **both** claim ZNIGHT030–039                                                | `packages/core/src/errors.ts:49`, `rfcs/0001-security.md` §5.7, `rfcs/0003-websocket.md` §6.3, `rfcs/0004-schedule.md` | Blocks are allocated by RFC number: 0003 → 030–039, 0004 → 040–049, this RFC → **ZNIGHT050–059** (§6.6)                                           |
| RFC 0003 widens `RouteDecorator.get()` to any `RouteMetaCarrier` (`{ route?: { meta } }`) and makes `readRouteMeta` / `requiredRouteGroups` public in `@znight/http/compiler`                        | `rfcs/0003-websocket.md` §6.4, §8.2.4                                                                                  | Resolvers reuse route decorators and RFC 0001 groups instead of a GraphQL-only factory                                                            |
| RFC 0006 adds `HttpResponse.sse()` on any method, `ctx.signal` on every route, a graceful SSE shutdown, `EventChannel` and `injectSse()`, and lists what a GraphQL-over-SSE transport needs from it  | `rfcs/0006-http-cookies-sse.md` §4.6–4.12, §8                                                                          | The SSE transport is a thin layer over `HttpResponse.sse()`; the in-memory PubSub is an `EventChannel` per subscriber                             |

Ecosystem, October 2026. Versions marked (cache) were read from the local Bun install cache
(`~/.bun/install/cache`) on 2026-10-26; nothing GraphQL-related is installed in this repository.
Versions marked (knowledge) come from my knowledge and must be checked before pinning.

| Library                                     | Version            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graphql` (graphql-js)                      | 17.0.2 (cache)     | Stable v17: `engines` Node.js 22, 24 and later, a `bun` export condition, `abortSignal` and `hideSuggestions` in `execute`/`validate`, `maxTokens` in `parse`, `executeSubscriptionEvent`, incremental delivery (`@defer`/`@stream`), `node:diagnostics_channel` tracing channels (`graphql:parse`, `graphql:validate`, `graphql:execute`, `graphql:resolve`, `graphql:subscribe`). 16.14.0 (cache) is the maintained 16 line |
| `dataloader`                                | 2.2.3 (cache)      | Zero dependencies, batches on `process.nextTick` (Bun has it)                                                                                                                                                                                                                                                                                                                                                                 |
| `graphql-yoga`                              | 5.22.0 (cache)     | Peer `graphql ^15.2 \|\| ^16 \|\| ^17`; built on `@envelop/core` 5.6.0 (cache) and `@whatwg-node/server`                                                                                                                                                                                                                                                                                                                      |
| `@apollo/server`                            | 5.5.1 (cache)      | Node-centric, integrations per framework                                                                                                                                                                                                                                                                                                                                                                                      |
| `graphql-ws`                                | 6.2.1 (cache)      | Peer `graphql ^15.10.1 \|\| ^16 \|\| ^17`, needs a WebSocket server (`ws`, `crossws`, `@fastify/websocket`)                                                                                                                                                                                                                                                                                                                   |
| `graphql-scalars`                           | 1.25.0 (cache)     | Peer still `^16`; works with v17 through the deprecated `serialize`/`parseValue`/`parseLiteral` (removed in v18)                                                                                                                                                                                                                                                                                                              |
| `graphql-http`                              | 1.22.x (knowledge) | Reference GraphQL-over-HTTP implementation; its `serverAudits()` is a conformance suite we can run against our endpoint                                                                                                                                                                                                                                                                                                       |
| `graphql-sse`                               | 2.5.x (knowledge)  | GraphQL over SSE protocol ("distinct connections mode") and a client usable in tests                                                                                                                                                                                                                                                                                                                                          |
| Grats                                       | 0.0.x (knowledge)  | Closest prior art: derives a schema from TypeScript + JSDoc tags with the TypeScript compiler API                                                                                                                                                                                                                                                                                                                             |
| Pothos, TypeGraphQL 2, `@nestjs/graphql` 13 | (knowledge)        | Builder API / decorators with `reflect-metadata` / decorators + `reflect-metadata` + a CLI plugin that adds metadata from the AST                                                                                                                                                                                                                                                                                             |

## 3. Goals and non-goals

### Goals (v0.1)

- **Code-first, derived at build time.** Resolver signatures and the types they reach define the
  schema. Diagnostics point at the TypeScript source.
- **No duplication.** Domain interfaces can be exposed as they are. Descriptions, deprecations and
  defaults come from JSDoc. Escape hatches (`@gqlHidden`, `@gqlName`) are JSDoc tags, so they work
  on interfaces too.
- **Fast.** No schema construction work at boot beyond graphql-js constructors, a document cache
  (parse and validate once per distinct query), synchronous `invoke` unless validation is needed,
  guards only where declared, per-execution batching.
- **Easy.** One plugin line in `main.ts`, a working endpoint on `/graphql`, GraphiQL in
  development, `executeOperation()` in tests.
- **Modular.** `@znight/graphql` is optional and depends only on `@znight/core`, `@znight/http`,
  `dataloader` and the `graphql` peer. The schema and an `execute()` API are exposed for custom
  transports (`http: false`).
- **Secure defaults.** Error masking, introspection off in production, token, depth, alias and
  directive limits, no batching, CSRF-safe content types, deny-by-default access decisions when the
  application declares a required group.
- **Node.js 24 and Bun 1.3**, ESM only, every HTTP adapter.

### Non-goals (v0.1)

- Schema-first development (SDL files implemented by resolvers). The SDL is an **output** (§6.7).
- GraphQL interfaces (unions cover polymorphic results in v0.1), custom directives, `@oneOf`.
- `@defer` / `@stream` (graphql-js 17 supports them; v0.2).
- WebSocket subscriptions (`graphql-ws`), SSE "single connection mode", Apollo multipart
  subscriptions (P2, §11 Q6).
- Federation, schema stitching, GraphQL gateways. One schema per application.
- Persisted or trusted documents, query cost analysis, response caching, `graphql-jit`.
- File uploads (GraphQL multipart request spec): use an HTTP upload route.
- Operation batching (arrays of operations).
- Distributed PubSub (Redis, `@znight/messaging` fan-out). The `PubSub` contract is pluggable.
- Inferring types that are not written: resolver return types, property types and parameter types
  must be annotated (inference from bodies is not part of the compiler).

## 4. Key decisions

| #   | Decision                                                                                                                                                                           | Why                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Code-first only, schema derived from TypeScript types reachable from resolvers                                                                                                     | It is the feature runtime-reflection frameworks cannot offer. TypeScript already has nullability, lists, enums, unions and generics; asking for `@Field(() => Int)` would duplicate them                                                    |
| D2  | `graphql` **17** as a required peer (`^17.0.2`), no 16 support                                                                                                                     | Abort signals, hidden suggestions, `executeSubscriptionEvent`, tracing channels, incremental delivery for v0.2. Znight is new: no legacy users to carry. Yoga, graphql-ws and graphql-tools already accept 17                               |
| D3  | Znight's own GraphQL-over-HTTP transport, mounted as a route of `HttpPlugin`                                                                                                       | Every adapter and runtime at once, one pipeline (scopes, hooks, guards, CORS, limits, drain), no second plugin system, two runtime dependencies. Yoga stays possible with `http: false` (§11 Q2)                                            |
| D4  | Subscriptions over SSE (GraphQL over SSE, distinct connections mode) in v0.1, written with RFC 0006's `HttpResponse.sse()`                                                         | Plain HTTP: works through the same route, adapters, proxies and HTTP/2, needs no WebSocket server. Heartbeats, `ctx.signal`, backpressure and graceful shutdown come from RFC 0006. `graphql-ws` comes in v0.2 on RFC 0003's upgrade routes |
| D5  | Batching with DataLoader, one cache per **execution** (per operation, per subscription event), loaders are providers injected with `@Loader()`                                     | Correct caching for subscriptions (no stale cache across events), compile-time binding of loaders, loader classes testable with mocks                                                                                                       |
| D6  | Field access control reuses `createRouteDecorator` (RFC 0001 groups, RFC 0003 `RouteMetaCarrier`) and GraphQL guards (`GraphQLGuard.canResolve`, `@UseGuard`, `static enforces`)   | One vocabulary and one guard class for controllers, gateways and resolvers (`canActivate`, `canHandle`, `canResolve` side by side, like RFC 0003's `WsGuard`). The endpoint itself keeps the HTTP guards                                    |
| D7  | The TypeScript annotation is the GraphQL type; a Standard Schema validates and transforms argument **values**                                                                      | Schemas are runtime values the compiler never executes; zod-inferred types are opaque. GraphQL already validates shapes, so ZNIGHT017 does not apply                                                                                        |
| D8  | Mapping rules are explicit, no renaming magic: TS names are GraphQL names, a type used as input and output is an error with a fix-it, anonymous object types and unions are errors | Predictable schemas, reviewable diffs. Relaxing an error later is not a breaking change                                                                                                                                                     |

## 5. User-facing API

### 5.1 Install and bootstrap

```sh
bun add @znight/graphql graphql
```

```ts
// src/main.ts
import { ConfigPlugin } from '@znight/config'
import { Application } from '@znight/core'
import { GraphQLPlugin } from '@znight/graphql'
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'
import { ObservabilityPlugin } from '@znight/observability'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { Public } from './auth/access.js'
import { AccessGuard } from './auth/access.guard.js'
import { AuthenticationGuard } from './auth/authentication.guard.js'
import { ServerConfig } from './config/server.config.js'
import { CatalogErrorMapper } from './shared/catalog-error.mapper.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    ObservabilityPlugin.configure(),
    ConfigPlugin.configure(),
    HttpPlugin.configure(c => ({
      adapter: honoAdapter(),
      port: c.get(ServerConfig).port,
      // identify the caller, then decide: on every HTTP request, /graphql included
      guards: [AuthenticationGuard, AccessGuard],
    })),
    GraphQLPlugin.configure(c => ({
      guards: [AccessGuard], // the same guard decides per GraphQL field
      http: { meta: { [Public.key]: true } }, // the endpoint itself is open
      errorMappers: [CatalogErrorMapper],
      exposeErrors: c.get(ServerConfig).exposeErrors,
    })),
  ],
})
await app.start() // POST /graphql, GET /graphql (queries, GraphiQL in development), SSE subscriptions
```

`@znight/graphql/compiler` is discovered like the other extensions as soon as the code imports
`@znight/graphql`. Nothing else to configure.

### 5.2 Types are the schema

```ts
// src/catalog/book.ts
import type { ID, Int } from '@znight/graphql'

/** A book of the catalog. */
export interface Book {
  readonly kind: 'book'
  readonly id: ID
  readonly title: string
  readonly isbn: string
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
  readonly born: Int | null
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

`ID`, `Int`, `Float` and `JSONValue` are plain aliases exported by `@znight/graphql`
(`type ID = string`, `type Int = number`...): values need no cast, and the compiler recognises
the alias (prerequisite C2). Nothing in this file imports a decorator.

### 5.3 Resolvers

```ts
// src/catalog/book.resolver.ts
import type { Lazy } from '@znight/core'
import type { CurrentUser } from '../auth/current-user.js'
import type { Author, Book, Genre, Page } from './book.js'
import type { BookFilter } from './book.args.js'
import type { CatalogEvents } from './catalog.events.js'
import type { CatalogService } from './catalog.service.js'

import {
  Args,
  Ctx,
  type GraphQLContext,
  type ID,
  Loader,
  Mutation,
  Parent,
  type PubSub,
  Query,
  ResolveField,
  Resolver,
  Subscription,
} from '@znight/graphql'

import { Authenticated, Public, Roles } from '../auth/access.js'
import { AuthorsById } from './authors-by-id.loader.js'
import { NewBookInput } from './book.inputs.js'

@Resolver()
@Public() // default access decision of every field of this class
export class BookResolver {
  constructor(
    private readonly catalog: CatalogService,
    private readonly events: PubSub<CatalogEvents>,
    private readonly user: Lazy<CurrentUser>,
  ) {}

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

  /** Adds a book to the catalog. */
  @Mutation()
  @Roles(['editor']) // replaces the class decision
  async addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<Book> {
    const book = await this.catalog.add(input, this.user.get().principal.name)
    await this.events.publish('bookAdded', book)
    return book
  }

  /** Who wrote the book. Batched: one repository call per execution, whatever the number of books. */
  @ResolveField()
  author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
  }

  /** Books added from now on, optionally of one genre. */
  @Subscription()
  @Authenticated()
  async *bookAdded(@Args('genre') genre: Genre | undefined, @Ctx() ctx: GraphQLContext): AsyncGenerator<Book> {
    for await (const book of this.events.subscribe('bookAdded', { signal: ctx.signal })) {
      if (genre === undefined || book.genre === genre) yield book
    }
  }
}
```

- `@Resolver({ scope? })` registers the class as a provider (singleton by default). A class is the
  provider of one extension: `@Resolver` and `@Controller` on the same class is ZNIGHT005.
- Root field names default to the method name (`@Query('allBooks')` renames). Field resolvers add
  or replace a field of the type of their `@Parent()` parameter, which is mandatory.
- Methods are not inherited: decorated methods of a base class are ZNIGHT052 (like HTTP routes).
- Explicit return types are required (ZNIGHT050 otherwise): the compiler does not infer.

### 5.4 Arguments and validation

```ts
// src/catalog/book.args.ts
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
  /** @default 0 */
  readonly offset?: Int
}
```

```ts
// src/catalog/book.inputs.ts
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
  readonly tags?: readonly string[] | undefined
}

export const NewBookInput = z.object({
  title: z.string().trim().min(1).max(200),
  isbn: z
    .string()
    .transform(isbn => isbn.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^(?:\d{9}[\dX]|\d{13})$/)),
  authorId: z.string().min(1),
  genre: z.enum(Genre), // receives the internal value ('fantasy'), GraphQL already mapped the name
  publishedYear: z.number().int().min(-3000).nullish(),
  tags: z.array(z.string().trim().toLowerCase()).max(10).optional(),
}) satisfies StandardSchemaV1<unknown, NewBookInput>
```

`@Args()` without name spreads the properties of the parameter type into arguments
(`books(search: String, genre: Genre, sort: BookSort = title, limit: Int = 20, offset: Int = 0)`).
`@Args('name')` declares one argument. `@Args('input', Schema)` or `@Args(Schema)` validates the
value with any Standard Schema after GraphQL coerced it; the resolver receives the schema output and
a failure is a `BAD_USER_INPUT` error listing the issues. A TypeScript default value
(`@Args('limit') limit: Int = 20`) becomes the schema default when it is statically evaluable.

GraphQL `null` versus `undefined`: an argument or input property whose TypeScript type does not
accept `null` (`limit?: Int`) receives `undefined` when the client sends `null`. Types that accept
`null` receive it as is. The resolver therefore always gets values of its declared type.

### 5.5 Batching with loaders

```ts
// src/catalog/authors-by-id.loader.ts
import { Injectable } from '@znight/core'
import { type BatchLoad, type ID, orderByKeys } from '@znight/graphql'

import type { Author } from './book.js'
import { AuthorRepository } from './author.repository.js'

@Injectable()
export class AuthorsById implements BatchLoad<ID, Author> {
  /** Optional, read once per loader: DataLoader options. */
  readonly options = { maxBatchSize: 100 }

  constructor(private readonly authors: AuthorRepository) {}

  async load(ids: readonly ID[]): Promise<readonly (Author | Error)[]> {
    const found = await this.authors.findMany(ids)
    return orderByKeys(ids, found, author => author.id) // a missing id → NotFound error for that key
  }
}
```

- A loader is a provider implementing `BatchLoad<K, V>`. `@Loader() authors: Loader<AuthorsById>`
  injects the `DataLoader` of the **current execution**: created on first use, cached for the
  operation (or for one subscription event), then dropped. Loaders may be request-scoped.
- `GraphQLContext.loader(AuthorsById)` gives the same instance to services called by a resolver.
- The compiler binds `AuthorsById` like a constructor dependency (ZNIGHT001 when it is not a
  provider) and checks that it implements `BatchLoad` (ZNIGHT055).

### 5.6 Subscriptions

A `@Subscription` method returns an `AsyncIterable<T>` (an async generator, or
`pubsub.subscribe(...)`); each value is the field value of one event. The client subscribes with an
SSE request:

```sh
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' -H 'x-api-key: ...' \
  -d '{"query":"subscription { bookAdded(genre: Fantasy) { title author { name } } }"}' \
  http://localhost:3000/graphql
# event: next
# data: {"data":{"bookAdded":{"title":"The Hobbit","author":{"name":"J. R. R. Tolkien"}}}}
```

```ts
// src/catalog/catalog.events.ts
import type { Book } from './book.js'

/** Topics of the application PubSub and their payloads. */
export interface CatalogEvents {
  bookAdded: Book
  reviewAdded: { readonly bookId: string; readonly rating: number }
}
```

`PubSub<Events>` is injectable (provided by `GraphQLPlugin`, in-memory by default). Each subscriber
is an RFC 0006 `EventChannel` with a bounded buffer (`subscriptions.bufferSize`, default 100
events, `overflow: 'close'`): a subscriber that falls behind gets a final `SUBSCRIPTION_OVERFLOW`
error and its stream ends, rather than losing events silently or buffering without bound.
`subscribe()` ends when its `signal` aborts (client gone, shutdown, `maxDuration`).

### 5.7 Unions, generics and custom scalars

```ts
// src/search/search.ts
import type { Author, Book } from '../catalog/book.js'

/** A search hit: told apart at runtime by `kind`, found by the compiler. */
export type SearchResult = Book | Author
```

```ts
// in a @Resolver() class
@Query()
search(@Args('text') text: string): Promise<readonly SearchResult[]> {
  return this.index.search(text)
}
// → search(text: String!): [SearchResult!]!   union SearchResult = Author | Book
```

The compiler picks the runtime discriminator: `instanceof` when every member is a class, otherwise a
property whose literal type differs in every member (`kind` here, or `__typename`). Neither is
ZNIGHT054.

Generic object types are named after their type arguments: `Page<Book>` is `BookPage`,
`Page<Edge<Book>>` is `BookEdgePage`. A named alias wins: `export type BookList = Page<Book>`
names it `BookList`.

```ts
// src/shared/scalars.ts
import { scalar } from '@znight/graphql'
import { GraphQLURL } from 'graphql-scalars'

/** An e-mail address, lower-cased. */
export type EmailAddress = string & { readonly __brand: 'EmailAddress' }

export const EmailAddressScalar = scalar<EmailAddress>('EmailAddress', {
  description: 'An e-mail address',
  specifiedByURL: 'https://html.spec.whatwg.org/#valid-e-mail-address',
  serialize: value => value,
  parseValue: value => {
    if (typeof value !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(value)) throw new TypeError('Expected an e-mail address')
    return value.toLowerCase() as EmailAddress
  },
})

/** URLs are `URL` objects in TypeScript and strings on the wire. */
export const UrlScalar = scalar<URL>('URL', GraphQLURL)
```

`scalar<T>(name, definition)` maps the TypeScript type `T` (here a branded alias, or the global
`URL`) to a GraphQL scalar everywhere it appears. `name` is static; the definition is an exported
value imported by the generated module (`{ serialize, parseValue, parseLiteral? }` or a
`GraphQLScalarType`). Built-in scalars: `String`, `Float`, `Int`, `ID`, `Boolean`, `DateTime`
(`Date`, RFC 3339 with offset), `BigInt` (`bigint`, a decimal string on the wire) and `JSON`
(`JSONValue`). Built-ins appear in the schema only when used.

### 5.8 Context and injection

```ts
// what GraphQLContext exposes (request-scoped external, @znight/graphql#GraphQLContext)
export interface GraphQLContext {
  readonly requestId: string
  readonly transport: 'http' | 'sse' | 'direct'
  readonly http: HttpContext | undefined // the HTTP request carrying the operation
  readonly operationType: 'query' | 'mutation' | 'subscription'
  readonly operationName: string | undefined
  readonly document: DocumentNode
  readonly variables: Readonly<Record<string, unknown>>
  /**
   * Over HTTP, the request's `ctx.signal` (RFC 0006): client gone, SSE stream closed on shutdown or
   * `maxDuration`. Passed to graphql-js as `abortSignal`. Direct executions get the plugin's own.
   */
  readonly signal: AbortSignal
  /** Per-operation storage. */
  readonly state: Map<string | symbol, unknown>
  /** The DataLoader of the current execution for a loader class. */
  loader<L extends BatchLoad<any, any>>(loader: abstract new (...args: never[]) => L): Loader<L>
}
```

- Resolvers receive it with `@Ctx()`; any request-scoped provider can inject `GraphQLContext`
  (singletons inject `Lazy<GraphQLContext>`), exactly like `HttpContext`.
- The GraphQL context is **not** a bag for user data. The authenticated user is a request-scoped
  provider (`CurrentUser`) filled by a guard, as in the rest-api example.
- `@Info()` injects graphql-js `GraphQLResolveInfo` (escape hatch).

Scopes: over HTTP, one request scope per HTTP request, which carries exactly one operation (no
batching). For a subscription the scope lasts as long as the SSE stream: request-scoped providers
live for the subscription, while loaders are renewed for every event. `plugin.execute()` outside of
a request opens its own scope.

### 5.9 Authorization

Nothing GraphQL-specific to learn: the route decorators of `@znight/http` (with RFC 0001's groups)
apply to resolver classes and methods, and one guard class can serve HTTP routes, WebSocket
gateways (RFC 0003 `WsGuard.canHandle`) and GraphQL fields (`GraphQLGuard.canResolve`).

```ts
// src/auth/access.ts — shared by controllers, gateways and resolvers
import { createRouteDecorator } from '@znight/http'

export type Role = 'reader' | 'editor' | 'admin'

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
```

```ts
// src/auth/authentication.guard.ts — HTTP: identifies the caller when credentials are sent
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly keys: ApiKeys,
    private readonly user: Lazy<CurrentUser>,
  ) {}

  canActivate(ctx: HttpContext): boolean {
    const key = ctx.header('x-api-key')
    if (key !== undefined) this.user.get().authenticate(this.keys.verify(key)) // 401 for an unknown key
    return true // decisions are AccessGuard's
  }
}
```

```ts
// src/auth/access.guard.ts — decides, for HTTP routes and for GraphQL fields
import { Injectable, type Lazy } from '@znight/core'
import type { GraphQLGuard, ResolverContext } from '@znight/graphql'
import type { CanActivate, HttpContext, RouteMetaCarrier } from '@znight/http'

import { Authenticated, Public, Roles } from './access.js'
import type { CurrentUser } from './current-user.js'

@Injectable()
export class AccessGuard implements CanActivate, GraphQLGuard {
  /** RFC 0001: this guard enforces the "access" group, on routes and on root fields. */
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
  http: { meta: { [Public.key]: true } }, // the endpoint is open: decisions are taken per field
})
```

- **The endpoint** is an HTTP route: the global HTTP guards run on it, `http.meta` / `http.guards`
  give it route metadata and guards, and with a required group it needs a decision like any route
  (RFC 0001 boot check).
- **Fields**: decisions follow RFC 0001 §5.1 and §5.2: decorators of a group are alternatives, the
  method's decision replaces the class's, a `required` group must be decided on every **root field**
  (ZNIGHT023 at build time), and every decided group must be enforced by a guard of the field's
  chain (`static enforces`, checked at boot).
- `ResolverContext` satisfies RFC 0003's `RouteMetaCarrier`: `route: { meta, coordinate }` (effective
  metadata, schema coordinate `Query.books`), plus `operation` (`GraphQLContext`), `parentType`,
  `field`, `args`, `parent`, `info` and `http`.
- Guards run in order: global (`GraphQLPlugin.configure({ guards })`), class `@UseGuard`, method
  `@UseGuard`. `false` is a `FORBIDDEN` error on that field; a thrown error is mapped (§8.8).
- Global guards run on **root fields** and on **field resolvers that carry their own metadata** (a
  route decorator on the method or on its class). A field resolver without metadata is covered by
  the decision of the root field the selection descends from: authorization happens at entry points.
  Plain property fields never run guards.
- Guards run once per resolver call: a guard on a field resolver of a list runs once per item.
  Keep them cheap (decisions on `CurrentUser`, no I/O).

### 5.10 Errors

```ts
// src/shared/catalog-error.mapper.ts
import { Injectable } from '@znight/core'
import { GraphQLException, type GraphQLErrorMapper } from '@znight/graphql'

import { BookNotFoundError, DuplicateIsbnError } from '../catalog/errors.js'

@Injectable()
export class CatalogErrorMapper implements GraphQLErrorMapper {
  map(error: unknown): GraphQLException | undefined {
    if (error instanceof BookNotFoundError) {
      return new GraphQLException(error.message, { code: 'NOT_FOUND', extensions: { bookId: error.bookId } })
    }
    if (error instanceof DuplicateIsbnError) return new GraphQLException(error.message, { code: 'CONFLICT' })
    return undefined
  }
}
```

Resolution order for every error of `errors[]` (normative, §8.8): `GraphQLException` as is →
mappers in order → `HttpException` of `@znight/http` mapped by status (400 `BAD_USER_INPUT`, 401
`UNAUTHENTICATED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`, 429 `TOO_MANY_REQUESTS`,
other 4xx `BAD_REQUEST`, 5xx masked) → anything else masked as `Unexpected error.` with
`INTERNAL_SERVER_ERROR`, logged once with the request id, the path and the cause (unless
`exposeErrors`). Codes follow the Apollo conventions that clients already understand.

### 5.11 Plugin options

`GraphQLPlugin.configure(options | (container) => options)`, name `graphql`, options evaluated
once, on first need (§8.2).

| Option          | Default                                                                | Description                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`          | `'/graphql'`                                                           | Route path, joined with the `HttpPlugin` prefix                                                                                                                                                                        |
| `http`          | `{}`                                                                   | `false`: no HTTP transport (schema and `execute()` only). Object: `{ meta?, guards?, bodyLimit = '100kb', get = true }` (route metadata and guards, body limit, queries over GET)                                      |
| `guards`        | `[]`                                                                   | Global GraphQL guards (classes or instances)                                                                                                                                                                           |
| `errorMappers`  | `[]`                                                                   | `GraphQLErrorMapper` classes or instances, tried in order                                                                                                                                                              |
| `exposeErrors`  | `false`                                                                | Unmasked messages for unexpected errors (development)                                                                                                                                                                  |
| `introspection` | `NODE_ENV !== 'production'`                                            | Off: `NoSchemaIntrospectionCustomRule`, and suggestions are hidden (`hideSuggestions`)                                                                                                                                 |
| `graphiql`      | `NODE_ENV === 'development'`                                           | `GET path` with `accept: text/html` serves GraphiQL (pinned CDN version, its own CSP)                                                                                                                                  |
| `limits`        | `{ maxTokens: 2000, maxDepth: 12, maxAliases: 30, maxDirectives: 50 }` | Request limits (introspection fields exempt from `maxDepth`); each accepts `false`                                                                                                                                     |
| `documentCache` | `1000`                                                                 | Distinct documents kept parsed and validated (LRU); `0` disables                                                                                                                                                       |
| `subscriptions` | `{ maxActive: 10_000, bufferSize: 100 }`                               | `false` disables SSE. Active subscriptions cap (503 beyond), per-subscriber buffer of `MemoryPubSub`, and `heartbeat` / `maxDuration` passed to `HttpResponse.sse()` (default: `HttpPlugin`'s `sse` options, RFC 0006) |
| `pubsub`        | `new MemoryPubSub()`                                                   | The `PubSub` implementation provided to the container                                                                                                                                                                  |

The instance exposes `schema` (`GraphQLSchema`, after bootstrap), `printSchema()`,
`execute(request)`, `subscribe(request)`, `activeSubscriptions`, `initRoots()` (classes of the
global guards and mappers: the `PluginInitRoots` contract) and `httpRoutes()` (H1).

### 5.12 Testing

Resolvers are providers: `TestBed` unit-tests them with auto-mocks.

```ts
// test/book.resolver.test.ts
import { expect, test } from 'bun:test'
import { fakeLoader } from '@znight/graphql/testing'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { AuthorsById } from '../src/catalog/authors-by-id.loader.js'
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

Operations run through the whole stack with `TestApp` and `@znight/graphql/testing`:

```ts
// test/support/app.ts
import { ConfigPlugin, inline } from '@znight/config'
import { GraphQLPlugin } from '@znight/graphql'
import { HttpPlugin } from '@znight/http'
import { TestApp, type TestAppOptions } from '@znight/testing'

import { __ZNIGHT_METADATA__ } from '../../src/.znight/container.generated.js'
import { Public } from '../../src/auth/access.js'
import { AccessGuard } from '../../src/auth/access.guard.js'
import { AuthenticationGuard } from '../../src/auth/authentication.guard.js'
import { CatalogErrorMapper } from '../../src/shared/catalog-error.mapper.js'

export const EDITOR_KEY = 'editor-key'
export const READER_KEY = 'reader-key'

export function createTestApp(options: Partial<TestAppOptions> = {}): Promise<TestApp> {
  return TestApp.create({
    metadata: __ZNIGHT_METADATA__,
    plugins: [
      ConfigPlugin.configure({ loaders: [inline({ EDITOR_API_KEY: EDITOR_KEY, READER_API_KEY: READER_KEY })] }),
      HttpPlugin.configure({ port: 0, guards: [AuthenticationGuard, AccessGuard] }),
      GraphQLPlugin.configure({
        guards: [AccessGuard],
        http: { meta: { [Public.key]: true } },
        errorMappers: [CatalogErrorMapper],
      }),
    ],
    ...options,
  })
}
```

```ts
// test/books.graphql.test.ts
import { expect, spyOn, test } from 'bun:test'
import { executeOperation, subscribeOperation } from '@znight/graphql/testing'

import { AuthorRepository } from '../src/catalog/author.repository.js'
import { createTestApp, EDITOR_KEY, READER_KEY } from './support/app.js'

const BOOKS = /* GraphQL */ `
  query Books($genre: Genre) {
    books(genre: $genre, limit: 2) { total items { title author { name } } }
  }
`
const ADD_DUNE = /* GraphQL */ `
  mutation { addBook(input: { title: "Dune", isbn: "9780441013593", authorId: "a1", genre: ScienceFiction }) { id } }
`

test('lists books with their authors in a single batch', async () => {
  await using app = await createTestApp()
  const findMany = spyOn(app.get(AuthorRepository), 'findMany')
  const res = await executeOperation(app, { query: BOOKS, variables: { genre: 'Fantasy' } }) // enum names on the wire
  expect(res.status).toBe(200)
  expect(res.errors).toBeUndefined()
  expect(res.data).toMatchSnapshot()
  expect(findMany).toHaveBeenCalledTimes(1) // no N+1
})

test('addBook needs the editor role', async () => {
  await using app = await createTestApp()
  const res = await executeOperation(app, { query: ADD_DUNE, headers: { 'x-api-key': READER_KEY } })
  expect(res.errors?.[0]?.extensions?.['code']).toBe('FORBIDDEN')
})

test('bookAdded streams new books', async () => {
  await using app = await createTestApp()
  const events = await subscribeOperation(app, {
    query: 'subscription { bookAdded { title } }',
    headers: { 'x-api-key': READER_KEY },
  })
  await executeOperation(app, { query: ADD_DUNE, headers: { 'x-api-key': EDITOR_KEY } })
  expect((await events.next()).value).toEqual({ data: { bookAdded: { title: 'Dune' } } })
  await events.return()
})
```

- `executeOperation(app, { query, variables?, operationName?, headers? })` sends a POST through
  `app.inject()` (whole HTTP pipeline, every adapter) and resolves with `{ status, headers, data,
  errors, extensions }`. Without HTTP transport it calls `plugin.execute()`.
- `subscribeOperation()` streams in memory through RFC 0006's `TestApp.injectSse()` (whole HTTP
  pipeline, no socket) and parses the `next` / `complete` events into execution results; without
  HTTP transport it calls `plugin.subscribe()` (no HTTP guards). It returns an async iterator whose
  `next()` times out (2 s by default) and whose `return()` disconnects (the server sees a client
  abort: `ctx.signal`, then the source's `return()`).
- `fakeLoader<L>(values | fn)` builds a `Loader<L>` whose `load` / `loadMany` are spies.
- `TestApp` boots the resolvers, their guards and loaders (prerequisite T1), so async dependencies
  are created at boot.

### 5.13 The generated SDL

With `graphql.configure({ sdl: 'schema.graphql' })` in `znight.config.ts` (§6.7), the compiler writes the
schema next to the generated module, and `znight generate --check` fails when it is stale. Commit it:
every pull request then shows its schema diff.

```graphql
type Author {
  kind: String!
  id: ID!
  name: String!
  born: Int
}

"""
A book of the catalog.
"""
type Book {
  kind: String!
  id: ID!
  title: String!
  isbn: String!
  """
  Year of first publication, `null` when unknown.
  """
  publishedYear: Int
  genre: Genre!
  tags: [String!]!
  createdAt: DateTime!
  category: String @deprecated(reason: "Use `tags`.")
  """
  Who wrote the book. Batched: one repository call per execution, whatever the number of books.
  """
  author: Author!
}

type BookPage {
  items: [Book!]!
  total: Int!
  hasMore: Boolean!
}

"""
Sort orders of the book list.
"""
enum BookSort {
  title
  newest
}

scalar DateTime @specifiedBy(url: "https://datatracker.ietf.org/doc/html/rfc3339")

"""
Literary genres.
"""
enum Genre {
  Fantasy
  ScienceFiction
  Mystery
}

type Mutation {
  """
  Adds a book to the catalog.
  """
  addBook(input: NewBookInput!): Book!
}

"""
A new book. The interface is the GraphQL input type, the schema of the same name validates it.
"""
input NewBookInput {
  title: String!
  isbn: String!
  authorId: String!
  genre: Genre!
  publishedYear: Int
  tags: [String!]
}

type Query {
  """
  Books of the catalog, filtered and paginated.
  """
  books(
    """
    Case-insensitive search in titles.
    """
    search: String
    genre: Genre
    sort: BookSort = title
    limit: Int = 20
    offset: Int = 0
  ): BookPage!
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

type Subscription {
  """
  Books added from now on, optionally of one genre.
  """
  bookAdded(genre: Genre): Book!
}
```

### 5.14 Catalogue

`static` = statically evaluable, `value` = evaluable or a reference to an exported binding
(architecture §4.6).

| Export                                                                                   | Kind                            | Arguments / notes                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@Resolver(opts?)`                                                                       | class decorator                 | static `{ scope? }`                                                                            |
| `@Query(name?)` `@Mutation(name?)` `@Subscription(name?)`                                | method decorators               | static name; one root field per decorator                                                      |
| `@ResolveField(name?)`                                                                   | method decorator                | static name; needs a `@Parent()` parameter                                                     |
| `@Args(nameOrSchema?, schema?)`                                                          | parameter decorator             | value, value (like `@Param` of `@znight/http`)                                                 |
| `@Parent()` `@Ctx()` `@Info()` `@Loader()`                                               | parameter decorators            | parent object, `GraphQLContext`, `GraphQLResolveInfo`, the DataLoader of `Loader<L>`           |
| `@UseGuard(...guards)`                                                                   | class / method decorator        | rest value (guard classes)                                                                     |
| `createRouteDecorator` decorators of `@znight/http`                                      | class / method of a `@Resolver` | RFC 0001 groups; read with `Decorator.get(ctx: ResolverContext)` (RFC 0003 `RouteMetaCarrier`) |
| `scalar<T>(name, definition)`                                                            | function                        | `T` read by the compiler, `name` static, `definition` value; the `const` must be exported      |
| `ID` `Int` `Float` `JSONValue`                                                           | type aliases                    | recognised by identity                                                                         |
| `Loader<L>` `BatchLoad<K, V>` `LoaderOptions`                                            | types                           | `Loader<L>` is a `DataLoader<K, V>` view                                                       |
| `GraphQLContext` `ResolverContext` `GraphQLGuard` `GraphQLErrorMapper`                   | types                           | `GraphQLGuard.canResolve(ctx)`, `GraphQLErrorMapper.map(error, ctx)`                           |
| `GraphQLPlugin` `GraphQLTokens` `GraphQLException` `PubSub` `MemoryPubSub` `orderByKeys` | values                          | `PubSub` is an abstract class, injectable                                                      |
| `@znight/graphql/testing`: `executeOperation` `subscribeOperation` `fakeLoader`          | test helpers                    |                                                                                                |

JSDoc vocabulary, read on classes, interfaces, aliases, enums, their members and on resolver
methods:

| Tag / text           | On                                               | Effect                                                                     |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| Comment text         | type, property, enum member, resolver method     | `description`                                                              |
| `@param name text`   | resolver method                                  | description of the argument `name`                                         |
| `@deprecated reason` | property, enum member, resolver method, argument | `@deprecated(reason:)` (on arguments and input fields: only when nullable) |
| `@default value`     | property of an args or input type                | default value (a JSON literal checked against the type, ZNIGHT053)         |
| `@gqlHidden`         | property, getter                                 | not part of the GraphQL type                                               |
| `@gqlName Name`      | type declaration                                 | GraphQL name of the type (P1)                                              |

## 6. Compile-time analysis and validations

### 6.1 Extension pipeline

`@znight/graphql/compiler` follows the extension contract (§6.5 of the architecture): it only
`import type`s from `@znight/compiler` and, like `@znight/websocket/compiler` (RFC 0003 §6.4), may
import the runtime-free `@znight/http/compiler` for route metadata:

1. **`analyzeClass`** (classes carrying a graphql decorator): registers `@Resolver` classes as
   providers (`ctx.registerProvider(cls, { scope })`); for each decorated method, checks it
   (public, non-static, non-generic, non-computed, explicit return type), reads its parameters,
   binds `@UseGuard` classes (`resolveClassRef(..., { from: cls, role: 'guard' })`) and `Loader<L>`
   parameters (`bindInjection({ type: L }, { from: cls })`, a lazy edge with C3), reads route
   decorators with `readRouteMeta` exported by `@znight/http/compiler` (RFC 0003 §6.4), and stores the
   resolver data. Root and return types are kept as `TypeInfo` with their alias provenance (C2).
2. **`validate`**: builds the **schema model** globally, starting from the root fields and walking
   every reachable type through the shapes API (C1); assigns names, detects conflicts, decides
   input versus output use, discriminators of unions, scalars; checks the access groups; reports
   every diagnostic of §6.6 with the path from a root field as related information. The model is
   memoised per compile (keyed by the compile's `graph` object, shared by `validate` and
   `generate`).
3. **`generate`**: emits `metadata.extensions.graphql` (§7) from the model, with the builders only
   (no raw strings), and the SDL artifact when configured (C4).

Everything after parsing is recomputed on every compile, like the rest of the compiler; files read
through the shapes API are reported in `watchFiles`.

### 6.2 Type mapping (normative)

Output position = resolver return types and fields of object types. Input position = arguments and
fields of input types. `T` below is the type after `Promise<T>` is unwrapped (return types only).

| TypeScript                                                                                    | GraphQL                                                                                | Position                    |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------- |
| `string`, one string literal                                                                  | `String`                                                                               | both                        |
| `number`, one number literal                                                                  | `Float` (option `number: 'Int'` switches the default)                                  | both                        |
| `Int` / `Float` / `ID` (`@znight/graphql`)                                                    | `Int` / `Float` / `ID`                                                                 | both                        |
| `boolean`, `true`, `false`                                                                    | `Boolean`                                                                              | both                        |
| `Date` (global)                                                                               | `DateTime`                                                                             | both                        |
| `bigint`                                                                                      | `BigInt`                                                                               | both                        |
| `JSONValue` (`@znight/graphql`)                                                               | `JSON`                                                                                 | both                        |
| type `T` of a `scalar<T>(name, ...)` declaration (by alias identity, else by serialized type) | scalar `name`                                                                          | both                        |
| TypeScript `enum` (string or numeric members)                                                 | enum, names = member names, internal values = member values                            | both                        |
| named alias of a union of string literals (`type BookSort = 'title' \| 'newest'`)             | enum named after the alias, names = values = the literals                              | both                        |
| class, interface, named alias of an object literal type or of an intersection of those        | object type (output) or input object type (input)                                      | both                        |
| generic instance (`Page<Book>`)                                                               | object or input type named `<arguments><Name>` (`BookPage`), or the alias name         | both                        |
| `Partial` `Required` `Readonly` `Pick` `Omit` of a named object type (P1)                     | object or input type; needs a named alias (`type BookChanges = Partial<NewBookInput>`) | both                        |
| named alias of a union of object types                                                        | union                                                                                  | output                      |
| `T[]` `readonly T[]` `Array<T>` `ReadonlyArray<T>`                                            | `[T]`                                                                                  | both                        |
| `Set<T>` `ReadonlySet<T>` `Iterable<T>`                                                       | `[T]`                                                                                  | output                      |
| `AsyncIterable<T>` `AsyncGenerator<T>` `AsyncIterableIterator<T>` (also inside `Promise`)     | the field type `T`                                                                     | `@Subscription` return only |
| `T \| null`, `T \| undefined`, optional property or parameter                                 | nullable `T`                                                                           | both                        |
| anything else                                                                                 | **ZNIGHT050**                                                                          |                             |

Non-null is the default: a type without `null`/`undefined`/`?` is `T!`, and list items follow the
same rule (`readonly (Book | null)[]` is `[Book]!`). Rejected with ZNIGHT050, each with a hint:
`any`, `unknown`, `object`, `{}`, `never`, `void` (mutations must return something: a payload type
or `boolean`), `symbol`, functions, tuples, `Map`, `Record` and index signatures (hint `JSONValue`),
`Uint8Array`/`Blob`/`File` (hint: a URL, or a `scalar<Uint8Array>('Base64', ...)`), unions mixing
scalars or scalars and objects (`string | number`), anonymous object types and anonymous unions
(hint: name them), unresolved or opaque types, `Promise` outside a return type, async iterables
outside `@Subscription`.

### 6.3 Object, input and argument types

- **Fields of an object type**: public, non-static properties (constructor parameter properties
  included), getters, and the members of analysable base classes or extended interfaces, in
  declaration order (base members first). Methods, function-typed properties, `#private`,
  `private`/`protected`, symbol and computed keys and `@gqlHidden` members are left out. A
  `@ResolveField` with the same name replaces the property field (it must map to the same GraphQL
  type, otherwise ZNIGHT051); other field resolvers are appended, ordered by resolver token then
  source order.
- **Input types** take the same members except getters (a getter in an input is ZNIGHT053). Input
  types cannot contain unions, sets or async iterables; a cycle of non-null input fields is
  ZNIGHT053 (GraphQL forbids it).
- **Input or output, not both.** A declaration reached in both positions is ZNIGHT053 with the fix
  "declare `interface MoneyInput extends Money {}` for the input". Generic instances count per
  instance.
- **Args objects** (`@Args() filter: BookFilter`) are not GraphQL types: their properties become
  arguments of the field. Mixing `@Args()` and `@Args('x')` is allowed when names differ (ZNIGHT051).
- **Defaults**: `@default` tags and statically evaluable parameter defaults, checked against the
  argument type (ZNIGHT053). They appear in the SDL and graphql-js applies them.
- **Reachability**: only types reachable from root fields are emitted. A `@ResolveField` whose
  parent type is not reachable is a ZNIGHT052 warning. An application with resolvers but no
  `@Query` is ZNIGHT052 (GraphQL requires a query root).

### 6.4 Naming (normative)

- A type's GraphQL name is its declaration name, or the name of the alias the annotation goes
  through, or `@gqlName`. Generic instances without alias: the names of the type arguments
  (themselves named by these rules; `[T]` arguments are ZNIGHT050) followed by the declaration
  name.
- Root types are `Query`, `Mutation`, `Subscription`. User types with these names, names starting
  with `__`, and names that are not GraphQL names (`/^[_A-Za-z][_0-9A-Za-z]*$/`, enum values `true`,
  `false`, `null`) are ZNIGHT051.
- Two declarations (different identities) with one GraphQL name are ZNIGHT051, both locations shown.
  Two root fields with one name across resolver classes are ZNIGHT051.
- No case conversion happens anywhere: enum member names, literal values and property names are
  used as written.

### 6.5 Resolvers

- Parameters must carry exactly one graphql parameter decorator; an undecorated parameter, or one
  decorated with `@znight/http`'s `Ctx`/`Query` (look-alikes), is ZNIGHT005 with the import to use.
- `@Parent()`: field resolvers only, exactly one, its type must map to an object type (the parent).
- `@Loader()`: the type must be `Loader<L>` with `L` bound to a provider implementing
  `BatchLoad<K, V>` (ZNIGHT055, ZNIGHT001). When the parameter type is written `Loader<L>`, the
  generated code passes the loader with a cast, and TypeScript checks the resolver's use of it.
- `@Subscription` methods return an async iterable (ZNIGHT052 otherwise).
- Route decorators (`createRouteDecorator` consts of `@znight/http`) on a `@Resolver` class or on a
  resolver method are read with `readRouteMeta` (RFC 0003 §6.4), so the rules are exactly HTTP's:
  RFC 0001 §5.1 (one decision per group per target, consistent options, the method's decision
  replaces the class's). A root field without a decision of a group returned by
  `requiredRouteGroups` is **ZNIGHT023**, the code HTTP routes and gateways use. If RFC 0001 is not
  accepted, decisions are plain keys and there is no required check; if RFC 0003 is not accepted,
  this RFC makes the same two `@znight/http/compiler` exports (H3).
- A resolver class in a compiled provider library (`library: true`) is ZNIGHT052: publish it as a
  source library (the schema needs the sources).

### 6.6 Diagnostics

**Code range.** Codes ZNIGHT001–ZNIGHT029 stay framework-wide (core, compiler, http, messaging,
config; RFC 0001 takes ZNIGHT023, RFC 0006 adds none). From ZNIGHT030 on, each new feature package
receives a **block of ten consecutive codes**, recorded in architecture §4.8 and in `ErrorCode`.
RFCs 0003 and 0004 were written at the same time and both claim ZNIGHT030–039, so blocks are
allocated **in RFC number order**: `@znight/websocket` (RFC 0003) ZNIGHT030–039, `@znight/schedule`
(RFC 0004) ZNIGHT040–049, **`@znight/graphql` (this RFC) ZNIGHT050–059** (050–056 used, 057–059
reserved). Only RFC 0004 has to renumber; the owner confirms the rule when accepting these RFCs.

| Code      | Name (`ErrorCode`)         | Meaning                                                                                                                                                                                                                          | Severity        | When           |
| --------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------- |
| ZNIGHT050 | `InvalidGraphQLType`       | A TypeScript type cannot be mapped to a GraphQL type (§6.2), or a resolver lacks the annotation it needs                                                                                                                         | error           | build          |
| ZNIGHT051 | `GraphQLNameConflict`      | Two declarations or root fields share a GraphQL name, an invalid or reserved name, a field resolver conflicting with a property field, duplicate argument names                                                                  | error           | build, startup |
| ZNIGHT052 | `InvalidResolver`          | Resolver structure: `@ResolveField` without `@Parent()`, subscription not returning an async iterable, no `@Query` in the application, inherited handlers, resolvers in compiled libraries; unreachable field resolver (warning) | error / warning | build          |
| ZNIGHT053 | `InvalidGraphQLInput`      | Input position: a type used as input and output, getters, unions, non-null input cycles, defaults not matching their type                                                                                                        | error           | build          |
| ZNIGHT054 | `UnresolvableAbstractType` | Members of a union cannot be told apart at runtime (no class, no literal discriminant, no `__typename`)                                                                                                                          | error           | build          |
| ZNIGHT055 | `InvalidLoader`            | `@Loader()` on a type that is not `Loader<L>`, `L` not implementing `BatchLoad`, a batch function returning a different number of values than keys (runtime)                                                                     | error           | build, runtime |
| ZNIGHT056 | `InvalidGraphQLSetup`      | Boot: malformed or version-skewed `extensions.graphql`, graphql-js `assertValidSchema` failure, invalid `GraphQLPlugin` options, missing `HttpPlugin` with the HTTP transport, scalar name mismatch                              | error           | startup        |

Reused codes: ZNIGHT001 (resolver dependency, guard or loader without provider), ZNIGHT003 (a
singleton resolver depending on a request-scoped provider; hint `Lazy<T>`), ZNIGHT005 (decorator
target and arguments, applied twice, non-public or static handler, http look-alikes, `@Resolver` on
a controller, unexported scalar or schema), ZNIGHT007 (the GraphQL path collides with an HTTP
route), ZNIGHT010 (unresolvable injection types), ZNIGHT013 (request-scoped provider outside of an
operation), ZNIGHT015, ZNIGHT018 (extension misbehaviour, generated-code syntax), ZNIGHT019
(resolvers are roots), ZNIGHT021 (shutdown), ZNIGHT023 (RFC 0001: missing access decision, at build
time, and unenforced decision, at boot). ZNIGHT017 does not apply: GraphQL validates argument
shapes.

Examples (formatted like every compiler diagnostic):

```text
✗ ZNIGHT050: Cannot map 'Uint8Array' to a GraphQL type (Book.cover)
  --> src/catalog/book.ts:18:19
   |
18 |   readonly cover: Uint8Array | null
   |                   ^^^^^^^^^^
   = hint: Expose a URL (coverUrl: string), hide the property with /** @gqlHidden */, or declare a scalar: export const Base64 = scalar<Uint8Array>('Base64', { ... })
   ::: src/catalog/book.resolver.ts:27:3 reached from Query.book → Book
```

```text
✗ ZNIGHT053: 'Money' is used as an output type (Book.price) and as an input type (Mutation.addBook(input.price))
  --> src/shared/money.ts:3:18
   = hint: GraphQL needs two types: declare `export interface MoneyInput extends Money {}` and use it in NewBookInput
```

```text
✗ ZNIGHT054: The members of union SearchResult cannot be told apart at runtime: Book and Author are interfaces without a common literal property
  --> src/search/search.ts:4:13
   = hint: Add a literal property to each member (readonly kind: 'book' / readonly kind: 'author'), or make the members classes
```

```text
✗ ZNIGHT052: @ResolveField BookResolver.author has no @Parent() parameter
  --> src/catalog/book.resolver.ts:44:3
   = hint: Declare the parent object first: author(@Parent() book: Book, ...)
```

```text
✗ ZNIGHT023: Root field Mutation.deleteBook (BookResolver.deleteBook) has no "access" decision
  --> src/catalog/book.resolver.ts:52:3
   = hint: Add @Public(), @Authenticated() or @Roles(...) to the method or to BookResolver
```

### 6.7 Extension options

There is no per-extension option channel in `ZnightOptions`, and none is needed: the default export
of `@znight/graphql/compiler` is the extension with default options, and its `configure(options)`
method (the `XxxPlugin.configure()` convention) returns a configured copy. Declared in
`extensions`, it replaces the discovered extension of the same name (architecture §6.5).

```ts
// znight.config.ts
import graphql from '@znight/graphql/compiler'
import type { ZnightOptions } from '@znight/compiler'

export default {
  extensions: [graphql.configure({ sdl: 'schema.graphql' })],
} satisfies ZnightOptions
```

| Option   | Default   | Description                                                                                   |
| -------- | --------- | --------------------------------------------------------------------------------------------- |
| `sdl`    | `false`   | Path (relative to the root) of the SDL artifact written by `generate` (needs C4)              |
| `number` | `'Float'` | GraphQL type of `number`. `'Int'` suits applications whose numbers are counts and identifiers |

### 6.8 Compiler prerequisites

All are additive: the extension API stays `apiVersion: 1` (new optional members of the contexts),
and the release-line check (ZNIGHT018) guarantees that `@znight/graphql` runs with a compiler that
has them.

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Priority |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| C1  | **Type shapes API** on the analyze, validate and generate contexts: `ctx.shapes.of(type)` returns the named declaration behind a `TypeInfo` (class, interface, object-literal alias, intersection, enum, literal-union alias) with its members (name, `TypeInfo` with type arguments substituted, optional, readonly, kind property/getter/method, visibility, static, declaring identity, location), enum members with values, inherited members merged, and its documentation (`docs: { text, tags: { name, text }[] }`, the JSDoc block attached to the declaration or member). Also `ctx.shapes.docsOf(method)`. Files read are tracked for `watchFiles`. OpenAPI generation will need the same service | P0       |
| C2  | **Alias provenance**: a `TypeInfo` produced by expanding a named alias (including recursive aliases made opaque and `Partial`/`Pick`...) carries `alias?: { identity, name, typeArgs }`. Non-normative: ignored by `serialize`, `equals` and binding, so DI identities and generated containers do not change (golden tests prove it)                                                                                                                                                                                                                                                                                                                                                                       | P0       |
| C3  | **Lazy extension edges**: `DependencyDetails.lazy` / `{ from, lazy: true }` declares an edge resolved at call time in the current scope (like `Lazy<T>`): it counts for ZNIGHT019 and `prune`, not for ZNIGHT003. Used for loaders and GraphQL guards (and fixes the documented HTTP guard limitation later)                                                                                                                                                                                                                                                                                                                                                                                                | P1       |
| C4  | **Extra outputs**: `GenerateContext.emitFile(relativePath, content)` writes an additional file with the generated module (same rules: only when changed and the compile is ok, atomic writes), listed in `staleFiles` by `generate --check` and ignored by the watchers like the outFile                                                                                                                                                                                                                                                                                                                                                                                                                    | P1       |

Fallback if C1/C2 slip: the extension walks the oxc AST itself through the `Project` it already
receives (`lookupIdentity`, `resolveIdentifier`, `resolveType`, `bindTypeArguments`, `getFile`).
The algorithm is the same; the code then moves into the compiler for v0.2. Without C3, a singleton
resolver may not use request-scoped loaders or guards (ZNIGHT003, documented). Without C4, the SDL
is available through `plugin.printSchema()` and a snapshot test.

## 7. Generated metadata and runtime contract

### 7.1 Shape (`metadata.extensions.graphql`)

```ts
// @znight/graphql (declared in src/metadata.ts, augments ZnightExtensionsMetadata)
interface GraphQLMetadata {
  version: 1 // format of this section (ZNIGHT056 when unsupported)
  schemaHash: string // first 16 hex characters of the SHA-256 of the SDL: logs, caches, v0.2 trusted documents
  roots: { query: string; mutation?: string; subscription?: string }
  types: GraphQLTypeDefinition[] // sorted by name
}

type GraphQLTypeDefinition =
  | { kind: 'object'; name: string; description?: string; fields: GraphQLFieldDefinition[] }
  | { kind: 'input'; name: string; description?: string; fields: GraphQLInputFieldDefinition[] }
  | { kind: 'enum'; name: string; description?: string; values: GraphQLEnumValueDefinition[] }
  | { kind: 'union'; name: string; description?: string; members: string[]; discriminator: GraphQLDiscriminator }
  | { kind: 'scalar'; name: string; description?: string; builtin: true } // DateTime, BigInt, JSON
  | { kind: 'scalar'; name: string; scalar: ScalarDefinition | GraphQLScalarType } // imported from user code

interface GraphQLFieldDefinition {
  name: string
  type: string // GraphQL type reference: 'Book!', '[Book!]!', 'Int'
  description?: string
  deprecationReason?: string
  args?: GraphQLArgumentDefinition[]
  resolver?: GraphQLResolverBinding // absent: graphql-js default resolver (parent[name])
}

interface GraphQLArgumentDefinition {
  name: string
  type: string
  description?: string
  deprecationReason?: string
  defaultValue?: unknown // literal emitter value (JSON-compatible, enum values as their GraphQL names)
  nullAsUndefined?: true // the TypeScript type does not accept null (§5.4)
}

interface GraphQLInputFieldDefinition extends GraphQLArgumentDefinition {}

interface GraphQLEnumValueDefinition {
  name: string
  value: string | number // internal value
  description?: string
  deprecationReason?: string
}

type GraphQLDiscriminator =
  | { by: 'property'; property: string; values: Record<string, string> } // literal value → member name
  | { by: 'class'; classes: [Constructor, string][] } // subclasses first
  | { by: 'typename' }

interface GraphQLResolverBinding {
  token: Token // resolver provider
  method: string
  operation: 'query' | 'mutation' | 'subscription' | 'field'
  guards: Token[] // class guards, then method guards
  meta: Record<string, unknown> // effective field metadata (method over class, one decision per group)
  loaders?: Token[] // informational: loaders injected by the method
  invoke: (
    resolver: any,
    parent: unknown,
    args: GraphQLArgs,
    context: GraphQLContext,
    info: GraphQLResolveInfo,
  ) => unknown
}
```

`groups` (the key → group table of the route decorators used on resolvers, the shape of RFC 0001's `extensions.http.groups`) is
emitted next to `types` only when a group is required or holds several keys.

### 7.2 Example (excerpt of a generated module)

```ts
import type { GraphQLArgs, GraphQLContext } from '@znight/graphql'
import { validateArgs } from '@znight/graphql'
import { BookResolver } from '../catalog/book.resolver.js'
import { NewBookInput } from '../catalog/book.inputs.js'
import { EmailAddressScalar } from '../shared/scalars.js'

// ...
  extensions: {
    ['graphql']: {
      ['version']: 1,
      ['schemaHash']: '3f1c9a0e5b7d2c44',
      ['roots']: { ['query']: 'Query', ['mutation']: 'Mutation', ['subscription']: 'Subscription' },
      ['types']: [
        {
          ['kind']: 'object',
          ['name']: 'Book',
          ['description']: 'A book of the catalog.',
          ['fields']: [
            { ['name']: 'id', ['type']: 'ID!' },
            { ['name']: 'title', ['type']: 'String!' },
            { ['name']: 'publishedYear', ['type']: 'Int', ['description']: 'Year of first publication, `null` when unknown.' },
            { ['name']: 'createdAt', ['type']: 'DateTime!' },
            { ['name']: 'category', ['type']: 'String', ['deprecationReason']: 'Use `tags`.' },
            {
              ['name']: 'author',
              ['type']: 'Author!',
              ['description']: 'Who wrote the book. Batched: one repository call per execution, whatever the number of books.',
              ['resolver']: {
                ['token']: 'src/catalog/book.resolver.ts#BookResolver',
                ['method']: 'author',
                ['operation']: 'field',
                ['guards']: [],
                ['meta']: { ['public']: true },
                ['loaders']: ['src/catalog/authors-by-id.loader.ts#AuthorsById'],
                ['invoke']: (r: BookResolver, p: unknown, _a: GraphQLArgs, c: GraphQLContext) =>
                  r.author(p as never, c.loader('src/catalog/authors-by-id.loader.ts#AuthorsById') as never),
              },
            },
          ],
        },
        { ['kind']: 'scalar', ['name']: 'DateTime', ['builtin']: true },
        { ['kind']: 'scalar', ['name']: 'EmailAddress', ['scalar']: EmailAddressScalar },
        {
          ['kind']: 'object',
          ['name']: 'Mutation',
          ['fields']: [
            {
              ['name']: 'addBook',
              ['type']: 'Book!',
              ['description']: 'Adds a book to the catalog.',
              ['args']: [{ ['name']: 'input', ['type']: 'NewBookInput!' }],
              ['resolver']: {
                ['token']: 'src/catalog/book.resolver.ts#BookResolver',
                ['method']: 'addBook',
                ['operation']: 'mutation',
                ['guards']: [],
                ['meta']: { ['roles']: ['editor'] },
                ['invoke']: async (r: BookResolver, _p: unknown, a: GraphQLArgs) =>
                  r.addBook(await validateArgs(NewBookInput, a['input'], 'input')),
              },
            },
          ],
        },
        {
          ['kind']: 'union',
          ['name']: 'SearchResult',
          ['members']: ['Author', 'Book'],
          ['discriminator']: { ['by']: 'property', ['property']: 'kind', ['values']: { ['author']: 'Author', ['book']: 'Book' } },
        },
        // ...
      ],
    },
  },
```

### 7.3 Contract rules (normative)

- **Data, not code**, except `invoke`: discriminators, scalars, defaults and null handling are data
  the runtime interprets. `invoke` only maps arguments: `@Args('x')` → `a['x']` (cast), `@Args()` →
  `a`, `@Args(..., S)` → `await validateArgs(S, value, label)` (the arrow is then `async`, otherwise
  synchronous), `@Parent()` → `p`, `@Ctx()` → `c`, `@Info()` → `i`, `@Loader()` →
  `c.loader(token)`. Unused middle parameters are `_`-prefixed, trailing ones omitted, so the code
  type-checks with `noUnusedParameters`.
- **Null handling** is applied by the runtime before `invoke`, from `nullAsUndefined` flags of
  arguments and input fields (a normaliser is built per field at boot, only where needed).
- **Determinism**: types sorted by name; fields in declaration order (base members first), field
  resolvers after properties by resolver token then source order; enum values in declaration
  order; byte-identical output in `build` and `serve`, on every OS, with or without
  `@znight/source` (the golden test covers the example). `schemaHash` derives from the SDL printed
  by the extension's own printer (`src/sdl.ts`, import-free, shared with the runtime).
- **Validation at boot**: the plugin checks the section structurally (version, roots, unique names,
  type references resolvable), builds the schema and runs `assertValidSchema`; any failure is one
  ZNIGHT056 error listing every problem. Hand-written metadata (`defineTestMetadata`) is accepted.
- The section is omitted when the application has no resolver.

### 7.4 Manifest

```jsonc
"znight": {
  "apiVersion": 1,
  "compiler": "@znight/graphql/compiler",
  "provides": [
    { "export": "GraphQLContext", "plugin": "GraphQLPlugin", "scope": "request" },
    { "export": "PubSub", "plugin": "GraphQLPlugin", "scope": "singleton" },
    { "export": "GraphQLPlugin", "plugin": "GraphQLPlugin", "scope": "singleton" }
  ]
}
```

## 8. Runtime architecture

### 8.1 Package layout

```text
packages/graphql/
  src/index.ts              public API (decorators, plugin, types, PubSub, scalar, GraphQLException...)
  src/decorators.ts         no-op markers, scalar
  src/metadata.ts           GraphQLMetadata + module augmentation of ZnightExtensionsMetadata
  src/plugin.ts             GraphQLPlugin (options, lifecycle, httpRoutes, initRoots)
  src/schema.ts             GraphQLSchema from the metadata (graphql-js constructors, thunks for cycles)
  src/execution.ts          document cache, limits, execute / subscribe, per-execution state
  src/pipeline.ts           resolver wrapper: guards → null handling → invoke
  src/loaders.ts            loader registry per execution, orderByKeys
  src/errors.ts             GraphQLException, codes, masking, mappers, formatting
  src/pubsub.ts             PubSub, MemoryPubSub
  src/scalars.ts            DateTime, BigInt, JSON
  src/transport/http.ts     GraphQL over HTTP (POST, GET, negotiation, status codes)
  src/transport/sse.ts      GraphQL over SSE (distinct connections), keep-alive
  src/transport/graphiql.ts GraphiQL page
  src/sdl.ts  src/type-ref.ts   import-free, shared with the compiler
  src/compiler/             index, analyze, shapes walk, naming, validate, generate, field-decorators, model
  src/testing.ts            @znight/graphql/testing
```

Exports: `.`, `./compiler`, `./testing` (with the `@znight/source` / `types` / `default` triple).
Boundaries (tests/boundaries.test.ts): `./compiler` never imports `graphql`, `dataloader` nor the
runtime entry, and of `@znight/http` only `@znight/http/compiler` (as RFC 0003 allows for
`@znight/websocket/compiler`); the runtime never imports `./compiler`.

### 8.2 Plugin lifecycle

| Hook                   | Work                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`             | Refuses a second application while one runs (ZNIGHT004, like `HttpPlugin`). Declares `GraphQLContext` (request external), registers `PubSub` (value: the configured implementation) and the plugin itself. Checks that a plugin named `http` exists unless `http: false` (ZNIGHT056)                                                                                                                                      |
| `httpRoutes(ctx)` (H1) | Called by `HttpPlugin.onBootstrap`, whatever the plugin order: resolves the options (memoised) and returns the GraphQL route (`GET`, `POST` on `path`, with `http.meta`, `http.guards`, `http.bodyLimit`). The handler reads the runtime lazily: requests only arrive after `start()`                                                                                                                                     |
| `onBootstrap`          | Resolves the options (memoised), validates them, builds the schema from `extensions.graphql` (ZNIGHT056 on failure), resolves singleton resolvers, guards and mappers (`Resolvable`s, like HTTP), runs the RFC 0001 `enforces` check on the guard chain of every root field (ZNIGHT023, `enforcement: 'error' \| 'warn'` like HTTP), creates the document cache                                                           |
| `onStart` / `onReady`  | Logs `GraphQL endpoint ready` with the path, the number of types and the schema hash. Nothing listens: `HttpPlugin` does                                                                                                                                                                                                                                                                                                  |
| `onStop`               | Aborts the subscriptions started with `plugin.subscribe()` (direct transport). Everything that came over HTTP is stopped by `HttpPlugin.onStop` (RFC 0006 §4.7): queries and mutations drain, SSE streams get their `ctx.signal` aborted (`'shutdown'`), `shutdownGraceMs` to finish, then end with a jittered `retry` and **without** `complete`, so clients reconnect to another instance. Plugin order does not matter |
| `onDispose`            | Closes the `PubSub` it created (not a user-supplied one), clears the document cache, releases the schema                                                                                                                                                                                                                                                                                                                  |

### 8.3 HTTP integration

**H1, routes contributed by plugins (prerequisite in `@znight/http`, P0).** A duck-typed contract,
like `PluginInitRoots`:

```ts
// @znight/http
export interface HttpRouteProvider {
  /** Called once by HttpPlugin.onBootstrap, after container.init(), for every plugin that has it. */
  httpRoutes(ctx: PluginContext): readonly PluginRoute[]
}
export interface PluginRoute {
  readonly methods: readonly Exclude<HttpMethod, 'ALL'>[]
  readonly path: string // route grammar, joined with the plugin prefix
  readonly name: string // summaries and errors: 'GraphQLPlugin.handle'
  readonly handler: (ctx: HttpContext) => unknown // result serialised like a controller handler's
  readonly meta?: Readonly<Record<string, unknown>>
  readonly guards?: readonly GuardRef[] // after the global guards
  readonly interceptors?: readonly InterceptorRef[]
  readonly bodyLimit?: ByteSize
}
```

Plugin routes go through the whole pipeline (request scope with `HttpContext`/`RequestId`,
`http:request` hooks, global then route guards, interceptors, exception mappers, CORS and security
headers of RFC 0001, drain). `ctx.route.controller` is `plugin:<name>`. They appear in `routes`
(`controller: 'GraphQLPlugin'`), take part in the RFC 0001 boot check, and a collision with a
controller route is ZNIGHT007 at boot. Bodies are read by the handler (`ctx.parseBody()`), so that
malformed requests get GraphQL-shaped errors.

**GraphQL over HTTP (normative, per the GraphQL-over-HTTP specification draft):**

- `POST` with `content-type: application/json` (charset utf-8): `{ query, operationName?,
  variables?, extensions? }`. Any other content type is 415 (CSRF safety: no form or text bodies,
  so cross-site requests are always preflighted). Non-object JSON or a missing `query` is 400.
- `GET` with `query`, `operationName`, `variables` (JSON), `extensions` (JSON): queries only
  (mutations and subscriptions 405 with `allow: POST`), only when `http.get` is on. `GET` with
  `accept: text/html` serves GraphiQL when enabled, 406 otherwise.
- Responses: `application/graphql-response+json` when accepted (status 200 with `data`, 400 for
  parse, validation, variable coercion and limit errors), otherwise `application/json` (status
  200 for every well-formed request). No `accept` header is treated as `application/json`. An
  unacceptable `accept` is 406.
- `accept: text/event-stream` selects SSE for any operation (one `next` event then `complete` for
  queries and mutations). A subscription without SSE is 400 with a hint.
- Operation batching (an array body) is 400.
- Transport errors (body limit 413, aborted body 400) keep the HTTP status and a GraphQL error body.

**SSE (distinct connections mode of the GraphQL over SSE protocol), on RFC 0006.** The handler
returns `HttpResponse.sse(events, { heartbeat, maxDuration })` where `events` maps the execution
results to `{ event: 'next', data: result }` and ends with `{ event: 'complete', data: '' }`.
Everything else is RFC 0006's: the headers (`text/event-stream`, `cache-control: no-cache,
no-transform`, `x-accel-buffering: no`), the immediate first chunk, heartbeats, pull-based
backpressure, the request scope and in-flight count held until the stream ends, the client abort
(`ctx.signal` aborts, the source's `return()` is called, bounded wait), and the graceful close on
shutdown or `maxDuration`. The GraphQL package only negotiates `accept: text/event-stream` and
maps results to events.

If RFC 0006 is not accepted, the package carries its own writer (a Web `Response` over a pull-based
`ReadableStream`, which the pipeline already tracks: `serialize.ts:63`, `pipeline.ts:291`), about
150 lines, with the same behaviour minus `ctx.signal` for non-SSE requests.

**Adapters.** Nothing adapter-specific in `@znight/graphql`:

| Adapter            | Notes                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodeAdapter()`    | Default. SSE chunks are written as they are pulled                                                                                           |
| `fastifyAdapter()` | The route is registered like a controller route; Fastify's body parsers are bypassed on Znight routes                                        |
| `expressAdapter()` | Do not mount `express.json()` before Znight routes (the body would be consumed: explicit 500, as today)                                      |
| `honoAdapter()`    | On Bun, `Bun.serve()` streams the SSE body natively and its `idleTimeout` is lifted while a stream is sent; on Node, `@hono/node-server`     |
| `inject()`         | Queries and mutations through every adapter in memory; subscriptions through `injectSse()` (RFC 0006), since `inject` buffers the whole body |

**Cancellation.** `ctx.signal` (RFC 0006, every route) is passed to graphql-js `abortSignal`, so a
query whose client went away stops resolving (pending resolvers see `GraphQLContext.signal`).

### 8.4 Request flow and scopes

```text
adapter → HttpPlugin pipeline
  runInScope({ HttpContext, RequestId })
  → hooks.run('http:request') → global HTTP guards → http.guards → interceptors
  → GraphQL handler
      negotiate (method, content type, accept) → read body (≤ http.bodyLimit)
      → document cache: parse (maxTokens) + validate (specified rules + limits [+ no introspection]) once per query text
      → seed GraphQLContext into the current scope
      → hooks.run('graphql:operation')
          → graphql-js execute / createSourceEventStream (abortSignal, hideSuggestions)
              → per resolver-backed field: resolver wrapper (§8.5)
          → format errors (§8.8)
      → Response (graphql-response+json | json) or HttpResponse.sse(next… complete)
```

- One HTTP request = one operation = one request scope (no batching). The `GraphQLContext` external
  is set in the scope opened by `HttpPlugin` (`container.currentScope().set(...)`).
- Subscriptions: the scope is the SSE request's. Each source event is executed with
  `executeSubscriptionEvent` and a fresh per-execution state (loaders), with the same
  `GraphQLContext` and the same request-scoped providers (`CurrentUser` authenticated at connect).
- `plugin.execute(request)` / `plugin.subscribe(request)`: run in the current scope when one is
  active (a controller calling GraphQL), otherwise open one with `runInScope`.

### 8.5 Resolver pipeline (normative, per resolver call)

1. Resolve the resolver instance: the singleton resolved at boot, or `container.get(token)` in the
   current scope for request-scoped and transient resolvers.
2. Guards (§5.9): global (when they apply), class, method; each resolved in the current scope;
   `false` → `FORBIDDEN`.
3. Null handling of arguments (§7.3), when the field has a normaliser.
4. `invoke(resolver, parent, args, context, info)`.

Fields without guards nor normaliser call `invoke` directly (no extra closure, no `await`); plain
property fields use graphql-js' default resolver. Core AOP (`@Intercept`, `@Logged`, `@Traced`,
`@Metric`) applies to resolver methods like to any provider method: v0.1 has no GraphQL-specific
interceptors.

### 8.6 Loaders

- Per execution, a registry `Map<token, DataLoader>` is created lazily. `c.loader(token)` resolves
  the loader provider in the current scope, wraps `instance.load(keys)` in a `DataLoader` with its
  `options` (`maxBatchSize`, `cache`, `cacheKeyFn`; `batchScheduleFn` is not exposed), and caches it
  for the execution. `GraphQLContext.loader(Class)` maps the class with `container.tokenOf`.
- A batch function returning an array of the wrong length is a ZNIGHT055 error for every key of the
  batch; returned `Error`s fail their key only.
- `orderByKeys(keys, values, keyOf, { missing: 'error' | 'null' })` reorders rows; `'error'`
  (default) gives a `NOT_FOUND` `GraphQLException` for missing keys.

### 8.7 Subscriptions and PubSub

```ts
export abstract class PubSub<Events extends object = Record<string, unknown>> {
  abstract publish<K extends keyof Events & string>(topic: K, payload: Events[K]): Promise<void>
  abstract subscribe<K extends keyof Events & string>(
    topic: K,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterableIterator<Events[K]>
}
```

- `MemoryPubSub({ bufferSize })`: in-process fan-out, one RFC 0006 `EventChannel` per subscriber
  (`capacity: bufferSize`, `overflow: 'close'`, closed by the subscriber's `signal`); an overflow
  ends that subscription with a final `SUBSCRIPTION_OVERFLOW` error. Multi-instance deployments supply their own
  implementation (`pubsub` option); a Redis recipe goes in the guide; a `@znight/messaging` bridge
  is v0.2 (it needs fan-out semantics the drivers do not have).
- Root subscription guards run once, when the subscription starts; HTTP guards once, on the SSE
  request. Per-event authorization is the generator's job.
- `subscriptions.maxActive` caps active subscriptions (503 beyond); `activeSubscriptions` exposes
  the count.

### 8.8 Errors

- Request errors (parse, validation, variables, limits): codes `GRAPHQL_PARSE_FAILED`,
  `GRAPHQL_VALIDATION_FAILED`, `BAD_USER_INPUT`, `QUERY_TOO_COMPLEX`; status per §8.3.
- Execution errors: the order of §5.10. A `GraphQLException(message, { code, extensions, cause })`
  is rendered as `{ message, locations, path, extensions: { code, ...extensions } }`;
  `ValidationException`-like schema failures add `extensions.issues: [{ path, message }]`.
- Masked errors are logged once (`error` level) with `requestId`, `coordinate`, `path` and the
  cause; GraphQL validation errors are never logged above `debug`.
- With `introspection` off, suggestions are hidden (`hideSuggestions`), so validation errors do not
  leak field names.
- `HttpException` headers (`www-authenticate`) are not sent from field errors: one response carries
  many fields. HTTP guards on the endpoint keep their status and headers.

### 8.9 Security and limits

- `limits.maxTokens` is passed to `parse`; `maxDepth`, `maxAliases` and `maxDirectives` are
  validation rules (introspection fields exempt from depth). graphql-js 17's
  `MaxIntrospectionDepthRule` is always on.
- Introspection off in production, error masking on, no batching, JSON-only POST, GET for queries
  only, body limit 100 KiB, active subscriptions capped.
- The document cache is keyed by the exact query text and bounded in entries; documents rejected by
  the limits are not cached.
- GraphiQL is served only when enabled, with its own `content-security-policy` (the pinned CDN
  origin) that overrides the strict API default of RFC 0001 on that response only.
- Deny-by-default for fields is opt-in through a `required` group (§5.9), like HTTP routes.

### 8.10 Hooks and observability

**Core prerequisite (P0):** `'graphql:operation': GraphQLOperationEvent` in `ZnightHooks`, defined
in `@znight/core` like the other events.

```ts
export interface GraphQLOperationEvent {
  readonly operationType: 'query' | 'mutation' | 'subscription' | undefined // undefined: rejected before an operation was selected
  readonly operationName: string | undefined
  readonly documentId: string | undefined // SHA-256 (hex) of the query text, cached with the document
  readonly transport: 'http' | 'sse' | 'direct'
  readonly requestId: string
  readonly context: unknown // GraphQLContext
  readonly startTime: number
  /** Set before `run` resolves. */
  outcome?: 'success' | 'partial' | 'error' | 'rejected'
  errors?: readonly {
    readonly message: string
    readonly code: string | undefined
    readonly path?: readonly (string | number)[]
  }[]
}
```

- Produced once per operation; for a subscription, once for its whole life (start to end), with
  `outcome` set when it ends. The producer calls `run` only when wrappers exist and `emit` only when
  listeners exist (no cost otherwise).
- `@znight/observability` (P1): span `<type> <name>` (OpenTelemetry semantic conventions:
  `graphql.operation.type`, `graphql.operation.name`; `graphql.document` only with
  `tracing.graphql.document: true`), child of the HTTP span; metrics
  `graphql_operations_total{type, name, outcome}` and `graphql_operation_duration_seconds{type,
  name}`, with operation names capped (`maxOperationNames`, default 100, then `_OTHER`; anonymous
  operations are `anonymous`); `logging.graphql` (off by default) logs one line per operation.
- Resolver-level spans are v0.2, built on graphql-js 17 tracing channels (`graphql:resolve`)
  instead of wrapping every resolver.

### 8.11 Graceful shutdown

1. `GraphQLPlugin.onStop`: aborts the subscriptions of the direct transport (`plugin.subscribe()`).
2. `HttpPlugin.onStop` (RFC 0006 shutdown sequence): `draining`, then every SSE stream is closed:
   `ctx.signal` aborts with `'shutdown'`, so `GraphQLContext.signal` aborts, the PubSub channels
   close and the source event stream ends within `shutdownGraceMs`; the response ends with a
   jittered `retry` and **no** `complete` event, which GraphQL-over-SSE clients treat as a lost
   connection and retry against another instance. Queries and mutations in flight drain up to
   `drainTimeoutMs` (a subscription arriving while draining is served and ends at once, RFC 0006).
3. Providers stop and are disposed; `GraphQLPlugin.onDispose` closes the default `PubSub`.

Plugin order does not matter: neither plugin waits for the other.

### 8.12 Performance

- Schema built once at boot from data (no SDL parsing). Targets, checked by a benchmark in CI
  (informative, not gating): schema build under 20 ms for 200 types; per-operation overhead of the
  plugin under 10 % of a bare graphql-js `execute` on the same schema for a 50-field query served
  from the document cache.
- Document cache: parse and validate once per distinct query text.
- Synchronous `invoke` unless a schema validates; no wrapper on fields without guards or
  normaliser; singleton resolvers resolved once.
- Loaders batch per execution; a test of the example asserts one repository call for N books.
- `graphql-jit` and persisted documents are v0.2 options, measured against these benchmarks first.

## 9. Dependencies

| Package                              | Kind                    | Range         | Why                                                                                                                                                   |
| ------------------------------------ | ----------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@znight/core`                       | dependency              | `workspace:*` | Container, plugins, hooks                                                                                                                             |
| `@znight/http`                       | dependency              | `workspace:*` | Transport (H1), `HttpContext` types, `HttpException` mapping, Standard Schema helpers. It has no third-party dependency (adapters are optional peers) |
| `graphql`                            | **peer** (required)     | `^17.0.2`     | Execution engine. A peer so that the application, codegen and libraries share one copy (`instanceof` checks of graphql-js)                            |
| `dataloader`                         | dependency              | `^2.2.3`      | Batching; tiny, zero dependencies, an implementation detail behind `Loader<L>`                                                                        |
| `@znight/compiler`                   | optional peer           | `workspace:^` | Compiler extension types                                                                                                                              |
| `graphql-scalars`                    | none (user choice)      | —             | Works through `scalar<T>(name, GraphQLURL)`                                                                                                           |
| `graphql-http`, `graphql-sse`, `zod` | devDependencies (exact) | —             | Conformance audits, SSE client in tests, schema examples                                                                                              |

Not used: `graphql-yoga`, `@envelop/core`, `@apollo/server`, `@graphql-tools/*` (a second plugin
system, more dependencies, conversions to WHATWG requests on Node), `reflect-metadata`.

## 10. Changes to other packages

| #   | Package                           | Change                                                                                                                                                          | Priority          |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| C1  | `@znight/compiler`                | Type shapes API (§6.8)                                                                                                                                          | P0                |
| C2  | `@znight/compiler`                | Alias provenance on `TypeInfo` (§6.8)                                                                                                                           | P0                |
| C3  | `@znight/compiler`                | Lazy extension edges (§6.8)                                                                                                                                     | P1                |
| C4  | `@znight/compiler`, `@znight/cli` | Extra outputs, `generate --check` staleness (§6.8)                                                                                                              | P1                |
| H1  | `@znight/http`                    | `HttpRouteProvider` / `PluginRoute` (§8.3)                                                                                                                      | P0                |
| H2  | `@znight/http`                    | RFC 0006: `HttpResponse.sse()`, `ctx.signal`, `EventChannel`, `injectSse()` (subscriptions build on it; fallback in §8.3)                                       | P0 (via RFC 0006) |
| H3  | `@znight/http`                    | RFC 0003 §8.2.4 and §6.4: `RouteMetaCarrier`, `readRouteMeta`, `requiredRouteGroups` (made by whichever of RFC 0003 / this RFC lands first)                     | P0                |
| K1  | `@znight/core`                    | `graphql:operation` hook and event; `ErrorCode` / `ERROR_DESCRIPTIONS` ZNIGHT050–056                                                                            | P0                |
| T1  | `@znight/testing`                 | Default `TestApp` closure adds `extensions.graphql` resolver tokens, their guard and loader tokens (structural reader `readGraphQLRoots`)                       | P0                |
| O1  | `@znight/observability`           | `graphql:operation` wrapper: span, metrics, optional log (§8.10)                                                                                                | P1                |
| L1  | `@znight/cli`                     | `znight g resolver <name>` and `znight g loader <name>`; `znight new --features graphql` (P2)                                                                   | P1                |
| D1  | docs                              | `packages/graphql/README.md`, `docs/packages/graphql.md`, a GraphQL guide, decorators reference, error codes, architecture §4.8 (ranges), §5, §7, new §9.5, §10 | P0                |

## 11. Open questions (with recommended answers)

| #   | Question                                                                                                  | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | graphql-js 16, 17, or both?                                                                               | **17 only.** Abort signals, `hideSuggestions` and `executeSubscriptionEvent` simplify the runtime; tracing channels and incremental delivery are the v0.2 roadmap. Revisit only if users report a hard 16 dependency                                                                                                                                                                                               |
| Q2  | Own transport or graphql-yoga?                                                                            | **Own transport**, about 600 lines, conformance-tested with `graphql-http`'s audits. Document "Use Yoga instead": `http: false`, then a controller route returning `yoga.fetch(...)` with `plugin.schema`. Reconsider if the transport grows beyond the spec (persisted documents, multipart)                                                                                                                      |
| Q3  | Expose every reachable type implicitly, or require an opt-in marker (`@ObjectType`, `/** @gqlType */`)?   | **Implicit**, it is the point of D1. The declared return type is the contract, introspection and the committed SDL make every exposed field visible, `@gqlHidden` hides. Add a ZNIGHT050 **warning** for fields named like secrets (`password`, `secret`, `token`, `hash`, `apiKey`) in output types (P2)                                                                                                          |
| Q4  | `number`: `Float` or `Int`?                                                                               | **`Float`** (always correct on the wire), with `Int` / `ID` aliases and the `number: 'Int'` extension option                                                                                                                                                                                                                                                                                                       |
| Q5  | Same type as input and output: error or automatic `XInput`?                                               | **Error with a fix-it** in v0.1 (predictable names). An automatic suffix can be added later without breaking anyone                                                                                                                                                                                                                                                                                                |
| Q6  | Which subscription transports?                                                                            | **SSE distinct connections** in v0.1 (RFC 0006). Apollo's `multipart/mixed` subscriptions (same stream, different framing) P2 if Apollo Client users ask. `graphql-ws` in v0.2 as an upgrade provider on RFC 0003's upgrade routes (`http.addUpgradeProvider()`, graphql-ws `makeServer()`), so handshakes keep the HTTP guards. Recommend HTTP/2 in production (browsers allow 6 HTTP/1.1 connections per origin) |
| Q7  | One access vocabulary for every transport, or a GraphQL-only `createFieldDecorator`?                      | **Reuse `createRouteDecorator`** (RFC 0003 widened `get()` to `RouteMetaCarrier` and exported the compiler readers for gateways). `@Roles` and one guard class then cover routes, gateways and fields, with one ZNIGHT023 check. A transport-neutral `createMetaDecorator` in `@znight/core` can replace it later without changing user code (same `get()`)                                                        |
| Q8  | GraphQL interfaces in v0.1?                                                                               | **No.** They need a project-wide index of implementations and `implements` emission; unions cover polymorphic results. v0.2, same discriminators                                                                                                                                                                                                                                                                   |
| Q9  | Should the GraphQL context carry user data (`context.user`)?                                              | **No.** Request-scoped providers already do it, with compile-time scope checks. `GraphQLContext.state` exists for odd cases                                                                                                                                                                                                                                                                                        |
| Q10 | Run global guards on every field resolver?                                                                | **No**: root fields and field resolvers with their own metadata only (§5.9). Running guards on every nested resolver multiplies the cost by the list sizes for no new decision                                                                                                                                                                                                                                     |
| Q11 | Where does the SDL go?                                                                                    | **Opt-in file** (`sdl` option, committed, `--check` in CI), never by default: the compiler does not create files users did not ask for                                                                                                                                                                                                                                                                             |
| Q12 | JSDoc tag names                                                                                           | `@gqlHidden` and `@gqlName` (TSDoc-compatible names; the `gql` prefix is the one Grats uses), plus the standard `@deprecated`, `@default`, `@param`                                                                                                                                                                                                                                                                |
| Q13 | Error code allocation                                                                                     | Blocks of ten per feature package from ZNIGHT030, **in RFC number order** because RFCs 0003 and 0004 both claimed 030–039: websocket 030–039, schedule 040–049, GraphQL 050–059 (§6.6). The owner confirms it when accepting the RFCs                                                                                                                                                                              |
| Q14 | Plugin routes: pull (`httpRoutes()`) or push (`http.addRoute()`, like RFC 0003's `addUpgradeProvider()`)? | **Pull.** Ordinary routes share one table built in `HttpPlugin.onBootstrap`, and a plugin instance may serve several applications in turn: a pull contract is order-independent and needs no per-application reset. Upgrade routes have their own table, which is why RFC 0003 can push                                                                                                                            |

## 12. Alternatives considered

| Alternative                                                                                          | Verdict                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS / TypeGraphQL style: `@ObjectType`, `@Field(() => Int)`, `@InputType`                         | Rejected: duplicates the TypeScript types, which is precisely what compile-time analysis removes                                                                |
| Schema-first (SDL + resolver conformance checked at build time, like gqlgen)                         | Rejected for v0.1: two sources of truth. The SDL is emitted instead. A conformance "check mode" could come later                                                |
| Grats as the derivation engine                                                                       | Rejected: a second analysis pipeline on the TypeScript compiler API (slow, outside oxc, outside DI). Its conventions (JSDoc descriptions, `gql` tags) are kept  |
| Pothos (builder API)                                                                                 | Rejected as the default: no decorators, no DI integration. Users can still build a schema with it and serve it with `http: false` plus their own route          |
| graphql-yoga / envelop as the transport                                                              | Rejected for v0.1 (Q2): heavier, a second plugin and context system, WHATWG conversions on Node. Kept as a documented recipe                                    |
| Mercurius                                                                                            | Rejected: Fastify only (Znight is adapter-agnostic)                                                                                                             |
| Apollo Server 5                                                                                      | Rejected: heavy, Node-centric integrations                                                                                                                      |
| WebSocket subscriptions in v0.1                                                                      | Rejected: needs a WebSocket server per adapter and runtime; SSE gets subscriptions shipped on the existing transport                                            |
| Generating graphql-js constructor code in the generated module                                       | Rejected: the module would import graphql-js, grow, and be harder to validate. Data + `invoke` mirrors `@znight/http` and allows hand-written metadata in tests |
| Request-scoped DataLoader providers (`@Injectable({ scope: 'request' }) class X extends DataLoader`) | Rejected: stale caches across subscription events, every resolver needs `Lazy<>`, user code depends on `dataloader` directly                                    |
| A GraphQL-only `createFieldDecorator` with the same semantics as route decorators                    | Rejected (Q7): a second vocabulary for the same decisions; route decorators already work outside controllers since RFC 0003                                     |

## 13. Implementation plan and tests

### 13.1 Milestones (one developer, days)

| #   | Milestone                                                                                                                                                                                  | Contents                                                             | Days     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------- |
| M0  | Prerequisites                                                                                                                                                                              | K1, T1, H1, H3 (P0); C1, C2 (P0); C3, C4 (P1). H2 is RFC 0006's work | 8        |
| M1  | Compiler extension: decorators, resolver analysis, type mapping (scalars, enums, objects, inputs, args, lists, nullability, JSDoc), naming, ZNIGHT050–053 and 055, generation, SDL printer | P0 schema derivation                                                 | 8        |
| M2  | Runtime core: schema from metadata, resolver pipeline, null handling, `validateArgs`, guards and route metadata, errors and mappers, limits, document cache, `execute()`                   | P0 runtime                                                           | 5        |
| M3  | HTTP transport: GraphQL over HTTP, negotiation, status codes, GraphiQL (P1), `graphql-http` audits on every adapter                                                                        | P0 transport                                                         | 3        |
| M4  | Loaders and subscriptions: per-execution registry, `orderByKeys`, SSE on `HttpResponse.sse()`, `MemoryPubSub` on `EventChannel`, per-event execution, shutdown                             | P0                                                                   | 3        |
| M5  | P1 features: unions (ZNIGHT054), generics, utility types, custom and built-in scalars, `@default`, `@gqlName`, groups and `enforces`, observability wrapper (O1), CLI schematics (L1)      | P1                                                                   | 5        |
| M6  | Testing helpers, README, docs, error-code pages                                                                                                                                            | P0                                                                   | 3        |
| M7  | Wave 7: `examples/graphql-api` (§14)                                                                                                                                                       | P0                                                                   | 3        |
|     | **Total** (P0 ≈ 31)                                                                                                                                                                        |                                                                      | **≈ 38** |

Order: K1 and T1, then C1/C2 with M1 (one pull request per prerequisite, the extension behind
them), H1 with M3, then M2, M4, M5, M6, M7. M1 is the risk: start with the mapping table tests.

### 13.2 Test plan

- **Compiler unit tests** (`packages/graphql/test/compiler`, fixtures like
  `packages/http/test/compiler`):
  - the mapping table of §6.2 row by row, in output and input positions, through aliases, generics,
    intersections, `extends`, parameter properties and getters, from sources and from `.d.ts`;
  - nullability and list combinations, `Promise` and async iterables;
  - naming: generic instances, alias names, `@gqlName`, collisions across files and packages, root
    names, invalid enum values;
  - inputs: dual use, getters, non-null cycles, defaults (`@default`, parameter defaults, mismatches);
  - unions: classes, literal discriminants, `__typename`, ambiguity (ZNIGHT054);
  - JSDoc: descriptions, `@param`, `@deprecated`, `@gqlHidden`;
  - resolvers: every ZNIGHT052 and ZNIGHT005 case, http look-alikes, `@Resolver` + `@Controller`,
    compiled libraries;
  - loaders: binding, ZNIGHT001, ZNIGHT055, lazy edges (no ZNIGHT003 with C3);
  - route decorators on resolvers (groups, nearest decision wins) and ZNIGHT023;
  - every diagnostic: location, related "reached from" path, hints (formatted snapshots).
- **Generation**: snapshot of `extensions.graphql` and of the SDL; the SDL printed by the extension
  equals graphql-js `printSchema(schemaFromMetadata(...))`; determinism (full versus incremental
  compiles, `build` versus `serve`, byte-identical); the generated module type-checks under the
  strict settings of architecture §3.3; DI output unchanged by C2 (existing golden tests).
- **Compiler end-to-end**: compile a fixture application with `compile()`, import the generated
  module, boot it, run operations (pattern of `packages/http/test/compiler/e2e.test.ts`).
- **Runtime unit tests** with hand-written metadata (`defineTestMetadata`): schema building and
  ZNIGHT056 cases, guard order and applicability (§5.9), `enforces` check, null normalisation,
  Standard Schema validation (Zod and Valibot), error masking, mappers and `HttpException` mapping,
  limits and the document cache, introspection and suggestions, loaders per execution and per
  subscription event, `orderByKeys`, `MemoryPubSub` overflow, abort on disconnect, shutdown
  (SSE streams closed without `complete` by the RFC 0006 shutdown, direct subscriptions aborted), `execute()` inside and outside a
  scope.
- **Transport conformance**: `graphql-http` `serverAudits()` against the endpoint on the node,
  Fastify, Express and Hono adapters on Node.js, and Hono on `Bun.serve()` (shared adapter suite of
  `packages/http/test`); CSRF cases (form and text POST 415, mutation over GET 405); SSE in memory
  with `injectSse()` and over real sockets with the `graphql-sse` client on every adapter: event
  framing, client disconnect, heartbeats, shutdown reconnection.
- **Node.js and Bun**: the whole package suite runs under `bun test`; the example's end-to-end test
  builds it and runs the bundle on Node.js 24 and on Bun over real HTTP; `tests/golden.test.ts`
  includes `examples/graphql-api` (sources versus `dist`, Node and Bun, `build` and `serve`).
- **Boundaries**: `tests/boundaries.test.ts` covers the three entries (`./compiler` never loads
  `graphql` nor `dataloader`).
- **Benchmarks** (informative, §8.12): schema build time; plugin overhead versus bare graphql-js;
  the example versus the same schema on graphql-yoga.

## 14. Wave 7 example: `examples/graphql-api`

**Purpose.** The reference GraphQL application: everything of §5 compiled and tested, and the
source of the GraphQL guide's snippets.

**Domain.** A book catalog with authors and reviews, in-memory repositories (the data layer is the
subject of rest-api).

**Stack.** `honoAdapter()` (so that Bun runs `Bun.serve()` and SSE streams natively; Node uses
`@hono/node-server`), `@znight/config`, `@znight/observability`, `zod`; Node.js 24 and Bun.

**Schema.**

| Root field                                                            | Shows                                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `books(search, genre, sort, limit, offset): BookPage!`                | args object, enum, literal-union enum, `@default`, generic `Page<Book>`             |
| `book(id: ID!): Book`                                                 | nullable lookup, `@param` description                                               |
| `search(text: String!): [SearchResult!]!`                             | union discriminated by `kind`                                                       |
| `me: Viewer!`                                                         | request-scoped `CurrentUser`, `@Authenticated()`                                    |
| `addBook(input: NewBookInput!): Book!`                                | Standard Schema validation, `@Roles(['editor'])`, domain error mapping (`CONFLICT`) |
| `addReview(input: NewReviewInput!): Review!`                          | `EmailAddress` custom scalar, `PubSub.publish`                                      |
| `Book.author: Author!`                                                | `@ResolveField` with `Loader<AuthorsById>` (N+1 test)                               |
| `Book.reviews(first: Int = 5): [Review!]!`                            | field resolver with arguments, `Loader<ReviewsByBook>`                              |
| `bookAdded(genre: Genre): Book!`, `reviewAdded(bookId: ID!): Review!` | SSE subscriptions, filtering in generators, `@Authenticated()`                      |

**Layout.**

```text
examples/graphql-api/
├─ src/
│  ├─ main.ts                    Application.create(): ObservabilityPlugin, ConfigPlugin, HttpPlugin (hono), GraphQLPlugin
│  ├─ config/                    ServerConfig (port, exposeErrors), AuthConfig (@Secret API keys)
│  ├─ auth/                      access.ts (route decorators, group 'access' required), access.guard.ts (static enforces),
│  │                             authentication.guard.ts (HTTP), current-user.ts (request scope), api-keys.ts
│  ├─ catalog/                   book.ts, book.args.ts, book.inputs.ts, book.resolver.ts, author.resolver.ts,
│  │                             authors-by-id.loader.ts, catalog.service.ts, repositories, catalog.events.ts, errors.ts
│  ├─ reviews/                   review.ts, review.resolver.ts, reviews-by-book.loader.ts
│  ├─ search/                    search.ts (union), search.resolver.ts
│  ├─ shared/                    scalars.ts (EmailAddress), catalog-error.mapper.ts
│  └─ health/                    health.controller.ts (a REST route next to GraphQL)
├─ schema.graphql                committed, checked by `znight generate --check`
├─ znight.config.ts              extensions: [graphql.configure({ sdl: 'schema.graphql' })]
├─ test/                         see below
└─ README.md                     "What it shows", "Try breaking it" (Uint8Array field → ZNIGHT050, union without kind → ZNIGHT054)
```

**Tests** (`bun test`, end-to-end gated by `ZNIGHT_E2E`):

- `resolvers.test.ts`: `TestBed` unit tests of resolvers and loaders, `fakeLoader`.
- `books.graphql.test.ts`: queries with variables, pagination defaults, enum and union results,
  `addBook` validation issues (`BAD_USER_INPUT` with `issues`), `CONFLICT` mapping, nullable lookup.
- `batching.test.ts`: `books { items { author { name } } }` calls `AuthorRepository.findMany` once.
- `access.test.ts`: the access matrix of every root field for anonymous, reader and editor callers
  (`UNAUTHENTICATED`, `FORBIDDEN`), committed as a snapshot.
- `subscriptions.test.ts`: `subscribeOperation` (in memory, `injectSse`), genre filtering, unsubscription
  (`return()` closes the source), shutdown ends the stream without `complete`.
- `http.test.ts`: GraphQL-over-HTTP behaviour on the example (GET query, GET mutation 405, form
  POST 415, `graphql-response+json` statuses, introspection off with `NODE_ENV=production`, limits).
- `schema.test.ts`: `plugin.printSchema()` equals the committed `schema.graphql`.
- `build-check.test.ts`: compiles a fixture with an unmappable field and an ambiguous union
  through `compile()` and asserts ZNIGHT050 and ZNIGHT054 with their locations (keeps the README's
  "Try breaking it" honest).
- `e2e.test.ts`: builds, then runs the bundle on Node.js and on Bun: a query, a mutation with an
  API key, and a subscription receiving the added book.

## 15. Out of scope, roadmap for v0.2

- GraphQL interfaces (`implements` from TypeScript heritage), with the union discriminators.
- `@defer` / `@stream` (graphql-js 17 incremental delivery over SSE and `multipart/mixed`).
- `graphql-ws` subscriptions as an upgrade provider on RFC 0003's upgrade routes (graphql-ws
  `makeServer()`, handshake through the HTTP guards); SSE single connection mode.
- Trusted documents compiled at build time (client `.graphql` files validated against the schema by
  the compiler, an allowlist keyed by `documentId`), and compile-time validation of `gql` documents
  in tests.
- Query cost analysis using compile-time knowledge of list fields.
- Resolver-level tracing via graphql-js tracing channels; GraphQL-specific interceptors if core AOP
  proves insufficient.
- A distributed `PubSub` (Redis recipe promoted to a package, or a messaging fan-out bridge).
- Federation (`@key` entities), `@oneOf` inputs, custom directives, schema-first conformance mode.
- A transport-neutral metadata decorator in core (Q7).
