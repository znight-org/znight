/**
 * The driver conformance suite (RFC 0009 §5.4, §12): the same scenarios against the built-in
 * transport and every route-mounted driver, on the HTTP adapters given, through the whole
 * `HttpPlugin` pipeline (`executeOperation()`, `subscribeOperation()`). Exported from
 * `@znight/graphql/testing` as `describeDriverConformance()` for third-party drivers, and
 * framework-neutral: the caller passes its `describe` / `it` / `beforeAll` / `afterAll` (`bun:test`,
 * Vitest, Jest, `node:test`), the assertions are `node:assert`'s.
 *
 * The application is hand-written metadata (what the compiler generates): a catalog with a
 * mutation publishing an event, a field resolved through a loader, a request-scoped session read by
 * a field guard and by a resolver, a result mapper, an error to mask, subscriptions (a PubSub topic,
 * a finite and an endless generator), an HTTP guard on the endpoint, introspection off and limits.
 */
// biome-ignore-all lint/suspicious/useExpect: a framework-neutral suite, asserting with node:assert
import type { CanActivate, HttpAdapter, HttpContext } from '@znight/http'
import type { GraphQLDriver } from './driver.ts'
import type { GraphQLResolverBinding, GraphQLResolverOperation, GraphQLTypeDefinition } from './metadata.ts'
import type { PubSub } from './pubsub.ts'
import type { OperationResponse, OperationResult, OperationStream } from './testing.ts'
import type { BatchLoad, GraphQLContext, GraphQLResultMapper } from './types.ts'

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { HttpPlugin, NotFoundException } from '@znight/http'
import { defineTestMetadata, TestApp, testToken } from '@znight/testing'

import { GraphQLPlugin } from './plugin.ts'
import { executeOperation, subscribeOperation } from './testing.ts'

/** The test functions of the framework running the suite. */
export interface ConformanceTestApi {
  describe(name: string, body: () => void): unknown
  it(name: string, body: () => Promise<void>): unknown
  beforeAll(body: () => Promise<void>): unknown
  afterAll(body: () => Promise<void>): unknown
}

/** Options of {@link describeDriverConformance}. */
export interface DriverConformanceOptions {
  /**
   * A new driver for each application the suite boots (a driver serves one application at a
   * time); `undefined` for the built-in transport.
   */
  readonly driver: () => GraphQLDriver | undefined
  /** `describe`, `it`, `beforeAll` and `afterAll` of the test framework. */
  readonly test: ConformanceTestApi
  /** The adapters to run on, by name (`{ node: () => nodeAdapter(), hono: () => honoAdapter() }`). Default: `HttpPlugin`'s. */
  readonly adapters?: Readonly<Record<string, () => HttpAdapter>>
  /** Whether the driver serves subscriptions over SSE (`subscribeOperation()`). Default `true`. */
  readonly subscriptions?: boolean
}

/**
 * Describes the conformance scenarios of a GraphQL driver (RFC 0009 §12): queries, mutations,
 * field guards and HTTP guards, loaders batching, request-scoped providers, result mappers,
 * masking, introspection, limits, the `graphql:operation` hook, `POST` bodies other than JSON and
 * mutations over `GET` refused (CSRF) and, over SSE, subscriptions (events, completion, client
 * abort, `maxActive`, shutdown whatever the plugin order).
 *
 * ```ts
 * import { describeDriverConformance } from '@znight/graphql/testing'
 * import { yogaDriver } from '@znight/graphql/yoga'
 * import { afterAll, beforeAll, describe, it } from 'bun:test'
 *
 * describeDriverConformance({ driver: () => yogaDriver(), test: { describe, it, beforeAll, afterAll } })
 * ```
 */
export function describeDriverConformance(options: DriverConformanceOptions): void {
  const { test } = options
  const adapters = Object.entries(options.adapters ?? { default: undefined })
  const name = options.driver()?.name ?? 'builtin'
  test.describe(`GraphQL driver conformance: ${name}`, () => {
    for (const [adapterName, adapter] of adapters) {
      test.describe(`${adapterName} adapter`, () => {
        describeOperations(options, name, adapter)
        if (options.subscriptions !== false) describeSubscriptions(options, adapter)
      })
    }
  })
}

