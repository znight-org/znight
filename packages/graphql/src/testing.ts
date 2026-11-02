/**
 * `@znight/graphql/testing`: test helpers for GraphQL applications (RFC 0005 §5.12).
 *
 * - `executeOperation()` sends an operation through the whole HTTP pipeline of a `TestApp`
 *   (`app.inject()`: guards, hooks, every adapter) or, without HTTP transport, through
 *   `GraphQLPlugin.execute()`;
 * - `subscribeOperation()` streams an operation over GraphQL over SSE in memory, or through
 *   `GraphQLPlugin.subscribe()` without HTTP transport;
 * - `fakeLoader()` builds a `Loader<L>` whose `load` / `loadMany` are spies of the running test
 *   framework (`bun:test`, Vitest, Jest, or the built-in spy of `@znight/testing`).
 *
 * Needs `@znight/testing` (an optional peer dependency of `@znight/graphql`).
 */
import type { Plugin } from '@znight/core'
import type { SseItem } from '@znight/http'
import type { MockFunction, TestApp } from '@znight/testing'
import type { FormattedExecutionResult, GraphQLFormattedError } from 'graphql'
import type { GraphQLRequest, GraphQLResultStream } from './execution.ts'
import type { BatchLoad, BatchLoader, LoaderKey, LoaderValue } from './types.ts'

import { parseSseStream } from '@znight/http'
import { resolveMockFn } from '@znight/testing'

import { endpointOf, executorOf, type GraphQLPlugin } from './plugin.ts'

/** An operation for {@link executeOperation} and {@link subscribeOperation}. */
export interface OperationRequest {
  readonly query: string
  readonly variables?: Readonly<Record<string, unknown>>
  readonly operationName?: string
  readonly extensions?: Readonly<Record<string, unknown>>
  /**
   * Request headers (`x-api-key`, `accept`...), merged over the defaults (`content-type:
   * application/json`, and `accept: application/graphql-response+json, application/json;q=0.9`
   * or `text/event-stream`). Ignored without HTTP transport.
   */
  readonly headers?: Readonly<Record<string, string>>
}

