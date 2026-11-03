/**
 * GraphQL over HTTP (RFC 0005 §8.3, GraphQL-over-HTTP specification draft), the handlers of the two
 * plugin routes of the endpoint (`GET` and `POST` on `path`).
 *
 * - `POST`: `application/json` bodies only (415 otherwise: no form or text body, so cross-site
 *   requests are always preflighted), read by the handler so that every malformed request gets a
 *   GraphQL-shaped error (malformed JSON, missing query, batching: 400; body limit: 413).
 * - `GET`: queries only (405 with `allow: POST` otherwise), when `http.get` is on; GraphiQL with
 *   `accept: text/html` when enabled.
 * - The response is `application/graphql-response+json` when the client lists it (200 with data,
 *   400 for request errors), otherwise `application/json` (200 for every well-formed request); no
 *   `accept` header is `application/json`; nothing acceptable is 406. `accept: text/event-stream`
 *   selects GraphQL over SSE for any operation.
 *
 * Hot path (a cached query whose resolvers are synchronous): a memoised negotiation (a map lookup),
 * the query string read without `URLSearchParams` or the body read and parsed once, one options
 * object and one deferred abort per request, the executor's synchronous result, and a single
 * `JSON.stringify` by the serialiser. Every answer stays on the fast lane of `@znight/http` (no
 * promise while the route is synchronous, headers from a template) unless the application adds
 * CORS, guards, `http:request` listeners or wrappers: a `GET` answered as `application/json` with
 * status 200 returns the plain result; the other answers are an `HttpResponse` with a plain JSON
 * body, at most a `content-type` header and an explicit status (a `POST` route answers 201 by
 * default), which the fast lane serves too.
 */
import type { HttpContext, SseOptions } from '@znight/http'
import type { FormattedExecutionResult } from 'graphql'
import type { ExecuteOptions, GraphQLExecutor, GraphQLRequest, GraphQLResponse } from '../execution.ts'

import { HttpResponse, isHttpException, parseMediaType } from '@znight/http'

import { GraphQLErrorCode } from '../errors.ts'
import { DeferredAbort } from './abort.ts'
import { Media, type MediaKind, Negotiator } from './accept.ts'
import { renderGraphiQL } from './graphiql.ts'
import { ResultEvents } from './sse.ts'

/** What the transport is built from (resolved plugin options). */
export interface HttpTransportOptions {
  /** The executor of the plugin, built at bootstrap (after the routes may have been collected). */
  readonly executor: () => GraphQLExecutor
  /** Absolute path of the endpoint, prefix included (GraphiQL's fetcher). */
  readonly endpoint: string
  /** Queries over `GET`. */
  readonly get: boolean
  readonly graphiql: boolean
  /** `HttpResponse.sse()` options of GraphQL over SSE; `false`: no event streams. */
  readonly sse: SseOptions | false
}

const JSON_TYPE = 'application/json; charset=utf-8'
const GRAPHQL_JSON_TYPE = 'application/graphql-response+json; charset=utf-8'

/** Response options of `application/graphql-response+json` replies, by status. */
const GRAPHQL_JSON_200 = Object.freeze({ status: 200, headers: Object.freeze({ 'content-type': GRAPHQL_JSON_TYPE }) })
const GRAPHQL_JSON_400 = Object.freeze({ status: 400, headers: Object.freeze({ 'content-type': GRAPHQL_JSON_TYPE }) })
/** `application/json` is what the serialiser gives an object body: only the status is set. */
const JSON_200 = Object.freeze({ status: 200 })

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** A request error before execution: `{ errors: [{ message, extensions: { code } }] }`. */
function errorBody(message: string, code: string = GraphQLErrorCode.BadRequest): FormattedExecutionResult {
  return { errors: [{ message, extensions: { code } }] }
}