// ------------------------------------------------------------------------------------------------
// the application

interface Book {
  readonly id: string
  readonly title: string
  readonly authorId: string
}

interface Author {
  readonly id: string
  readonly name: string
}

interface Events {
  bookAdded: Book
}

/** What the resolvers observed, per application. */
interface Observed {
  readonly batches: (readonly string[])[]
  readonly ended: string[]
  sessions: number
}

const OBSERVED = Symbol('conformance.observed')

class Catalog {
  readonly #pubsub: PubSub<Events>
  readonly #books: Book[] = [
    { id: '1', title: 'Dune', authorId: 'herbert' },
    { id: '2', title: 'Hyperion', authorId: 'simmons' },
    { id: '3', title: 'Children of Dune', authorId: 'herbert' },
  ]
  readonly [OBSERVED]: Observed = { batches: [], ended: [], sessions: 0 }

  constructor(pubsub: PubSub<Events>) {
    this.#pubsub = pubsub
  }

  books(): readonly Book[] {
    return this.#books
  }

  book(args: { id: string }): Book {
    const book = this.#books.find(candidate => candidate.id === args.id)
    if (book === undefined) throw new NotFoundException(`No book ${args.id}`)
    return book
  }

  secret(): string {
    throw new Error('postgres://admin:secret@db')
  }

  async addBook(args: { title: string }): Promise<Book> {
    const book = { id: String(this.#books.length + 1), title: args.title, authorId: 'herbert' }
    this.#books.push(book)
    await this.#pubsub.publish('bookAdded', book)
    return book
  }

  bookAdded(ctx: GraphQLContext): AsyncIterableIterator<Book> {
    return this.#pubsub.subscribe('bookAdded', { signal: ctx.signal })
  }

  async *countdown(args: { from: number }): AsyncGenerator<number> {
    for (let n = args.from; n > 0; n--) yield await Promise.resolve(n)
  }

  async *forever(ctx: GraphQLContext): AsyncGenerator<number> {
    const signal = ctx.signal
    try {
      for (let n = 1; !signal.aborted; n++) {
        yield n
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 10)
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
    } finally {
      this[OBSERVED].ended.push('forever')
    }
  }
}

class AuthorsById implements BatchLoad<string, Author> {
  readonly #catalog: Catalog

  constructor(catalog: Catalog) {
    this.#catalog = catalog
  }

  load(keys: readonly string[]): Promise<readonly Author[]> {
    this.#catalog[OBSERVED].batches.push([...keys])
    return Promise.resolve(keys.map(id => ({ id, name: id === 'herbert' ? 'Frank Herbert' : 'Dan Simmons' })))
  }
}

/** Request-scoped: one per HTTP request, shared by the guard and the resolver of an operation. */
class Session {
  readonly id: number
  readonly user: string | undefined

  constructor(http: HttpContext, catalog: Catalog) {
    this.id = ++catalog[OBSERVED].sessions
    this.user = http.header('x-user')
  }
}

class Viewer {
  readonly #session: Session

  constructor(session: Session) {
    this.#session = session
  }

  me(): { id: number; user: string | null } {
    return { id: this.#session.id, user: this.#session.user ?? null }
  }
}

/** A field guard: editors only, read from the request-scoped session. */
class EditorGuard {
  readonly #session: Session

  constructor(session: Session) {
    this.#session = session
  }

  canResolve(): boolean {
    return this.#session.user === 'editor'
  }
}

/** An HTTP guard on the endpoint (`http.guards`). */
class Gate implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    return ctx.header('x-block') !== 'yes'
  }
}

/** Errors as data (RFC 0008): a missing book is a `NotFound` of `BookResult`. */
class Rejections implements GraphQLResultMapper {
  static readonly types: readonly string[] = ['NotFound']

  toResult(error: unknown): unknown {
    return error instanceof NotFoundException ? { __typename: 'NotFound', message: error.message } : undefined
  }
}

type Invoke = (resolver: never, parent: never, args: never, ctx: never) => unknown

