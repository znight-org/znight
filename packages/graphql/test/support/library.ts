/**
 * A small library schema served over HTTP, shared by the transport tests and by the fixture
 * scripts that run on Node.js and Bun: synchronous and asynchronous queries, a mutation that
 * publishes an event, and subscriptions (PubSub topic, the same topic through an async generator,
 * finite generator, endless generator).
 */
import type { ExternalDefinition, ZnightMetadata } from '@znight/core'
import type { HttpAdapter, HttpPluginOptions } from '@znight/http'
import type { GraphQLContext, GraphQLPluginOptions, GraphQLTypeDefinition, PubSub } from '../../src/index.ts'

import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'

import { GraphQLPlugin } from '../../src/index.ts'
import { bind, captureLogger, field, graphqlMetadata } from './app.ts'

/** Externals of `HttpPlugin` (its manifest's `provides`). */
export const HTTP_EXTERNALS: readonly ExternalDefinition[] = [
  { token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
  { token: '@znight/http#RequestId', scope: 'request', providedBy: 'HttpPlugin' },
]

export interface Book {
  readonly title: string
}

interface LibraryEvents {
  bookAdded: Book
}

/** What the resolvers observed (shared by every application of a process). */
export const observed: {
  /** `ctx.signal` reasons seen by the slow query and the endless subscription. */
  aborts: string[]
  /** Subscriptions whose source ended (`finally` of the generators). */
  ended: string[]
} = { aborts: [], ended: [] }

export class Library {
  readonly #pubsub: PubSub<LibraryEvents>
  readonly #books: Book[] = [{ title: 'Dune' }]

  constructor(pubsub: PubSub<LibraryEvents>) {
    this.#pubsub = pubsub
  }

  hello(args: { name?: string | null }): string {
    return `Hello ${args.name ?? 'world'}`
  }

  books(): readonly Book[] {
    return this.#books
  }

  /** Resolves after `ms`, or rejects when the operation's signal aborts. */
  slow(args: { ms: number }, _parent: unknown, ctx: GraphQLContext): Promise<string> {
    return new Promise((resolve, reject) => {
      const signal = ctx.signal
      const timer = setTimeout(() => resolve('slow'), args.ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          observed.aborts.push(String((signal.reason as { kind?: string } | undefined)?.kind ?? signal.reason))
          reject(signal.reason)
        },
        { once: true },
      )
    })
  }

  fail(): string {
    throw new Error('broken')
  }

  async addBook(args: { title: string }): Promise<Book> {
    const book = { title: args.title }
    this.#books.push(book)
    await this.#pubsub.publish('bookAdded', book)
    return book
  }

  bookAdded(_args: unknown, _parent: unknown, ctx: GraphQLContext): AsyncIterableIterator<Book> {
    return this.#pubsub.subscribe('bookAdded', { signal: ctx.signal })
  }

  /** `bookAdded` through an async generator: it subscribes to the PubSub on its first `next()` only. */
  async *newBook(_args: unknown, _parent: unknown, ctx: GraphQLContext): AsyncGenerator<Book> {
    for await (const book of this.#pubsub.subscribe('bookAdded', { signal: ctx.signal })) yield book
  }

  async *countdown(args: { from: number }): AsyncGenerator<number> {
    try {
      for (let n = args.from; n > 0; n--) yield await Promise.resolve(n)
    } finally {
      observed.ended.push('countdown')
    }
  }

  async *forever(_args: unknown, _parent: unknown, ctx: GraphQLContext): AsyncGenerator<number> {
    const signal = ctx.signal
    try {
      for (let n = 1; !signal.aborted; n++) {
        yield n
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 20)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
      }
      observed.aborts.push(String((signal.reason as { kind?: string } | undefined)?.kind))
    } finally {
      observed.ended.push('forever')
    }
  }
}

const types: GraphQLTypeDefinition[] = [
  { kind: 'object', name: 'Book', fields: [{ name: 'title', type: 'String!' }] },
  {
    kind: 'object',
    name: 'Query',
    fields: [
      field('hello', 'String!', bind(Library, 'hello'), { args: [{ name: 'name', type: 'String' }] }),
      field('books', '[Book!]!', bind(Library, 'books')),
      field('slow', 'String!', bind(Library, 'slow'), { args: [{ name: 'ms', type: 'Int!' }] }),
      field('fail', 'String', bind(Library, 'fail')),
    ],
  },
  {
    kind: 'object',
    name: 'Mutation',
    fields: [
      field('addBook', 'Book!', bind(Library, 'addBook', { operation: 'mutation' }), {
        args: [{ name: 'title', type: 'String!' }],
      }),
    ],
  },
  {
    kind: 'object',
    name: 'Subscription',
    fields: [
      field('bookAdded', 'Book!', bind(Library, 'bookAdded', { operation: 'subscription' })),
      field('newBook', 'Book!', bind(Library, 'newBook', { operation: 'subscription' })),
      field('countdown', 'Int!', bind(Library, 'countdown', { operation: 'subscription' }), {
        args: [{ name: 'from', type: 'Int!' }],
      }),
      field('forever', 'Int!', bind(Library, 'forever', { operation: 'subscription' })),
    ],
  },
]

/** The metadata of the library (`Library` is a singleton depending on `PubSub`). */
export function libraryMetadata(): ZnightMetadata {
  return graphqlMetadata({
    providers: [{ class: Library, deps: ['@znight/graphql#PubSub'] }],
    types,
    externals: HTTP_EXTERNALS,
  })
}

/** Options of {@link startLibrary}. */
export interface LibraryOptions {
  readonly adapter?: HttpAdapter
  readonly http?: HttpPluginOptions
  readonly graphql?: GraphQLPluginOptions
}

/** A started library application. */
export interface LibraryApp extends AsyncDisposable {
  readonly app: Application
  readonly http: HttpPlugin
  readonly graphql: GraphQLPlugin
  /** `http://127.0.0.1:port/graphql`. */
  readonly url: string
  readonly logs: ReturnType<typeof captureLogger>
  stop(): Promise<void>
}

/** Boots and starts the library with `HttpPlugin` and `GraphQLPlugin` (introspection on). */
export async function startLibrary(options: LibraryOptions = {}): Promise<LibraryApp> {
  const logs = captureLogger()
  const http = HttpPlugin.configure({
    host: '127.0.0.1',
    port: 0,
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    ...options.http,
  })
  const graphql = GraphQLPlugin.configure({ introspection: true, ...options.graphql })
  const app = await Application.create({
    metadata: libraryMetadata(),
    plugins: [http, graphql],
    logger: logs,
    shutdown: { signals: false },
  })
  // started (on a free port): the shutdown sequence of HttpPlugin only runs for a started application
  await app.start()
  const path = options.graphql?.path ?? '/graphql'
  const url = `${String(http.address)}${http.prefix}${path}`
  const stop = (): Promise<void> => app.stop()
  return { app, http, graphql, url, logs, stop, [Symbol.asyncDispose]: stop }
}