/** A reply of `status` carrying a GraphQL error body in the negotiated JSON type (`application/json` before negotiation). */
function errorReply(
  media: MediaKind,
  status: number,
  body: FormattedExecutionResult,
  headers?: Readonly<Record<string, string>>,
): HttpResponse<FormattedExecutionResult> {
  const type = media === Media.GraphQLJson ? GRAPHQL_JSON_TYPE : JSON_TYPE
  return new HttpResponse(body, { status, headers: { ...headers, 'content-type': type } })
}

const NOT_ACCEPTABLE = errorReply(
  Media.Json,
  406,
  errorBody(
    'None of the accepted media types can be produced: accept application/graphql-response+json, application/json or text/event-stream',
  ),
)
const GET_NOT_ALLOWED = errorReply(
  Media.Json,
  405,
  errorBody('GraphQL operations are sent with POST on this endpoint'),
  Object.freeze({ allow: 'POST' }),
)

/** `content-type` values of JSON bodies seen most often, compared before parsing. */
function isJsonRequest(contentType: string | undefined): boolean {
  if (contentType === 'application/json' || contentType === 'application/json; charset=utf-8') return true
  // parsed once per distinct value (memoised by @znight/http)
  const media = parseMediaType(contentType)
  if (media === undefined || media.type !== 'application/json') return false
  return media.charset === undefined || media.charset === 'utf-8' || media.charset === 'utf8'
}

/** Why the parameters of a request are invalid, `undefined` when they are valid. */
function invalidParams(params: Readonly<Record<string, unknown>>): string | undefined {
  const query = params['query']
  if (typeof query !== 'string') {
    return query === undefined || query === null
      ? 'Missing query: send { query, variables?, operationName?, extensions? }'
      : 'The query must be a string'
  }
  const operationName = params['operationName']
  if (operationName !== undefined && operationName !== null && typeof operationName !== 'string') {
    return 'operationName must be a string'
  }
  if (!isMapOrNull(params['variables'])) return 'variables must be an object'
  if (!isMapOrNull(params['extensions'])) return 'extensions must be an object'
  return undefined
}

/** The parameters of a GraphQL `GET` request. */
const GET_PARAMS = ['query', 'operationName', 'variables', 'extensions'] as const

type GetParams = Partial<Record<(typeof GET_PARAMS)[number], string | string[]>>

/** A query string component decoded like `URLSearchParams` (`+` is a space); `undefined` when malformed. */
function decodeComponent(text: string): string | undefined {
  if (text.indexOf('%') === -1 && text.indexOf('+') === -1) return text
  try {
    return decodeURIComponent(text.replaceAll('+', ' '))
  } catch {
    return undefined
  }
}

/**
 * The GraphQL parameters of a request target, read directly: `ctx.query` builds a record of every
 * parameter through `URLSearchParams` (about 0.35 µs of a `GET` on Node.js, 0.15 µs on Bun, see
 * `test/bench/http.bench.ts`). A repeated parameter
 * becomes an array, like `ctx.query`. `undefined` when a component is malformed percent-encoding:
 * the caller falls back to `ctx.query` (which keeps such sequences as they are).
 */
function readGetParams(url: string): GetParams | undefined {
  const params: GetParams = {}
  const mark = url.indexOf('?')
  if (mark === -1) return params
  const length = url.length
  let start = mark + 1
  while (start < length) {
    let end = url.indexOf('&', start)
    if (end === -1) end = length
    if (end > start) {
      let equals = url.indexOf('=', start)
      if (equals === -1 || equals > end) equals = end
      const name = decodeComponent(url.slice(start, equals))
      if (name === undefined) return undefined
      if (name === 'query' || name === 'operationName' || name === 'variables' || name === 'extensions') {
        const value = equals === end ? '' : decodeComponent(url.slice(equals + 1, end))
        if (value === undefined) return undefined
        const existing = params[name]
        if (existing === undefined) params[name] = value
        else params[name] = typeof existing === 'string' ? [existing, value] : [...existing, value]
      }
    }
    start = end + 1
  }
  return params
}