/** The binding of a resolver method (what the compiler generates for `@Query()`, `@ResolveField()`...). */
function resolver(
  cls: { readonly name: string },
  method: string,
  operation: GraphQLResolverOperation,
  invoke: Invoke,
  extra: Partial<GraphQLResolverBinding> = {},
): GraphQLResolverBinding {
  return {
    token: testToken(cls as never),
    method,
    operation,
    guards: [],
    meta: {},
    invoke: invoke as unknown as GraphQLResolverBinding['invoke'],
    ...extra,
  }
}

const ID = [{ name: 'id', type: 'ID!' }]

const TYPES: readonly GraphQLTypeDefinition[] = [
  { kind: 'object', name: 'Author', fields: [{ name: 'name', type: 'String!' }] },
  {
    kind: 'object',
    name: 'Book',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'title', type: 'String!' },
      {
        name: 'author',
        type: 'Author!',
        resolver: resolver(
          Catalog,
          'books',
          'field',
          ((_r: Catalog, parent: Book, _a: unknown, ctx: GraphQLContext) =>
            ctx.loader(testToken(AuthorsById)).load(parent.authorId)) as Invoke,
          { loaders: [testToken(AuthorsById)] },
        ),
      },
    ],
  },
  { kind: 'object', name: 'NotFound', fields: [{ name: 'message', type: 'String!' }] },
  { kind: 'union', name: 'BookResult', members: ['Book', 'NotFound'], discriminator: { by: 'typename' } },
  {
    kind: 'object',
    name: 'Me',
    fields: [
      { name: 'id', type: 'Int!' },
      { name: 'user', type: 'String' },
    ],
  },
  {
    kind: 'object',
    name: 'Query',
    fields: [
      {
        name: 'books',
        type: '[Book!]!',
        resolver: resolver(Catalog, 'books', 'query', ((r: Catalog) => r.books()) as Invoke),
      },
      {
        name: 'book',
        type: 'BookResult!',
        args: ID,
        resolver: resolver(Catalog, 'book', 'query', ((r: Catalog, _p: unknown, a: { id: string }) => ({
          __typename: 'Book',
          ...r.book(a),
        })) as Invoke),
      },
      {
        name: 'secret',
        type: 'String',
        resolver: resolver(Catalog, 'secret', 'query', ((r: Catalog) => r.secret()) as Invoke),
      },
      {
        name: 'me',
        type: 'Me!',
        resolver: resolver(Viewer, 'me', 'query', ((r: Viewer) => r.me()) as Invoke),
      },
    ],
  },
  {
    kind: 'object',
    name: 'Mutation',
    fields: [
      {
        name: 'addBook',
        type: 'Book!',
        args: [{ name: 'title', type: 'String!' }],
        resolver: resolver(
          Catalog,
          'addBook',
          'mutation',
          ((r: Catalog, _p: unknown, a: { title: string }) => r.addBook(a)) as Invoke,
          { guards: [testToken(EditorGuard)] },
        ),
      },
    ],
  },
  {
    kind: 'object',
    name: 'Subscription',
    fields: [
      {
        name: 'bookAdded',
        type: 'Book!',
        resolver: resolver(Catalog, 'bookAdded', 'subscription', ((
          r: Catalog,
          _p: unknown,
          _a: unknown,
          c: GraphQLContext,
        ) => r.bookAdded(c)) as Invoke),
      },
      {
        name: 'countdown',
        type: 'Int!',
        args: [{ name: 'from', type: 'Int!' }],
        resolver: resolver(Catalog, 'countdown', 'subscription', ((r: Catalog, _p: unknown, a: { from: number }) =>
          r.countdown(a)) as Invoke),
      },
      {
        name: 'forever',
        type: 'Int!',
        resolver: resolver(Catalog, 'forever', 'subscription', ((
          r: Catalog,
          _p: unknown,
          _a: unknown,
          c: GraphQLContext,
        ) => r.forever(c)) as Invoke),
      },
    ],
  },
]