/** A GraphQL result: `data`, `errors` and `extensions` when present. */
export interface OperationResult<TData = Record<string, unknown>> {
  readonly data?: TData | null
  readonly errors?: readonly GraphQLFormattedError[]
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** What {@link executeOperation} resolves with. */
export interface OperationResponse<TData = Record<string, unknown>> extends OperationResult<TData> {
  /**
   * The HTTP status: 200 for an executed operation (field errors included), 400 for a request
   * error (the default `accept` is `application/graphql-response+json`), 403 for an HTTP guard...
   * Without HTTP transport, the status the endpoint would answer.
   */
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  /** The raw body (an HTTP error body is not a GraphQL result: `data` and `errors` are then absent). */
  readonly body: string
}

/** Options of {@link OperationStream.next}. */
export interface OperationStreamWaitOptions {
  /** Maximum wait for the next result (ms). Default 2 000. */
  readonly timeoutMs?: number
}

/**
 * The results of {@link subscribeOperation}, one per `next` event. Ends after `complete` (or the
 * single result of a query, or a request error). `return()` disconnects: the server sees a client
 * abort (`ctx.signal`, then the source's `return()`).
 */
export interface OperationStream<TData = Record<string, unknown>>
  extends AsyncIterableIterator<OperationResult<TData>>,
    AsyncDisposable {
  /** HTTP status of the stream (200), or of a request error (400, 405, 503...). */
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  /** The next result. Rejects when none arrives within `timeoutMs` (2 000 ms by default). */
  next(options?: OperationStreamWaitOptions): Promise<IteratorResult<OperationResult<TData>, undefined>>
  /** Ends the stream (disconnects). */
  return(): Promise<IteratorResult<OperationResult<TData>, undefined>>
}

/** The application `executeOperation()` and `subscribeOperation()` run against: a `TestApp`. */
export type GraphQLTestApp = Pick<TestApp, 'app' | 'inject' | 'injectStream'>

const DEFAULT_TIMEOUT_MS = 2_000
const RESPONSE_ACCEPT = 'application/graphql-response+json, application/json;q=0.9'
const DONE: IteratorResult<never, undefined> = Object.freeze({ done: true, value: undefined })

/**
 * Executes a query or a mutation through the whole HTTP pipeline (`app.inject()`: `POST` on the
 * endpoint), or through `GraphQLPlugin` without HTTP transport.
 *
 * ```ts
 * const res = await executeOperation(app, { query: '{ books { title } }', headers: { 'x-api-key': KEY } })
 * expect(res.status).toBe(200)
 * expect(res.errors).toBeUndefined()
 * ```
 */
export async function executeOperation<TData = Record<string, unknown>>(
  app: GraphQLTestApp,
  request: OperationRequest,
): Promise<OperationResponse<TData>> {
  const plugin = graphqlPlugin(app, 'executeOperation()')
  const body = operationBody(request, 'executeOperation()')
  const endpoint = endpointOf(plugin)
  if (endpoint === undefined) {
    const response = await executorOf(plugin).execute(body)
    return {
      ...pick<TData>(response.result),
      status: response.status,
      headers: { ...response.headers },
      body: JSON.stringify(response.result),
    }
  }
  const response = await app.inject({
    method: 'POST',
    url: endpoint,
    headers: headers(request, RESPONSE_ACCEPT),
    body: JSON.stringify(body),
  })
  return {
    ...parseResult<TData>(response.body),
    status: response.status,
    headers: response.headers,
    body: response.body,
  }
}

/**
 * Starts an operation as a stream: GraphQL over SSE in memory (`app.injectStream()`: `POST` with
 * `accept: text/event-stream`), or `GraphQLPlugin.subscribe()` without HTTP transport (no HTTP
 * guards then). Resolves once the subscription is started: events published from then on are
 * received.
 *
 * ```ts
 * await using events = await subscribeOperation(app, { query: 'subscription { bookAdded { title } }' })
 * await executeOperation(app, { query: ADD_DUNE })
 * expect((await events.next()).value).toEqual({ data: { bookAdded: { title: 'Dune' } } })
 * ```
 */
export async function subscribeOperation<TData = Record<string, unknown>>(
  app: GraphQLTestApp,
  request: OperationRequest,
): Promise<OperationStream<TData>> {
  const plugin = graphqlPlugin(app, 'subscribeOperation()')
  const body = operationBody(request, 'subscribeOperation()')
  const endpoint = endpointOf(plugin)
  const label = describeOperation(body.query)
  if (endpoint === undefined) {
    const outcome = await executorOf(plugin).subscribe(body)
    if ('status' in outcome) return new SingleResult(outcome.status, {}, pick<TData>(outcome.result))
    return new Results<TData>(200, {}, directSource(outcome), label)
  }
  const response = await app.injectStream({
    method: 'POST',
    url: endpoint,
    headers: headers(request, 'text/event-stream'),
    body: JSON.stringify(body),
  })
  const type = response.headers['content-type']
  if (typeof type !== 'string' || !type.startsWith('text/event-stream')) {
    const text = await new Response(response.body).text()
    return new SingleResult(response.status, response.headers, parseResult<TData>(text))
  }
  return new Results<TData>(response.status, response.headers, sseSource(parseSseStream(response.body)), label)
}

/** Options of {@link fakeLoader}: what a key resolves to. */
export type FakeLoaderValues<K, V> =
  | Readonly<Record<string, V | Error>>
  | ReadonlyMap<K, V | Error>
  | ((key: K) => V | Error | Promise<V | Error>)

/** A `Loader<L>` built by {@link fakeLoader}: `load` and `loadMany` are spies. */
export interface FakeLoader<K, V> extends BatchLoader<K, V> {
  readonly load: MockFunction<(key: K) => Promise<V>> & ((key: K) => Promise<V>)
  readonly loadMany: MockFunction<(keys: readonly K[]) => Promise<(V | Error)[]>> &
    ((keys: readonly K[]) => Promise<(V | Error)[]>)
}

/**
 * A `Loader<L>` for unit tests of resolvers (with `TestBed`), answering from `values` (a record by
 * key, a map, or a function of the key; an `Error` value fails that key). `load` and `loadMany` are
 * spies; a missing key rejects.
 *
 * ```ts
 * const authors = fakeLoader<AuthorsById>({ [herbert.id]: herbert })
 * expect(await instance.author(dune, authors)).toBe(herbert)
 * expect(authors.load).toHaveBeenCalledWith(herbert.id)
 * ```
 */
export function fakeLoader<L extends BatchLoad<unknown, unknown>>(
  values: FakeLoaderValues<LoaderKey<L>, LoaderValue<L>>,
): FakeLoader<LoaderKey<L>, LoaderValue<L>> {
  type K = LoaderKey<L>
  type V = LoaderValue<L>
  const resolve = lookup<K, V>(values)
  const cache = new Map<unknown, Promise<V>>()
  const loadOne = (key: K): Promise<V> => {
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const loaded = Promise.resolve()
      .then(() => resolve(key))
      .then(value => (value instanceof Error ? Promise.reject(value) : value))
    cache.set(key, loaded)
    return loaded
  }
  const create = resolveMockFn().create
  const load = create((key: K) => loadOne(key)) as FakeLoader<K, V>['load']
  const loadMany = create((keys: readonly K[]) =>
    Promise.all(keys.map(key => loadOne(key).catch((error: unknown) => asError(error)))),
  ) as FakeLoader<K, V>['loadMany']
  const loader: FakeLoader<K, V> = {
    load,
    loadMany,
    clear(key: K) {
      cache.delete(key)
      return this
    },
    clearAll() {
      cache.clear()
      return this
    },
    prime(key: K, value: V | PromiseLike<V> | Error) {
      if (!cache.has(key)) {
        const primed = value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
        primed.catch(() => undefined)
        cache.set(key, primed)
      }
      return this
    },
  }
  return loader
}

// ------------------------------------------------------------------------------------------------

function graphqlPlugin(app: GraphQLTestApp, what: string): GraphQLPlugin {
  const plugin = app?.app?.getPlugin<Plugin>('graphql')
  if (plugin === undefined) {
    throw new TypeError(`${what} expects a TestApp whose plugins include GraphQLPlugin.configure()`)
  }
  return plugin as GraphQLPlugin
}

function operationBody(request: OperationRequest, what: string): GraphQLRequest {
  if (request === null || typeof request !== 'object' || typeof request.query !== 'string') {
    throw new TypeError(`${what} expects { query, variables?, operationName?, extensions?, headers? }`)
  }
  return {
    query: request.query,
    ...(request.variables === undefined ? {} : { variables: request.variables }),
    ...(request.operationName === undefined ? {} : { operationName: request.operationName }),
    ...(request.extensions === undefined ? {} : { extensions: request.extensions }),
  }
}

/** The request headers: the defaults, then the operation's (names lower-cased, so they replace the defaults). */
function headers(request: OperationRequest, accept: string): Record<string, string> {
  const result: Record<string, string> = { 'content-type': 'application/json', accept }
  for (const [name, value] of Object.entries(request.headers ?? {})) result[name.toLowerCase()] = value
  return result
}

function pick<TData>(result: FormattedExecutionResult): OperationResult<TData> {
  return {
    ...('data' in result ? { data: result.data as TData | null } : {}),
    ...(result.errors === undefined ? {} : { errors: result.errors }),
    ...(result.extensions === undefined ? {} : { extensions: result.extensions }),
  }
}

/** The GraphQL result of a body; `{}` when it is not one (an HTTP error body, a page). */
function parseResult<TData>(body: string): OperationResult<TData> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const result = parsed as FormattedExecutionResult
  if (!('data' in result) && !Array.isArray(result.errors)) return {}
  return pick<TData>(result)
}