function isMapOrNull(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value))
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

/** The handlers of the GraphQL endpoint. */
export class HttpTransport {
  readonly #resolveExecutor: () => GraphQLExecutor
  #executor: GraphQLExecutor | undefined
  readonly #getQueries: boolean
  readonly #sse: SseOptions | false
  readonly #post: Negotiator
  readonly #get: Negotiator
  /** The GraphiQL page, `undefined` when disabled. */
  readonly #graphiql: HttpResponse<Uint8Array> | undefined

  constructor(options: HttpTransportOptions) {
    this.#resolveExecutor = options.executor
    this.#getQueries = options.get
    this.#sse = options.sse
    const json = (1 << Media.GraphQLJson) | (1 << Media.Json) | (options.sse === false ? 0 : 1 << Media.EventStream)
    this.#post = new Negotiator(json)
    this.#get = new Negotiator(options.graphiql ? json | (1 << Media.Html) : json)
    if (options.graphiql) {
      const page = renderGraphiQL(options.endpoint)
      // encoded once: the same immutable response serves every request
      this.#graphiql = new HttpResponse(new TextEncoder().encode(page.html), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': page.csp,
          'cache-control': 'no-store',
        },
      })
    }
  }

  /** `POST path`. */
  readonly post = (ctx: HttpContext): unknown => {
    const headers = ctx.headers
    const media = this.#post.choose(headers['accept'])
    if (media === Media.None) return NOT_ACCEPTABLE
    if (!isJsonRequest(headers['content-type'])) {
      return errorReply(
        media,
        415,
        errorBody('Send GraphQL requests as application/json (content-type: application/json)'),
      )
    }
    const encoding = headers['content-encoding']
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity' && encoding.trim() !== '') {
      return errorReply(media, 415, errorBody(`Unsupported content encoding "${encoding}"`))
    }
    return ctx.rawBody().then(
      bytes => this.#posted(ctx, bytes, media),
      (error: unknown) => transportError(error, media),
    )
  }

  /** `GET path`. */
  readonly get = (ctx: HttpContext): unknown => {
    const media = this.#get.choose(ctx.headers['accept'])
    if (media === Media.Html) return this.#graphiql
    if (media === Media.None) return NOT_ACCEPTABLE
    if (!this.#getQueries) return GET_NOT_ALLOWED
    const params = readGetParams(ctx.url) ?? ctx.query
    const request: Record<string, unknown> = {}
    for (const name of GET_PARAMS) {
      const value = params[name]
      if (value === undefined) continue
      if (typeof value !== 'string') return errorReply(media, 400, errorBody(`Repeated ${name} parameter`))
      if (name === 'variables' || name === 'extensions') {
        try {
          request[name] = JSON.parse(value)
        } catch {
          return errorReply(media, 400, errorBody(`The ${name} parameter must be JSON`))
        }
      } else {
        request[name] = value
      }
    }
    const invalid = invalidParams(request)
    if (invalid !== undefined) return errorReply(media, 400, errorBody(invalid))
    if (media === Media.EventStream) return this.#stream(ctx, request as unknown as GraphQLRequest, true)
    return this.#execute(ctx, request as unknown as GraphQLRequest, media, true)
  }

  /** A `POST` body read: parsed, checked, executed or streamed. */
  #posted(ctx: HttpContext, bytes: Uint8Array, media: MediaKind): unknown {
    if (bytes.byteLength === 0) {
      return errorReply(media, 400, errorBody('Missing request body: send { query, variables?, operationName? }'))
    }
    let body: unknown
    try {
      body = JSON.parse(UTF8.decode(bytes))
    } catch {
      return errorReply(media, 400, errorBody('Malformed JSON body'))
    }
    if (body === null || typeof body !== 'object') {
      return errorReply(media, 400, errorBody('The body must be a JSON object: { query, variables?, operationName? }'))
    }
    if (Array.isArray(body)) {
      return errorReply(media, 400, errorBody('Operation batching is not supported: send one operation per request'))
    }
    const invalid = invalidParams(body as Record<string, unknown>)
    if (invalid !== undefined) return errorReply(media, 400, errorBody(invalid))
    if (media === Media.EventStream) return this.#stream(ctx, body as GraphQLRequest, false)
    return this.#execute(ctx, body as GraphQLRequest, media, false)
  }

  /** Executes a query or a mutation; synchronous while the execution is. */
  #execute(ctx: HttpContext, request: GraphQLRequest, media: MediaKind, get: boolean): unknown {
    const executor = this.#executor ?? this.#bind()
    const abort = new DeferredAbort()
    const options: ExecuteOptions = { transport: 'http', http: ctx, abortSignal: abort.asSignal(), queriesOnly: get }
    const response = executor.execute(request, options)
    if (!isPromise(response)) return reply(response, media, get)
    // asynchronous resolvers: a client leaving now aborts the execution
    abort.follow(() => ctx.signal)
    return response.then(
      settled => reply(settled, media, get),
      (error: unknown) => {
        if (!abort.aborted || error !== abort.reason) throw error
        // nobody reads it: the client is gone (or the server stops)
        return errorReply(media, 503, errorBody('The request was aborted', GraphQLErrorCode.ServiceUnavailable))
      },
    )
  }

  /** GraphQL over SSE: any operation, its results as `next` events. */
  #stream(ctx: HttpContext, request: GraphQLRequest, get: boolean): Promise<unknown> {
    const executor = this.#executor ?? this.#bind()
    const signal = ctx.signal
    const options: ExecuteOptions = { transport: 'sse', http: ctx, signal, queriesOnly: get }
    return executor.subscribe(request, options).then(
      outcome => {
        if ('status' in outcome) {
          return errorReply(Media.Json, outcome.status, outcome.result, outcome.headers)
        }
        // the SSE options were checked at boot (see sseOptions)
        return HttpResponse.sse(new ResultEvents(outcome, signal), this.#sse as SseOptions)
      },
      (error: unknown) => {
        if (!signal.aborted || error !== signal.reason) throw error
        return errorReply(Media.Json, 503, errorBody('The request was aborted', GraphQLErrorCode.ServiceUnavailable))
      },
    )
  }

  #bind(): GraphQLExecutor {
    this.#executor = this.#resolveExecutor()
    return this.#executor
  }
}

