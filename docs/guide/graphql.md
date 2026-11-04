---
description: Build a GraphQL API with Znight - types as the schema, resolvers, validated arguments, loaders against N+1 queries, subscriptions over SSE and a PubSub shared across instances, access control, errors, tests, production settings, GraphQL drivers and serving the schema with GraphQL Yoga (yogaDriver).
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
WebSocket server. Publish events through the injectable `PubSub` ([what it is for](#pubsub)):

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

### What the PubSub is for {#pubsub}

A subscription is a request that stays open: the client sends `subscription { bookAdded { title } }`
once, and the answer is an event stream that lasts as long as the subscription. The events are born
elsewhere, at moments the stream does not choose: a mutation adds a book, a scheduled job notices a
change, a message consumer receives one from another service. The producer does not know which
streams are open, and the streams cannot call the producer. The `PubSub` is the mailbox between them:

```txt
mutation addBook ─┐                                          ┌─▶ stream of client 1: bookAdded
@Cron job ────────┼─▶ publish('bookAdded', book) ─▶ PubSub ──┼─▶ stream of client 2: bookAdded
message consumer ─┘                                          └─▶ stream of client 3: bookAdded(genre: Fantasy)
```

- **Producers publish** with `publish(topic, payload)`, from any provider that injects `PubSub`:
  resolvers, services, `@Cron` jobs, message consumers.
- **Every open subscription subscribes** with `subscribe(topic, { signal })` and receives what is
  published on that topic **from then on**. Nothing is stored or replayed: an event published before
  the subscription started, or while a client was disconnected, is not delivered. A client that
  reconnects queries the current state again.
- **Topics are typed** by the `Events` interface: `PubSub<CatalogEvents>` accepts only the topics it
  declares, checks the payload of `publish()` and types what `subscribe()` yields. The application
  has **one** `PubSub`, a singleton provided by `GraphQLPlugin`: every provider that injects
  `PubSub<SomeEvents>` gets the same instance, the type parameter only types its API.
- **Filtering is the subscription's job**: `bookAdded(genre: Fantasy)` subscribes to `bookAdded` and
  skips the other genres in the generator.
- **Always pass `ctx.signal`** to `subscribe()`: it aborts when the client leaves, when the
  application shuts down and after `subscriptions.maxDuration`, and the subscription then leaves the
  topic. Without it, the generator only notices with the next event.
- **Subscribe first, then await.** The generator starts with the subscription: it has subscribed to
  the PubSub by the time the client is connected, so an event published right after reaches it,
  provided it calls `subscribe()` before its first `await`.
- **Every subscriber has a bounded buffer.** A client reading slower than events are published
  piles them up; the default `MemoryPubSub` keeps 100 events per subscriber
  (`subscriptions.bufferSize`), and a subscriber that falls further behind ends with a
  `SUBSCRIPTION_OVERFLOW` error instead of growing the memory of the server.
- On shutdown, streams end **without** the `complete` event, which GraphQL-over-SSE clients treat
  as a lost connection: they reconnect to another instance.

### One instance or several {#pubsub-instances}

The default `MemoryPubSub` lives in the memory of the process: what one instance publishes reaches
the streams open **on that instance** only. That is enough for one instance. With several replicas
behind a load balancer, the mutation runs on one of them while the subscribers are spread across
all of them, and most would never hear of the new book.

Several instances need a `PubSub` they share through a server: Redis pub/sub, NATS, Postgres
`LISTEN`/`NOTIFY`, your message broker. Znight does not ship one: extend `PubSub` (two methods) and
give an instance to the `pubsub` option. Resolvers do not change: they keep injecting
`PubSub<CatalogEvents>`. An implementation:

- `publish(topic, payload)` hands the event to the server and resolves once it is sent;
- `subscribe(topic, { signal })` returns an `AsyncIterableIterator` **synchronously** (start
  listening right away) that yields the events of the topic until `signal` aborts or `return()` is
  called, then releases what it holds;
- gives every subscriber a bounded buffer, ending with `SUBSCRIPTION_OVERFLOW` (a
  `GraphQLException` with `GraphQLErrorCode.SubscriptionOverflow`) when it overflows;
- sends payloads that survive the trip: serializable data, not class instances or functions.

`GraphQLPlugin` closes the `MemoryPubSub` it created; a `PubSub` you pass is yours to close.

### Write your own PubSub {#custom-pubsub}

A Redis `PubSub` for [ioredis](https://github.com/redis/ioredis): each instance publishes to a Redis
channel per topic (`graphql:bookAdded`), listens to the channels its own subscribers need, once per
topic, and fans every message out to them through a bounded
[`EventChannel`](../../packages/http/README.md#eventchannel) per subscriber. A connection in
subscriber mode runs no other command, hence two connections.

```ts [src/graphql/redis-pubsub.ts]
import type { SubscribeOptions } from '@znight/graphql'

import { GraphQLErrorCode, GraphQLException, PubSub } from '@znight/graphql'
import { EventChannel } from '@znight/http'

/** The connection that publishes (an ioredis `Redis` fits). */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown>
}

/** A connection dedicated to subscriptions (another ioredis `Redis`, e.g. `publisher.duplicate()`). */
export interface RedisSubscriber {
  subscribe(channel: string): Promise<unknown>
  unsubscribe(channel: string): Promise<unknown>
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
}

export interface RedisPubSubOptions {
  readonly publisher: RedisPublisher
  readonly subscriber: RedisSubscriber
  /** Prefix of the Redis channels, so that applications can share a Redis. Default `'graphql:'`. */
  readonly prefix?: string
  /** Events buffered per subscriber; one that falls further behind ends with SUBSCRIPTION_OVERFLOW. Default 100. */
  readonly bufferSize?: number
}

/**
 * Every instance publishes to Redis and subscribes to the Redis channels its own subscribers need,
 * once per topic, then fans each message out to them. Payloads travel as JSON.
 */
export class RedisPubSub<Events extends object = Record<string, unknown>> extends PubSub<Events> {
  readonly #publisher: RedisPublisher
  readonly #subscriber: RedisSubscriber
  readonly #prefix: string
  readonly #bufferSize: number
  /** The local subscribers of each Redis channel. */
  readonly #channels = new Map<string, Set<EventChannel<unknown>>>()
  #closed = false

  constructor(options: RedisPubSubOptions) {
    super()
    this.#publisher = options.publisher
    this.#subscriber = options.subscriber
    this.#prefix = options.prefix ?? 'graphql:'
    this.#bufferSize = options.bufferSize ?? 100
    this.#subscriber.on('message', (channel, message) => this.#deliver(channel, message))
  }

  async publish<K extends keyof Events & string>(topic: K, payload: Events[K]): Promise<void> {
    await this.#publisher.publish(this.#prefix + topic, JSON.stringify(payload))
  }

  subscribe<K extends keyof Events & string>(
    topic: K,
    options: SubscribeOptions = {},
  ): AsyncIterableIterator<Events[K]> {
    // a bounded queue per subscriber, closed when the signal aborts (client gone, shutdown)
    const events = new EventChannel<Events[K]>({
      capacity: this.#bufferSize,
      overflow: 'drop-newest',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (this.#closed) events.close()
    else this.#add(this.#prefix + topic, events as EventChannel<unknown>)
    const iterator = events[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      return: () => {
        events.close()
        return Promise.resolve({ done: true, value: undefined })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }

  /** Ends every subscription and unsubscribes from Redis. The connections are yours to close. */
  close(): void {
    this.#closed = true
    for (const subscribers of [...this.#channels.values()]) {
      for (const events of [...subscribers]) events.close()
    }
  }

  #add(channel: string, events: EventChannel<unknown>): void {
    let subscribers = this.#channels.get(channel)
    if (subscribers === undefined) {
      const created = new Set<EventChannel<unknown>>()
      subscribers = created
      this.#channels.set(channel, created)
      // the first local subscriber of the topic: listen to its Redis channel
      this.#subscriber.subscribe(channel).catch((error: unknown) => {
        for (const subscriber of [...created]) subscriber.fail(error)
      })
    }
    const set = subscribers
    set.add(events)
    events.onClose(() => {
      set.delete(events)
      if (set.size > 0 || this.#channels.get(channel) !== set) return
      // the last one left: stop listening
      this.#channels.delete(channel)
      this.#subscriber.unsubscribe(channel).catch(() => {})
    })
  }

  #deliver(channel: string, message: string): void {
    const subscribers = this.#channels.get(channel)
    if (subscribers === undefined) return
    let payload: unknown
    try {
      payload = JSON.parse(message)
    } catch {
      return // not a message of this PubSub
    }
    for (const events of subscribers) {
      if (!events.push(payload)) {
        events.fail(
          new GraphQLException('The subscriber fell behind the events: the subscription ended', {
            code: GraphQLErrorCode.SubscriptionOverflow,
          }),
        )
      }
    }
  }
}
```

Give it to the `pubsub` option, and close it with the connections once everything else has stopped:
a plugin listed first is disposed last, after the requests and the streams are drained.

```ts [src/main.ts]
import { Application } from '@znight/core'
import { GraphQLPlugin } from '@znight/graphql'
import { HttpPlugin } from '@znight/http'
import Redis from 'ioredis'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { RedisPubSub } from './graphql/redis-pubsub.js'

const publisher = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379')
const subscriber = publisher.duplicate()
const pubsub = new RedisPubSub({ publisher, subscriber })

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    {
      name: 'redis',
      async onDispose() {
        pubsub.close()
        await Promise.all([publisher.quit(), subscriber.quit()])
      },
    },
    HttpPlugin.configure({ port: 3000 }),
    GraphQLPlugin.configure({ pubsub }),
  ],
})
await app.start()
```

- **Payloads travel as JSON.** A `Date` arrives as an ISO string (the built-in `DateTime` scalar
  serializes those too), a class instance as a plain object. Publish data, or ids the subscription
  reloads.
- **Redis pub/sub delivers at most once.** It stores nothing: an instance that is down or
  reconnecting misses what is published meanwhile, and so does a subscription during the round trip
  of its first `SUBSCRIBE` (later subscriptions of the same topic on the same instance share it). When
  every event matters, publish ids and let the client query what changed, or use Redis Streams or
  your broker with a replay.
- `prefix` keeps applications sharing a Redis apart; another PubSub's messages are ignored.
- The other shared stores follow the same shape: NATS subjects, Postgres `LISTEN`/`NOTIFY`
  channels (payloads up to 8 000 bytes), a fan-out exchange of your broker.

The recipe is tested in the repository against an in-memory Redis and, with Docker, a real one:
[`redis-pubsub.ts`](../../packages/graphql/test/recipes/redis-pubsub.ts) and its tests.

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

### Return errors as data {#errors-as-data}

Errors a client is expected to handle (a missing book, invalid input, a forbidden action) can be
**values** of the field rather than entries of `errors[]`: the field returns a union, and clients
select the failures with fragments, checked by their query compiler. Declare the failures as
members of the field's return type:

```ts [src/catalog/rejections.ts]
import type { Book } from './book.js'

export interface NotFoundRejection {
  readonly __typename: 'NotFoundRejection'
  readonly message: string
}

export interface ValidationRejection {
  readonly __typename: 'ValidationRejection'
  readonly issues: readonly string[]
}

/** What `book` and `addBook` answer. */
export type BookResult = Book | NotFoundRejection | ValidationRejection
```

```ts
@Query()
book(@Args('id') id: ID): Promise<BookResult> {
  return this.catalog.get(id) // throws BookNotFoundError instead of answering null
}

@Mutation()
addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<BookResult> {
  return this.catalog.add(input)
}
```

Then turn errors into those values in one place, with a result mapper. `static types` lists the
types it produces: only the fields whose union holds one of them are wrapped, decided at boot, and a
typo fails the boot.

```ts [src/shared/rejections.mapper.ts]
import { Injectable } from '@znight/core'
import { GraphQLErrorCode, GraphQLException, type GraphQLResultMapper } from '@znight/graphql'

import { BookNotFoundError } from '../catalog/errors.js'
import type { NotFoundRejection, ValidationRejection } from '../catalog/rejections.js'

@Injectable()
export class RejectionsMapper implements GraphQLResultMapper {
  static readonly types = ['NotFoundRejection', 'ValidationRejection']

  toResult(error: unknown): NotFoundRejection | ValidationRejection | undefined {
    if (error instanceof BookNotFoundError) return { __typename: 'NotFoundRejection', message: error.message }
    // a Standard Schema of @Args rejected the input
    if (error instanceof GraphQLException && error.code === GraphQLErrorCode.BadUserInput) {
      const issues = (error.extensions?.['issues'] ?? []) as readonly { readonly message: string }[]
      return { __typename: 'ValidationRejection', issues: issues.map(issue => issue.message) }
    }
    return undefined
  }
}
```

```ts
GraphQLPlugin.configure({ resultMappers: [RejectionsMapper] })
```

```graphql
mutation {
  addBook(input: { title: " ", isbn: "9780441013593", authorId: "1", genre: ScienceFiction }) {
    ... on Book {
      id
      title
    }
    ... on ValidationRejection {
      issues
    }
  }
}
```

answers `{ "data": { "addBook": { "issues": ["A title is required"] } } }`, with no `errors`. Guards can be
mapped too: a guard returning `false` is a `GraphQLException` with code `FORBIDDEN`. An error the
mappers leave alone, or an error on a field whose union does not hold the produced type, stays in
`errors[]`; so do errors of nested fields, unless that field returns a union of its own. Keep
unexpected failures there: a catch-all `InternalErrorRejection` hides them unless the mapper logs
them. The [package README](../../packages/graphql/README.md#errors-as-data) lists every rule.

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

## Choose a driver {#drivers}

The built-in endpoint (GraphQL over HTTP and SSE, GraphiQL) is the default and the fastest path.
A **driver** serves the same schema with another GraphQL server when you need its protocol
features or its plugin ecosystem (persisted operations, response caching, usage reporting):
Znight stays the engine, the driver owns the transport
([RFC 0009](../../rfcs/0009-graphql-drivers.md)).

```ts
GraphQLPlugin.configure({ guards: [AccessGuard], driver: yogaDriver() })
```

Nothing of this guide changes with a driver: the server calls `plugin.engine`, whose `parse`,
`validate`, `execute` and `subscribe` run the compiled schema with its guards, loaders, request
scope, error and result mappers, masking, limits and the `graphql:operation` hook (with the
driver's name). The driver's routes run in the HTTP pipeline like the built-in endpoint, so HTTP
guards, CORS, `http.meta` decisions and the drain apply, and `executeOperation()` and
`subscribeOperation()` reach them in tests. What differs is the server's: its protocol choices,
its IDE (`graphiql: true` serves it), its subscription transports and its keep-alive options
(`subscriptions.heartbeat` and `maxDuration` belong to the built-in SSE transport).

| Driver                 | Entry                                                            | Use it for                                                             |
| ---------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Built-in (no `driver`) | `@znight/graphql`                                                | The default: GraphQL over HTTP and SSE, GraphiQL, the fastest          |
| GraphQL Yoga           | [`yogaDriver()`](#yoga) from `@znight/graphql/yoga`              | Envelop and Yoga plugins, Yoga's GraphiQL and SSE, batching, multipart |
| Apollo Server          | Once Apollo Server accepts graphql-js 17                         | Apollo plugins and usage reporting (planned, RFC 0009 M3)              |
| Your own               | A `GraphQLDriver`: `name`, `routes()`, `start(engine)`, `stop()` | Another server; check it with `describeDriverConformance()`            |

Drivers buy an ecosystem, the built-in transport buys throughput: in the in-process benchmark of the
package (`{ hello }`, one synchronous resolver, the `HttpPlugin` pipeline without a socket), a
request costs about 1.6 µs on Bun and 5.5 µs on Node.js with the built-in transport, and about
13 to 18 µs on Bun and 27 to 45 µs on Node.js with the Yoga driver (Yoga's request parsing, its
plugin chain and the Web `Request` and `Response` objects). Over a network, with real resolvers,
the gap is a smaller share of each request; measure your own operations before choosing.

The engine and the driver contract are described in the
[package README](../../packages/graphql/README.md#drivers-and-the-engine), with a complete driver
built on `graphql-http`.

## Serve the schema with GraphQL Yoga {#yoga}

[GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) serves the schema with its protocol
support, its GraphiQL, its SSE subscriptions and its Envelop plugins when the driver of
`GraphQLPlugin` is `yogaDriver()`. Yoga handles each request and hands the document to the engine,
which parses it through its document cache, validates it with its limits and executes it, in the
request scope of the route:

```ts [src/graphql/yoga.plugins.ts]
import type { Plugin } from '@znight/core'
import type { Plugin as YogaPlugin } from 'graphql-yoga'

import { GraphQLPlugin } from '@znight/graphql'
import { yogaDriver } from '@znight/graphql/yoga'
import { HttpPlugin } from '@znight/http'

/** A Yoga plugin: Envelop and Yoga plugins (persisted operations, response cache...) go to the driver. */
const servedBy: YogaPlugin = {
  onResponse({ response }) {
    response.headers.set('x-graphql-server', 'yoga')
  },
}

export function plugins(): Plugin[] {
  return [
    HttpPlugin.configure(),
    GraphQLPlugin.configure({
      graphiql: process.env['NODE_ENV'] === 'development',
      driver: yogaDriver({ plugins: [servedBy] }),
    }),
  ]
}
```

```ts [src/main.ts (excerpt)]
const app = await Application.create({ metadata: __ZNIGHT_METADATA__, plugins: plugins() })
```

```sh
npm install graphql-yoga
```

The resolvers, guards, loaders and tests of the application do not change: resolvers keep
`GraphQLContext` (`@Ctx()`, `@Loader()`, `ctx.signal`), guards see the HTTP request of the route in
`ctx.http`, request-scoped providers are created once per request, errors are mapped and masked
once by the engine, and the `graphql:operation` hook reports every operation with `driver: 'yoga'`
(`transport: 'sse'` for subscriptions). What to know:

- **Options.** `yogaDriver()` takes Yoga's options, except those Znight owns: the schema, the
  context, the endpoint (`path`), masking (`exposeErrors`), CORS (`HttpPlugin`'s), the body limit
  (`http.bodyLimit`), the document cache and the request id (`HttpPlugin`'s). Passing one is a type
  error, and ZNIGHT066 for untyped callers. Yoga's `logging` is off unless set: Znight logs requests
  and operations. `graphiql: true` on `GraphQLPlugin` serves Yoga's GraphiQL; `yogaDriver({ graphiql:
  { title } })` configures it.
- **Plugins.** Envelop and Yoga plugins run around the engine: persisted operations, response
  caching, rate limits, usage reporting, plugins wrapping the execution. A plugin that replaces the
  execution (`useGraphQlJit`) would bypass the engine: such an operation fails with ZNIGHT066,
  logged once. Prefer Znight's tracing (`@znight/observability`) to Yoga's: both would trace the
  same operations.
- **Yoga's context.** Resolvers rarely need it; `yogaContext(ctx)` returns it (`request`, `params`,
  what a plugin added, and `znight`, the `HttpContext`) for an operation the driver received.
- **Subscriptions** use Yoga's SSE (distinct connections; `useGraphQLSSE` for the single
  connection mode). The engine keeps `subscriptions.maxActive` and ends every stream when the
  application stops: the client receives Yoga's `complete` event rather than the built-in
  transport's `retry` hint. Yoga's `keepAlive` pings replace `subscriptions.heartbeat`.
- **Protocol.** Yoga follows the GraphQL-over-HTTP draft (the `graphql-http` audits pass through it
  on every adapter); its request errors (malformed JSON, missing query) carry its own messages. A
  body past `http.bodyLimit` is `HttpPlugin`'s 413, as with the built-in endpoint.
- **Route decisions.** An application whose route decisions are required gives the endpoint its
  decision with `http: { meta: [Public.meta()] }`, as for the built-in endpoint.

The recipe is tested in the repository on a compiled application:
[`yoga.plugins.ts`](../../packages/graphql/test/recipes/yoga.plugins.ts) and its tests.

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

import type { Author, QueryBooksArgs } from '../graphql.generated.ts'
import { AuthorsById } from './authors-by-id.loader.ts'
import { type BookModel, CatalogService } from './catalog.service.ts'

@Resolver('Book')
export class BookResolver {
  constructor(private readonly catalog: CatalogService) {}

  // BookModel: the fields of Book without author, plus authorId
  @Query()
  books(@Args('limit') limit: QueryBooksArgs['limit']): Promise<BookModel[]> {
    return this.catalog.list(limit ?? 10)
  }

  @ResolveField()
  author(@Parent() book: BookModel, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
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
  on both sides. Union members and interface implementations are told apart by `instanceof` for
  the exported classes the resolvers return, else by `__typename`: graphql-codegen declares it
  optional, so make sure the returned objects carry it.
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
        scalars: { DateTime: 'Date', Isbn: './catalog/isbn.ts#Isbn' },
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
| `driver: YogaDriver` (`@graphql-yoga/nestjs`)        | `driver: yogaDriver()` from `@znight/graphql/yoga` ([Yoga](#yoga)) |
| `driver: ApolloDriver`, `MercuriusDriver`            | The built-in transport (Apollo: once it accepts graphql-js 17)     |
| `@Resolver(() => Book)` + `@ResolveField()`          | `@Resolver()` + `@ResolveField()` with a `@Parent()` parameter     |
| `@Args('id', { type: () => ID })`                    | `@Args('id') id: ID`                                               |
| `class-validator` on input classes, `ValidationPipe` | A Standard Schema: `@Args('input', NewBookInput)`                  |
| `registerEnumType`, `createUnionType`                | A TypeScript `enum` or literal union; a named union alias          |
| `dataloader` wiring per request in the context       | A `BatchLoad` provider and `@Loader()`                             |
| `graphql-subscriptions` `PubSub`, `graphql-ws`       | The injectable `PubSub`, subscriptions over SSE                    |
| `@UseGuards()` with `GqlExecutionContext`            | `GraphQLGuard.canResolve(ctx: ResolverContext)`, route decorators  |
| A plugin rewriting exceptions into union members     | `resultMappers`, per field ([errors as data](#errors-as-data))     |
| Schema errors at boot or at the first request        | Schema errors at build time (`ZNIGHT060`–`ZNIGHT068`)              |

An Envelop or Yoga plugin that rewrites `data` from the first error of the execution (an
`onExecuteDone` replacing the root field with a rejection) becomes a result mapper. The difference
to plan for: result mappers work per field. The rejection replaces the field that failed, partial
results are kept, and an error of a nested field stays in `errors[]` unless that field returns a
union of its own.

## Limits {#limits}

- Code-first maps no TypeScript type to a GraphQL interface: use unions, or the schema-first mode,
  which supports interfaces.
- Schema-first: no custom directives with behaviour, no `@oneOf` inputs, no `__resolveType`
  methods (return objects carrying `__typename`).
- Subscriptions are over SSE only (`graphql-ws` is a follow-up), and `MemoryPubSub` serves one
  process ([write your own](#custom-pubsub) for several).
- No `@defer` / `@stream`, trusted documents, cost analysis or federation in this version.
- Types must be written: return types and property types are read from annotations.