function describeOperation(query: string): string {
  const text = query.replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function lookup<K, V>(values: FakeLoaderValues<K, V>): (key: K) => V | Error | Promise<V | Error> {
  if (typeof values === 'function') return values
  if (values instanceof Map) {
    return key => (values.has(key) ? (values.get(key) as V | Error) : missing(key))
  }
  const record = values as Readonly<Record<string, V | Error>>
  return key => (Object.hasOwn(record, String(key)) ? (record[String(key)] as V | Error) : missing(key))
}

function missing(key: unknown): Error {
  return new Error(`fakeLoader(): no value for the key ${JSON.stringify(key) ?? String(key)}`)
}

/** A source of results: `undefined` when it ended. */
interface ResultSource {
  next(): Promise<FormattedExecutionResult | undefined>
  close(): Promise<void>
}

function directSource(stream: GraphQLResultStream): ResultSource {
  return {
    next: async () => {
      const step = await stream.next()
      return step.done === true ? undefined : step.value
    },
    close: async () => {
      await stream.return()
    },
  }
}

/** The `next` events of an event stream, until `complete` (comments, `retry` and other events skipped). */
function sseSource(items: AsyncIterableIterator<SseItem>): ResultSource {
  return {
    next: async () => {
      for (;;) {
        const step = await items.next()
        if (step.done === true) return undefined
        const item = step.value
        if (item.type !== 'event') continue
        if (item.event === 'complete') return undefined
        if (item.event === 'next') return JSON.parse(item.data) as FormattedExecutionResult
      }
    },
    close: async () => {
      await items.return?.()
    },
  }
}

/** The stream of a subscription (or of a query sent as a stream). */
class Results<TData> implements OperationStream<TData> {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly #source: ResultSource
  readonly #label: string
  /** A read still pending after a timeout: the next call waits for it, so no result is lost. */
  #pending: Promise<FormattedExecutionResult | undefined> | undefined
  #ended = false

  constructor(
    status: number,
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    source: ResultSource,
    label: string,
  ) {
    this.status = status
    this.headers = headers
    this.#source = source
    this.#label = label
  }

  async next(options: OperationStreamWaitOptions = {}): Promise<IteratorResult<OperationResult<TData>, undefined>> {
    if (this.#ended) return DONE
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#pending ??= this.#source.next()
    const pending = this.#pending
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMEOUT>(resolve => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
    })
    let result: FormattedExecutionResult | undefined | typeof TIMEOUT
    try {
      result = await Promise.race([pending, timeout])
    } catch (error) {
      this.#pending = undefined
      await this.return()
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (result === TIMEOUT) {
      throw new Error(`subscribeOperation(): no result within ${timeoutMs} ms for ${this.#label}`)
    }
    this.#pending = undefined
    if (result === undefined) {
      await this.return()
      return DONE
    }
    return { done: false, value: pick<TData>(result) }
  }

  async return(): Promise<IteratorResult<OperationResult<TData>, undefined>> {
    if (!this.#ended) {
      this.#ended = true
      await this.#source.close()
    }
    return DONE
  }

  [Symbol.asyncIterator](): OperationStream<TData> {
    return this
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.return().then(() => undefined)
  }
}

const TIMEOUT: unique symbol = Symbol('timeout')

/** A request error (or a query's result without HTTP transport): one result, then the end. */
class SingleResult<TData> implements OperationStream<TData> {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  #result: OperationResult<TData> | undefined

  constructor(
    status: number,
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    result: OperationResult<TData>,
  ) {
    this.status = status
    this.headers = headers
    this.#result = result
  }

  next(): Promise<IteratorResult<OperationResult<TData>, undefined>> {
    const result = this.#result
    this.#result = undefined
    return Promise.resolve(result === undefined ? DONE : { done: false, value: result })
  }

  return(): Promise<IteratorResult<OperationResult<TData>, undefined>> {
    this.#result = undefined
    return Promise.resolve(DONE)
  }

  [Symbol.asyncIterator](): OperationStream<TData> {
    return this
  }

  [Symbol.asyncDispose](): Promise<void> {
    return Promise.resolve()
  }
}
