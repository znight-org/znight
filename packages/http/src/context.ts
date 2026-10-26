import type { Token } from '@znight/core'
import type { AdapterRequest } from './adapter.ts'
import type { HeaderValue } from './exceptions.ts'

import { parseBody } from './body.ts'
import { parseQuery, type QueryRecord, splitUrl } from './query.ts'
import { emptyRecord } from './utils.ts'

declare const requestIdBrand: unique symbol

/**
 * Identifier of the current request: the incoming `x-request-id` header (see the plugin option
 * `requestIdHeader`) or a generated UUID. Injectable in request-scoped providers.
 */
export type RequestId = string & { readonly [requestIdBrand]: true }

/** The route that matched a request. */
export interface HttpRouteInfo {
  /** Route method (`GET`...; the concrete method for `@All` routes). */
  readonly method: string
  /** Route pattern including the plugin prefix (`/api/users/:id`). */
  readonly path: string
  /** Controller provider token. */
  readonly controller: Token
  /** Handler method name. */
  readonly handler: string
  /** Controller metadata merged with route metadata (`createRouteDecorator`). */
  readonly meta: Readonly<Record<string, unknown>>
}

/**
 * Adapter-neutral view of the current HTTP request, shared by guards, interceptors, exception
 * mappers and handlers (`@Ctx()`), and injectable in request-scoped providers.
 */
export interface HttpContext {
  readonly requestId: RequestId
  /** Upper-case method. */
  readonly method: string
  /** Raw request target (`/users/a%20b?page=2`). */
  readonly url: string
  /** Raw path, without query string (`/users/a%20b`). */
  readonly path: string
  /** Decoded route parameters (`*` holds the part matched by a trailing wildcard). */
  readonly params: Readonly<Record<string, string>>
  /** Decoded query string (repeated keys → arrays), parsed on first access. */
  readonly query: Readonly<QueryRecord>
  /** Request headers, lower-case names. */
  readonly headers: Readonly<Record<string, string | undefined>>
  /**
   * Parsed body. Populated before the interceptors for routes declaring `@Body()` (and after
   * {@link parseBody} resolved otherwise); `undefined` until then and for empty bodies.
   */
  readonly body: unknown
  /** The matched route, `undefined` for unmatched requests (404/405). */
  readonly route: HttpRouteInfo | undefined
  /** Per-request storage for guards, interceptors and handlers (`ctx.state.set('user', user)`). */
  readonly state: Map<string | symbol, unknown>
  /** Native request of the adapter (`IncomingMessage`, `FastifyRequest`, Express `Request`, Web `Request`). */
  readonly request: unknown
  /** Native response of the adapter (`ServerResponse`, `FastifyReply`, Express `Response`, Hono `Context`). */
  readonly response: unknown
  /** Adapter name (`node`, `fastify`, `express`, `hono`). */
  readonly adapter: string
  /** Remote address, when the adapter knows it. */
  readonly ip: string | undefined
  /** Headers added to the response, whatever its outcome (errors included). */
  readonly responseHeaders: Readonly<Record<string, HeaderValue>>
  /** A request header (case-insensitive name). */
  header(name: string): string | undefined
  /** Sets a response header (case-insensitive name), sent with success and error responses. */
  setHeader(name: string, value: HeaderValue): void
  /** Appends a response header value (`set-cookie`...). */
  appendHeader(name: string, value: string): void
  /**
   * Reads and parses the body (once): JSON (`application/json`, `+json`), text (`text/*`), forms
   * (`application/x-www-form-urlencoded` → record, `multipart/form-data` → `FormData`), raw bytes
   * otherwise; `undefined` when empty. Fails with 400 (malformed), 413 (`bodyLimit`) or 415
   * (unsupported encoding).
   */
  parseBody(): Promise<unknown>
  /** The raw body bytes (once; shared with {@link parseBody}), e.g. to check a webhook signature. */
  rawBody(): Promise<Uint8Array>
}

/** Implementation of {@link HttpContext} used by the pipeline (internal). */
export class RequestContext implements HttpContext {
  readonly requestId: RequestId
  readonly method: string
  readonly url: string
  readonly path: string
  readonly params: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly route: HttpRouteInfo | undefined
  readonly request: unknown
  readonly response: unknown
  readonly adapter: string
  readonly ip: string | undefined
  readonly #source: AdapterRequest
  readonly #bodyLimit: number
  readonly #rawQuery: string
  #query: QueryRecord | undefined
  #state: Map<string | symbol, unknown> | undefined
  #responseHeaders: Record<string, HeaderValue> | undefined
  #body: unknown
  #raw: Promise<Uint8Array> | undefined
  #parsed: Promise<unknown> | undefined

  constructor(
    source: AdapterRequest,
    init: {
      readonly requestId: RequestId
      readonly adapter: string
      readonly route: HttpRouteInfo | undefined
      readonly params: Readonly<Record<string, string>>
      readonly bodyLimit: number
    },
  ) {
    this.#source = source
    this.#bodyLimit = init.bodyLimit
    const { path, query } = splitUrl(source.url)
    this.#rawQuery = query
    this.requestId = init.requestId
    this.method = source.method
    this.url = source.url
    this.path = path
    this.params = init.params
    this.headers = source.headers
    this.route = init.route
    this.request = source.raw
    this.response = source.rawResponse
    this.adapter = init.adapter
    this.ip = source.ip
  }

  get query(): Readonly<QueryRecord> {
    this.#query ??= parseQuery(this.#rawQuery)
    return this.#query
  }

  get state(): Map<string | symbol, unknown> {
    this.#state ??= new Map()
    return this.#state
  }

  get body(): unknown {
    return this.#body
  }

  get responseHeaders(): Readonly<Record<string, HeaderValue>> {
    return this.#responseHeaders ?? EMPTY_HEADERS
  }

  /** Whether {@link setHeader}/{@link appendHeader} were called. */
  get hasResponseHeaders(): boolean {
    return this.#responseHeaders !== undefined
  }

  header(name: string): string | undefined {
    return this.headers[name.toLowerCase()]
  }

  setHeader(name: string, value: HeaderValue): void {
    this.#responseHeaders ??= emptyRecord()
    this.#responseHeaders[name.toLowerCase()] = typeof value === 'string' ? value : [...value]
  }

  appendHeader(name: string, value: string): void {
    this.#responseHeaders ??= emptyRecord()
    const key = name.toLowerCase()
    const existing = this.#responseHeaders[key]
    if (existing === undefined) this.#responseHeaders[key] = value
    else this.#responseHeaders[key] = typeof existing === 'string' ? [existing, value] : [...existing, value]
  }

  rawBody(): Promise<Uint8Array> {
    this.#raw ??= this.#source.readBody(this.#bodyLimit)
    return this.#raw
  }

  parseBody(): Promise<unknown> {
    this.#parsed ??= this.rawBody().then(async bytes => {
      const body = await parseBody(bytes, this.headers['content-type'], this.headers['content-encoding'])
      this.#body = body
      return body
    })
    return this.#parsed
  }
}

const EMPTY_HEADERS: Readonly<Record<string, HeaderValue>> = Object.freeze({})
