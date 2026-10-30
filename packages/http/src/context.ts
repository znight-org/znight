import type { Token } from '@znight/core'
import type { AdapterRequest } from './adapter.ts'
import type { CookieSettings } from './cookie-settings.ts'
import type { ClearCookieOptions, CookieOptions, ResponseCookie, SerializedCookie } from './cookies.ts'
import type { HeaderValue } from './exceptions.ts'
import type { MultipartResult } from './multipart.ts'
import type { BodyPlan } from './uploads.ts'

import { checkContentEncoding, hasBody, parseBodyBytes, parseMediaType } from './body.ts'
import { DEFAULT_COOKIE_SETTINGS, missingSecrets, serializeWith, verifySigned } from './cookie-settings.ts'
import { parseCookieHeader } from './cookies.ts'
import { UnsupportedMediaTypeException } from './exceptions.ts'
import { parseMultipart, readMultipart } from './multipart.ts'
import { parseQuery, type QueryRecord, type RequestTarget, splitUrl } from './query.ts'
import { emptyRecord } from './utils.ts'

declare const requestIdBrand: unique symbol

/** Why `ctx.signal` aborted: the client left, the server shuts down, or an SSE stream reached its `maxDuration`. */
export type RequestAbortKind = 'client' | 'shutdown' | 'expired'

/**
 * The reason of an aborted `ctx.signal`. Named `AbortError`, what `fetch`, `node:timers/promises`
 * and most libraries check.
 */
export class RequestAbortedError extends Error {
  override readonly name = 'AbortError'
  /** `client`: disconnected; `shutdown`: the server stops; `expired`: an SSE stream reached its `maxDuration`. */
  readonly kind: RequestAbortKind

  constructor(kind: RequestAbortKind) {
    super(ABORT_MESSAGES[kind])
    this.kind = kind
  }
}