function conformanceMetadata() {
  return defineTestMetadata({
    providers: [
      { class: Catalog, deps: ['@znight/graphql#PubSub'] },
      { class: AuthorsById, deps: [Catalog] },
      { class: Session, scope: 'request', deps: ['@znight/http#HttpContext', Catalog] },
      { class: Viewer, scope: 'request', deps: [Session] },
      { class: EditorGuard, scope: 'request', deps: [Session] },
      Gate,
      Rejections,
    ],
    externals: [
      { token: '@znight/graphql#GraphQLContext', scope: 'request', providedBy: 'GraphQLPlugin' },
      { token: '@znight/graphql#PubSub', providedBy: 'GraphQLPlugin' },
      { token: '@znight/graphql#GraphQLPlugin', providedBy: 'GraphQLPlugin' },
      { token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
      { token: '@znight/http#RequestId', scope: 'request', providedBy: 'HttpPlugin' },
    ],
    extensions: {
      graphql: {
        version: 1,
        schemaHash: 'c0nf0rmance00000',
        roots: { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' },
        types: [...TYPES].sort((a, b) => (a.name < b.name ? -1 : 1)),
      },
    },
  })
}

/** The drain timeout of `HttpPlugin` in the suite: a shutdown waiting for it is a failure. */
const DRAIN_TIMEOUT_MS = 5_000

/**
 * Boots the conformance application on `adapter` with `driver`, `GraphQLPlugin` after `HttpPlugin`
 * (or before it, `graphqlFirst`).
 */
function boot(
  options: DriverConformanceOptions,
  adapter: (() => HttpAdapter) | undefined,
  graphqlFirst = false,
): Promise<TestApp> {
  const driver = options.driver()
  const http = HttpPlugin.configure({
    port: 0,
    host: '127.0.0.1',
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    ...(adapter === undefined ? {} : { adapter: adapter() }),
  })
  const graphql = GraphQLPlugin.configure({
    introspection: false,
    resultMappers: [Rejections],
    limits: { maxAliases: 3, maxDepth: 4 },
    http: { guards: [Gate] },
    subscriptions: { maxActive: 2 },
    ...(driver === undefined ? {} : { driver }),
  })
  return TestApp.create({
    metadata: conformanceMetadata(),
    plugins: graphqlFirst ? [graphql, http] : [http, graphql],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
}

function observed(app: TestApp): Observed {
  return (app.get(testToken(Catalog) as never) as Catalog)[OBSERVED]
}

function graphql(app: TestApp): GraphQLPlugin {
  return app.app.getPlugin('graphql') as GraphQLPlugin
}

async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`conformance: ${what} did not happen within ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function codes(result: OperationResult): readonly unknown[] {
  return (result.errors ?? []).map(error => error.extensions?.['code'])
}

function result(response: OperationResponse): OperationResult {
  return {
    ...('data' in response ? { data: response.data } : {}),
    ...(response.errors === undefined ? {} : { errors: response.errors }),
  }
}

// ------------------------------------------------------------------------------------------------
// the scenarios

function describeOperations(
  options: DriverConformanceOptions,
  driverName: string,
  adapter: (() => HttpAdapter) | undefined,
): void {
  const { test } = options
  let app: TestApp
  const events: { driver: string; transport: string; operationName: string | undefined }[] = []

  test.beforeAll(async () => {
    app = await boot(options, adapter)
    app.app.hooks.on('graphql:operation', event => {
      events.push({ driver: event.driver, transport: event.transport, operationName: event.operationName })
    })
  })
  test.afterAll(async () => {
    await app?.close()
  })

  test.it('executes queries, with field resolvers batched through a loader', async () => {
    const response = await executeOperation(app, { query: '{ books { title author { name } } }' })
    strictEqual(response.status, 200)
    deepStrictEqual(result(response), {
      data: {
        books: [
          { title: 'Dune', author: { name: 'Frank Herbert' } },
          { title: 'Hyperion', author: { name: 'Dan Simmons' } },
          { title: 'Children of Dune', author: { name: 'Frank Herbert' } },
        ],
      },
    })
    deepStrictEqual(observed(app).batches.at(-1), ['herbert', 'simmons'])
  })

  test.it('executes mutations behind a field guard reading a request-scoped provider', async () => {
    const denied = await executeOperation(app, { query: 'mutation { addBook(title: "Ilium") { title } }' })
    strictEqual(denied.status, 200)
    deepStrictEqual(denied.data, null)
    deepStrictEqual(codes(denied), ['FORBIDDEN'])
    const added = await executeOperation(app, {
      query: 'mutation Add($title: String!) { addBook(title: $title) { title author { name } } }',
      variables: { title: 'Ilium' },
      headers: { 'x-user': 'editor' },
    })
    deepStrictEqual(result(added), { data: { addBook: { title: 'Ilium', author: { name: 'Frank Herbert' } } } })
  })

  test.it('creates request-scoped providers once per request', async () => {
    const first = await executeOperation<{ a: { id: number }; b: { id: number; user: string } }>(app, {
      query: '{ a: me { id } b: me { id user } }',
      headers: { 'x-user': 'ada' },
    })
    const second = await executeOperation<{ me: { id: number } }>(app, { query: '{ me { id } }' })
    ok(first.data !== undefined && first.data !== null && second.data !== undefined && second.data !== null)
    strictEqual(first.data.a.id, first.data.b.id)
    strictEqual(first.data.b.user, 'ada')
    ok(second.data.me.id > first.data.a.id)
  })

  test.it('turns errors into data with result mappers, and masks unexpected errors', async () => {
    const missing = await executeOperation(app, {
      query: '{ book(id: "404") { __typename ... on NotFound { message } ... on Book { title } } }',
    })
    deepStrictEqual(result(missing), { data: { book: { __typename: 'NotFound', message: 'No book 404' } } })
    const secret = await executeOperation(app, { query: '{ secret }' })
    strictEqual(secret.status, 200)
    deepStrictEqual(result(secret), {
      data: { secret: null },
      errors: [
        {
          message: 'Unexpected error.',
          locations: [{ line: 1, column: 3 }],
          path: ['secret'],
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
      ],
    })
    ok(!secret.body.includes('postgres'), 'the original error leaked')
  })

  test.it('refuses introspection, documents past the limits and invalid documents (400)', async () => {
    for (const [query, code] of [
      ['{ __schema { queryType { name } } }', 'GRAPHQL_VALIDATION_FAILED'],
      ['{ a: me { id } b: me { id } c: me { id } d: me { id } }', 'QUERY_TOO_COMPLEX'],
      ['{ books { author { name } author2: author { name } } }', undefined],
      ['{ nope }', 'GRAPHQL_VALIDATION_FAILED'],
      ['{ books', 'GRAPHQL_PARSE_FAILED'],
    ] as const) {
      const response = await executeOperation(app, { query })
      if (code === undefined) {
        strictEqual(response.status, 200, query)
        continue
      }
      strictEqual(response.status, 400, query)
      strictEqual(response.data, undefined, query)
      deepStrictEqual([...new Set(codes(response))], [code], query)
    }
  })

  test.it('runs behind the HTTP guards of the endpoint', async () => {
    const blocked = await executeOperation(app, { query: '{ books { title } }', headers: { 'x-block': 'yes' } })
    strictEqual(blocked.status, 403)
    strictEqual(blocked.data, undefined)
  })

  test.it('reports every executed operation to the graphql:operation hook, with the driver', async () => {
    events.length = 0
    await executeOperation(app, { query: 'query Named { books { id } }' })
    deepStrictEqual(events, [{ driver: driverName, transport: 'http', operationName: 'Named' }])
  })

  test.it('refuses POST bodies other than JSON (415): a cross-site form never runs an operation', async () => {
    const mutation = 'mutation { addBook(title: "Forged") { id } }'
    const before = await executeOperation<{ books: unknown[] }>(app, { query: '{ books { id } }' })
    for (const [type, body] of [
      ['application/x-www-form-urlencoded', `query=${encodeURIComponent(mutation)}`],
      [
        'multipart/form-data; boundary=x',
        `--x\r\ncontent-disposition: form-data; name="query"\r\n\r\n${mutation}\r\n--x--\r\n`,
      ],
      ['text/plain', JSON.stringify({ query: mutation })],
      ['application/graphql', mutation],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': type, 'x-user': 'editor' },
        body,
      })
      strictEqual(response.status, 415, type)
      deepStrictEqual(
        response.json(),
        {
          errors: [
            {
              message: 'Send GraphQL requests as application/json (content-type: application/json)',
              extensions: { code: 'BAD_REQUEST' },
            },
          ],
        },
        type,
      )
    }
    const after = await executeOperation<{ books: unknown[] }>(app, { query: '{ books { id } }' })
    strictEqual(after.data?.books.length, before.data?.books.length)
  })

  test.it('refuses mutations over GET (405, allow: POST)', async () => {
    const before = await executeOperation<{ books: unknown[] }>(app, { query: '{ books { id } }' })
    const response = await app.inject({
      method: 'GET',
      url: '/graphql',
      query: { query: 'mutation { addBook(title: "Fetched") { id } }' },
      headers: { 'x-user': 'editor' },
    })
    strictEqual(response.status, 405)
    strictEqual(response.headers['allow'], 'POST')
    const after = await executeOperation<{ books: unknown[] }>(app, { query: '{ books { id } }' })
    strictEqual(after.data?.books.length, before.data?.books.length)
  })
}

function describeSubscriptions(options: DriverConformanceOptions, adapter: (() => HttpAdapter) | undefined): void {
  const { test } = options
  let app: TestApp

  test.beforeAll(async () => {
    app = await boot(options, adapter)
  })
  test.afterAll(async () => {
    await app?.close()
  })

  test.it('streams the events of a subscription until the client leaves', async () => {
    const events = await subscribeOperation(app, { query: 'subscription { bookAdded { title } }' })
    strictEqual(events.status, 200)
    await executeOperation(app, {
      query: 'mutation { addBook(title: "Endymion") { id } }',
      headers: { 'x-user': 'editor' },
    })
    deepStrictEqual((await events.next()).value, { data: { bookAdded: { title: 'Endymion' } } })
    await events.return()
    await until(() => graphql(app).activeSubscriptions === 0, 'the end of the subscription')
  })

  test.it('completes a finite subscription', async () => {
    const events = await subscribeOperation(app, { query: 'subscription { countdown(from: 2) }' })
    deepStrictEqual(await drain(events), [{ data: { countdown: 2 } }, { data: { countdown: 1 } }])
  })

  test.it('ends the source when the client aborts, and caps the active subscriptions', async () => {
    const ended = observed(app).ended
    ended.length = 0
    const first = await subscribeOperation(app, { query: 'subscription { forever }' })
    const second = await subscribeOperation(app, { query: 'subscription { forever }' })
    deepStrictEqual((await first.next()).value, { data: { forever: 1 } })
    deepStrictEqual((await second.next()).value, { data: { forever: 1 } })
    const third = await subscribeOperation(app, { query: 'subscription { forever }' })
    const refused = await third.next()
    deepStrictEqual(codes(refused.value ?? {}), ['SERVICE_UNAVAILABLE'])
    await third.return()
    await first.return()
    await second.return()
    await until(() => ended.length === 2, 'the end of both sources')
    await until(() => graphql(app).activeSubscriptions === 0, 'the end of the subscriptions')
  })

  for (const graphqlFirst of [false, true]) {
    const order = graphqlFirst ? 'GraphQLPlugin before HttpPlugin' : 'HttpPlugin before GraphQLPlugin'
    test.it(`ends the subscriptions when the application stops, without waiting for the drain (${order})`, async () => {
      const stopping = await boot(options, adapter, graphqlFirst)
      const ended = observed(stopping).ended
      const events = await subscribeOperation(stopping, { query: 'subscription { forever }' })
      deepStrictEqual((await events.next()).value, { data: { forever: 1 } })
      // the client keeps reading, as a real one does (the stream ends once read)
      const rest = drain(events)
      const started = Date.now()
      await stopping.close()
      const elapsed = Date.now() - started
      ok(elapsed < DRAIN_TIMEOUT_MS / 2, `the shutdown waited ${elapsed} ms for the drain`)
      await until(() => ended.includes('forever'), 'the end of the source on shutdown')
      await rest
      strictEqual(graphql(stopping).activeSubscriptions, 0)
    })
  }
}

async function drain(events: OperationStream): Promise<OperationResult[]> {
  const results: OperationResult[] = []
  for (let step = await events.next(); step.done !== true; step = await events.next()) results.push(step.value)
  return results
}