/**
 * The HTTP reply of an executor response. `application/json` answers 200 to every well-formed
 * request (request errors included); `application/graphql-response+json` keeps the status.
 */
function reply(response: GraphQLResponse, media: MediaKind, get: boolean): unknown {
  const status = response.status
  const result = response.result
  if (media === Media.Json) {
    if (status === 200 || status === 400) {
      // a plain object on a GET route: 200 application/json (a POST route would answer 201)
      return get ? result : new HttpResponse(result, JSON_200)
    }
    return errorReply(media, status, result, response.headers)
  }
  if (response.headers === undefined) {
    if (status === 200) return new HttpResponse(result, GRAPHQL_JSON_200)
    if (status === 400) return new HttpResponse(result, GRAPHQL_JSON_400)
  }
  return errorReply(media, status, result, response.headers)
}

/** A failure reading the body (413 past the body limit, 400 for an aborted body) with a GraphQL error body. */
function transportError(error: unknown, media: MediaKind): HttpResponse<FormattedExecutionResult> {
  if (!isHttpException(error)) throw error
  return errorReply(media, error.status, errorBody(error.message))
}

/** Checks the SSE options once (`HttpResponse.sse()` validates them): `undefined` when they are valid. */
export function checkSseOptions(options: SseOptions): string | undefined {
  try {
    HttpResponse.sse([], options)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