const ABORT_MESSAGES: Readonly<Record<RequestAbortKind, string>> = {
  client: 'The client disconnected',
  shutdown: 'The server is shutting down',
  expired: 'The event stream reached its maxDuration',
}

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
  /**
   * Effective route metadata (`createRouteDecorator`): the controller's entries, except those of a
   * group the route decides itself, then the route's entries (the nearest decision wins).
   */
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
   * Parsed body. Populated before the interceptors for routes declaring `@Body()` or upload
   * parameters (and after {@link parseBody} resolved otherwise); `undefined` until then and for
   * empty bodies. Forms (urlencoded and multipart) are records of their text fields.
   */
  readonly body: unknown
  /**
   * Files of a `multipart/form-data` body by field name, in body order (standard `File` objects,
   * held in memory). Populated with {@link body}; empty for other bodies.
   */
  readonly files: Readonly<Record<string, readonly File[]>>
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
  /**
   * Client address, when the adapter knows it. With the plugin option `trustProxy`, the address
   * found in `x-forwarded-for` behind the trusted proxies; otherwise the adapter's address (the
   * socket peer, or what Fastify / Express derive from their own proxy settings).
   */
  readonly ip: string | undefined
  /**
   * `https` when the connection uses TLS, or, behind a trusted proxy (`trustProxy`), when the
   * leftmost `x-forwarded-proto` says so; `http` otherwise.
   */
  readonly protocol: 'http' | 'https'
  /** Headers added to the response, whatever its outcome (errors included). */
  readonly responseHeaders: Readonly<Record<string, HeaderValue>>
  /** A request header (case-insensitive name). */
  header(name: string): string | undefined
  /** Sets a response header (case-insensitive name), sent with success and error responses. */
  setHeader(name: string, value: HeaderValue): void
  /** Appends a response header value (`set-cookie`...). */
  appendHeader(name: string, value: string): void
  /**
   * Request cookies (`cookie` header), parsed on first access: decoded values, the first occurrence
   * of a name wins. A prototype-less, frozen record.
   */
  readonly cookies: Readonly<Record<string, string>>
  /**
   * The verified value of a signed cookie (`@SignedCookie`), `undefined` when it is absent, tampered
   * or signed with a key that is no longer in `cookies.secrets`. Verified once per name.
   *
   * @throws Error when the plugin option `cookies.secrets` is not set.
   */
  signedCookie(name: string): string | undefined
  /**
   * Sets a cookie on the response, whatever its outcome (errors, redirects included), with the
   * secure defaults (`Path=/; Secure; HttpOnly; SameSite=Lax`, see the plugin option
   * `cookies.defaults`). A later cookie with the same name, domain and path replaces this one; a
   * cookie of the same key in an `HttpResponse` (`withCookie`) wins over it. Everything is validated
   * now (name, value, attributes, prefixes, size), so the stack trace points to the faulty call.
   *
   * @throws TypeError / RangeError for an invalid cookie; Error once the response headers were sent
   *   (a running event stream).
   */
  setCookie(name: string, value: string, options?: CookieOptions): void
  /**
   * Clears a cookie (`Max-Age=0`, with the same domain and path, and the defaults: a `__Host-`
   * cookie is cleared with valid attributes).
   *
   * @throws like {@link setCookie}.
   */
  clearCookie(name: string, options?: ClearCookieOptions): void
  /** Cookies set on this response so far (`setCookie` / `clearCookie`), in order. */
  readonly responseCookies: readonly ResponseCookie[]
  /**
   * Aborted when the client disconnects before the response was written, when the response body is
   * cancelled, or when the server closes an event stream (shutdown, `maxDuration`); never after a
   * normal completion. The reason is a {@link RequestAbortedError}. Pass it to the work the request
   * starts (`fetch(url, { signal: ctx.signal })`, `setTimeout(ms, v, { signal })`). Created on first
   * access.
   */
  readonly signal: AbortSignal
  /**
   * Reads and parses the body (once): JSON (`application/json`, `+json`), text (`text/*`), forms
   * (`application/x-www-form-urlencoded` and `multipart/form-data` → record of the text fields,
   * repeated names as arrays; files in {@link files}), raw bytes otherwise; `undefined` when empty.
   * Fails with 400 (malformed), 413 (body or upload limits) or 415 (unsupported encoding, refused
   * file type, non-multipart body on an upload route).
   */
  parseBody(): Promise<unknown>
  /** The raw body bytes (once; shared with {@link parseBody}), e.g. to check a webhook signature. */
  rawBody(): Promise<Uint8Array>
  /**
   * The request body as a Web stream, read as it arrives (nothing is buffered): the escape hatch
   * for large uploads (`PUT /files/:name` piped to disk or object storage). The body limit of the
   * route still applies (`@BodyLimit`, `Infinity` to disable): past it the stream errors with a
   * `PayloadTooLargeException` (413). Exclusive with {@link rawBody} / {@link parseBody}: throws when
   * the body was already read (routes with `@Body()` or upload parameters read it before the
   * handler).
   */
  bodyStream(): ReadableStream<Uint8Array>
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
  readonly protocol: 'http' | 'https'
  readonly #source: AdapterRequest
  readonly #plan: BodyPlan
  readonly #rawQuery: string
  #query: QueryRecord | undefined
  #state: Map<string | symbol, unknown> | undefined
  #responseHeaders: Record<string, HeaderValue> | undefined
  #body: unknown
  #files: Readonly<Record<string, readonly File[]>> | undefined
  #raw: Promise<Uint8Array> | undefined
  #streamed = false
  /** Stops the body stream opened for the request, unless it was read to its end or cancelled. */
  #stopBody: (() => void) | undefined
  #parsed: Promise<unknown> | undefined
  readonly #cookieSettings: CookieSettings
  #cookies: Readonly<Record<string, string>> | undefined
  #signed: Map<string, string | undefined> | undefined
  /** Cookies set on the response, by key (name, domain, path), with their `Set-Cookie` line. */
  #jar: Map<string, { readonly cookie: ResponseCookie; readonly line: string }> | undefined
  /** The response headers were handed to the adapter (cookies can no longer be set). */
  #committed = false
  /** The request is over: later aborts are ignored. */
  #completed = false
  #abortReason: RequestAbortedError | undefined
  #abortController: AbortController | undefined

  constructor(
    source: AdapterRequest,
    init: {
      readonly requestId: RequestId
      readonly adapter: string
      /** `source.url` split (default: split here). */
      readonly url?: RequestTarget
      readonly route: HttpRouteInfo | undefined
      readonly params: Readonly<Record<string, string>>
      readonly body: BodyPlan
      /** Client address and protocol (`trustProxy`); default: the adapter's `ip` and `encrypted`. */
      readonly client?: { readonly ip: string | undefined; readonly protocol: 'http' | 'https' } | undefined
      /** Cookie defaults and signing key (plugin option `cookies`); default: secure defaults, no signing. */
      readonly cookies?: CookieSettings
    },
  ) {
    this.#source = source
    this.#plan = init.body
    this.#cookieSettings = init.cookies ?? DEFAULT_COOKIE_SETTINGS
    const { path, query } = init.url ?? splitUrl(source.url)
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
    const connection = source.encrypted === true ? 'https' : 'http'
    this.ip = init.client === undefined ? source.ip : init.client.ip
    this.protocol = init.client === undefined ? connection : init.client.protocol
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

  get files(): Readonly<Record<string, readonly File[]>> {
    return this.#files ?? NO_FILES
  }

  /** Maximum body size of the route, in bytes. */
  get bodyLimit(): number {
    return this.#plan.limit
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

  get cookies(): Readonly<Record<string, string>> {
    this.#cookies ??= parseCookieHeader(this.headers['cookie'])
    return this.#cookies
  }

  signedCookie(name: string): string | undefined {
    const signer = this.#cookieSettings.signer
    if (signer === undefined) throw missingSecrets(`Cannot read the signed cookie ${JSON.stringify(String(name))}`)
    this.#signed ??= new Map()
    if (this.#signed.has(name)) return this.#signed.get(name)
    const value = verifySigned(signer, name, this.cookies[name])
    this.#signed.set(name, value)
    return value
  }

  setCookie(name: string, value: string, options: CookieOptions = {}): void {
    this.#addCookie({ name, value, options })
  }

  clearCookie(name: string, options: ClearCookieOptions = {}): void {
    this.#addCookie({ name, value: undefined, options })
  }

  get responseCookies(): readonly ResponseCookie[] {
    return this.#jar === undefined ? NO_COOKIES : [...this.#jar.values()].map(entry => entry.cookie)
  }

  /** The `Set-Cookie` lines of {@link setCookie} / {@link clearCookie}, with their keys, in order (internal). */
  get cookieLines(): readonly SerializedCookie[] {
    return this.#jar === undefined ? NO_LINES : [...this.#jar].map(([key, entry]) => ({ key, line: entry.line }))
  }

  #addCookie(cookie: ResponseCookie): void {
    if (this.#committed) {
      throw new Error(
        `Cannot set cookie ${JSON.stringify(String(cookie.name))}: the response headers were already sent`,
      )
    }
    if (cookie.options === null || typeof cookie.options !== 'object') {
      throw new TypeError(`Invalid cookie ${JSON.stringify(String(cookie.name))}: options must be an object`)
    }
    const options = cookie.value === undefined ? withoutLifetime(cookie.options) : cookie.options
    const frozen: ResponseCookie = Object.freeze({
      name: cookie.name,
      value: cookie.value,
      options: Object.freeze({ ...options }),
    })
    const { key, line } = serializeWith(frozen, this.#cookieSettings)
    this.#jar ??= new Map()
    this.#jar.set(key, { cookie: frozen, line })
  }

  get signal(): AbortSignal {
    if (this.#abortController === undefined) {
      const controller = new AbortController()
      this.#abortController = controller
      if (this.#abortReason !== undefined) controller.abort(this.#abortReason)
      else if (!this.#completed) this.#source.onAbort?.(() => this.abort('client'))
    }
    return this.#abortController.signal
  }

  /** Whether {@link signal} aborted (or will be created aborted). */
  get aborted(): boolean {
    return this.#abortReason !== undefined
  }

  /**
   * Aborts {@link signal} with a {@link RequestAbortedError} of `kind` (internal): at most once, and
   * never once the request is over ({@link complete}).
   */
  abort(kind: RequestAbortKind): void {
    if (this.#abortReason !== undefined || this.#completed) return
    const reason = new RequestAbortedError(kind)
    this.#abortReason = reason
    this.#abortController?.abort(reason)
  }

  /** The response headers are handed to the adapter: cookies can no longer be set (internal). */
  commit(): void {
    this.#committed = true
  }

  /** The request is over (response sent or abandoned): later aborts are ignored (internal). */
  complete(): void {
    this.#completed = true
  }

  rawBody(): Promise<Uint8Array> {
    if (this.#raw === undefined) {
      if (this.#streamed) return Promise.reject(alreadyStreamed())
      this.#raw = this.#source.readBody(this.#plan.limit)
    }
    return this.#raw
  }

  bodyStream(): ReadableStream<Uint8Array> {
    if (this.#raw !== undefined || this.#streamed) throw alreadyStreamed()
    this.#streamed = true
    return this.#openBodyStream()
  }

  /**
   * Called by the pipeline once the request is over: a body stream that was neither read to its
   * end nor cancelled (a handler that read the first chunk, then threw) is cancelled, which makes the
   * adapter discard the rest of the body, so that the connection can serve the next request.
   */
  releaseBody(): void {
    const stop = this.#stopBody
    this.#stopBody = undefined
    stop?.()
  }

  /** The body as a stream (see {@link releaseBody}). */
  #openBodyStream(): ReadableStream<Uint8Array> {
    const reader = openBodyStream(this.#source, this.#plan.limit).getReader()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const settle = (): void => {
      this.#stopBody = undefined
    }
    this.#stopBody = (): void => {
      reader.cancel().catch(() => undefined)
      try {
        controller?.error(new Error('The request is over: its body can no longer be read'))
      } catch {
        // already closed or errored
      }
    }
    return new ReadableStream<Uint8Array>(
      {
        start(current) {
          controller = current
        },
        async pull(current) {
          let result: Awaited<ReturnType<typeof reader.read>>
          try {
            result = await reader.read()
          } catch (error) {
            settle()
            throw error
          }
          if (result.done) {
            settle()
            current.close()
            return
          }
          current.enqueue(result.value)
        },
        cancel(reason) {
          settle()
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    )
  }

  parseBody(): Promise<unknown> {
    this.#parsed ??= this.#parse()
    return this.#parsed
  }

  async #parse(): Promise<unknown> {
    const headers = this.headers
    const contentType = headers['content-type']
    const media = parseMediaType(contentType)
    if (media?.type === 'multipart/form-data') {
      checkContentEncoding(headers['content-encoding'])
      const policy = this.#plan.multipart
      let result: MultipartResult
      if (this.#raw === undefined) {
        if (this.#streamed) throw alreadyStreamed()
        this.#streamed = true
        result = await readMultipart(this.#openBodyStream(), contentType as string, policy)
      } else {
        result = parseMultipart(await this.#raw, contentType as string, policy)
      }
      this.#files = result.files
      this.#body = result.fields
      return result.fields
    }
    if (this.#plan.upload) {
      // upload routes only accept multipart bodies (an empty body means "no file"); the framing
      // headers decide, the adapter only for requests without them (Web `Request`s built in memory)
      const framed = headers['content-length'] !== undefined || headers['transfer-encoding'] !== undefined
      if (!(framed ? hasBody(headers) : this.#source.hasBody?.() === true)) return undefined
      throw new UnsupportedMediaTypeException(
        `Expected a multipart/form-data body${media === undefined ? '' : ` (received ${JSON.stringify(media.type)})`}`,
      )
    }
    const bytes = await this.rawBody()
    const body = parseBodyBytes(bytes, contentType, headers['content-encoding'])
    this.#body = body
    return body
  }
}

/** The body as a stream: the adapter's `streamBody`, or the buffered body when it has none. */
function openBodyStream(source: AdapterRequest, limit: number): ReadableStream<Uint8Array> {
  if (typeof source.streamBody === 'function') return source.streamBody(limit)
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const bytes = await source.readBody(limit)
        if (bytes.byteLength > 0) controller.enqueue(bytes)
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
}

function alreadyStreamed(): Error {
  return new Error(
    'The request body was already read: bodyStream() cannot be combined with rawBody(), parseBody(), @Body() or upload parameters',
  )
}

/** Clearing cookies have no lifetime of their own (`Max-Age=0`) and are never signed. */
function withoutLifetime(options: ClearCookieOptions): ClearCookieOptions {
  const { maxAge: _maxAge, expires: _expires, signed: _signed, ...rest } = options as CookieOptions
  return rest
}

const EMPTY_HEADERS: Readonly<Record<string, HeaderValue>> = Object.freeze({})
const NO_COOKIES: readonly ResponseCookie[] = Object.freeze([])
const NO_LINES: readonly SerializedCookie[] = Object.freeze([])
const NO_FILES: Readonly<Record<string, readonly File[]>> = Object.freeze(emptyRecord<readonly File[]>())
