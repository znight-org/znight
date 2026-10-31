import type { Container, CoreLogger, Hooks, HttpRequestEvent, OpenedScope, Token } from '@znight/core'
import type { AdapterHandler, AdapterReply, AdapterRequest, ReplyBody } from './adapter.ts'
import type { CookieSettings } from './cookie-settings.ts'
import type { SerializedCookie } from './cookies.ts'
import type { CorsPolicy } from './cors.ts'
import type { CanActivate, ExceptionMapper, HttpInterceptor } from './interfaces.ts'
import type { HttpRouteDefinition, HttpSseDefinition } from './metadata.ts'
import type { TrustPolicy } from './proxy.ts'
import type { RouteTable } from './router.ts'
import type { BodyPlan } from './uploads.ts'

import { Buffer } from 'node:buffer'
import { displayName } from '@znight/core'

import { isEventStreamType } from './adapters/shared.ts'
import { type HttpRouteInfo, RequestContext, type RequestId } from './context.ts'
import { DEFAULT_COOKIE_SETTINGS, serializeWith } from './cookie-settings.ts'
import { corsReplyHeaders, isPreflight, mergeVary, preflightHeaders } from './cors.ts'
import {
  BadRequestException,
  ForbiddenException,
  type HeaderValue,
  HttpException,
  isHttpException,
  MethodNotAllowedException,
  NotFoundException,
} from './exceptions.ts'
import { isFileBody, resolveFile } from './files.ts'
import { findInvalidHeader, isHeaderValue } from './headers.ts'
import { decodePathValue, matchRoutePath, type RoutePath, type RouteSegment, WILDCARD_PARAM } from './path.ts'
import { type RequestTarget, splitUrl } from './query.ts'
import { HttpResponse, isHttpResponse } from './response.ts'
import {
  addMissingHeaders,
  assignHeaders,
  ContentType,
  type SerializedReply,
  type SerializeOptions,
  serializeError,
  serializeFileReply,
  serializeResult,
  serializeSseReply,
} from './serialize.ts'
import { isSseBody, isSseSource, type SseOptions, SseSession, type SseSource } from './sse.ts'
import { isBodylessStatus } from './status.ts'
import { type ContextRunner, captureContext, discardStream, trackStream } from './stream.ts'
import { HttpTokens } from './tokens.ts'
import { emptyRecord, errorMessage, isBun, isThenable } from './utils.ts'

/** A dependency of the pipeline: an instance resolved at bootstrap, or a token resolved per request. */
export type Resolvable<T> = { readonly instance: T } | { readonly token: Token }

/** Everything the pipeline needs to serve one registered route (internal). */
export interface RoutePlan {
  readonly definition: HttpRouteDefinition
  /** The registered path (a trailing-slash variant has an extra empty static segment). */
  readonly path: RoutePath
  readonly info: HttpRouteInfo
  readonly controller: Resolvable<object>
  readonly guards: readonly Resolvable<CanActivate>[]
  readonly interceptors: readonly Resolvable<HttpInterceptor>[]
  /** Parse the body before the interceptors (`@Body()` or upload parameters). */
  readonly parseBody: boolean
  /** Body limit and multipart rules of the route. */
  readonly body: BodyPlan
  /** Trailing-slash variant answered with a redirect to the path without its trailing slash. */
  readonly redirect?: boolean
}

/** Pipeline settings (resolved plugin options). */
export interface PipelineOptions {
  readonly adapter: string
  /** Body plan of unmatched requests (plugin `bodyLimit`, generic multipart rules). */
  readonly body: BodyPlan
  readonly exposeErrors: boolean
  readonly requestIdHeader: string | undefined
  readonly generateRequestId: () => string
  readonly mappers: readonly Resolvable<ExceptionMapper>[]
  /** CORS policy (`cors` option), `undefined` when disabled. */
  readonly cors?: CorsPolicy | undefined
  /** Security headers added to every reply that does not set them (`securityHeaders` option). */
  readonly securityHeaders?: Readonly<Record<string, string>>
  /** `trustProxy` policy, `undefined` when proxies are not trusted. */
  readonly trustProxy?: TrustPolicy | undefined
  /** Cookie defaults and signing key (`cookies` option). Default: secure defaults, no signing. */
  readonly cookies?: CookieSettings
  /** Event stream defaults (`sse` option). */
  readonly sse?: SseSettings
}

/** Resolved plugin option `sse`. */
export interface SseSettings {
  /** Heartbeat interval in ms; `0`: none. */
  readonly heartbeat: number
  /** `retry` sent first, if any. */
  readonly retry: number | undefined
  /** Time a source gets to finish after a graceful close started (ms). */
  readonly shutdownGraceMs: number
}

/** Default event stream settings. */
export const DEFAULT_SSE_SETTINGS: SseSettings = Object.freeze({
  heartbeat: 8_000,
  retry: undefined,
  shutdownGraceMs: 1_000,
})

type Target =
  | { readonly kind: 'route'; readonly plan: RoutePlan }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'options'; readonly allow: string }
  | { readonly kind: 'redirect'; readonly location: string }
  /** A CORS preflight; `allow` is `undefined` when no route has the path (404). */
  | { readonly kind: 'preflight'; readonly allow: string | undefined }

/** The CORS decision of a request (an `origin` header and a CORS policy). */
interface CorsDecision {
  readonly policy: CorsPolicy
  readonly origin: string
  readonly allowed: boolean
}

const RAW = Symbol('raw response')
type Outcome = SerializedReply | typeof RAW

/** A reply whose `HttpResponse` cookies were serialised (see `#checkCookies`). */
type CheckedReply = SerializedReply & { readonly cookieLines?: readonly SerializedCookie[] }

const REQUEST_ID = /^[\w\-.:@/+=]{1,128}$/

const MAX_PATH_IN_MESSAGE = 200

/** The default request id generator: a random UUID (version 4, like `crypto.randomUUID()`). */
export function randomRequestId(): string {
  return uuid()
}

/** Random bytes of the next UUIDs (Node.js), refilled every {@link UUID_BATCH} ids. */
const UUID_BATCH = 128
const uuidPool = new Uint8Array(16 * UUID_BATCH)
let uuidOffset = uuidPool.length
/** The text of the last UUID, its dashes in place. */
const uuidText = Buffer.alloc(36, 0x2d)
/** The two lower-case hexadecimal digits of each byte, as character codes. */
const HEX_CODES = new Uint8Array(512)
for (let byte = 0; byte < 256; byte++) {
  const digits = byte.toString(16).padStart(2, '0')
  HEX_CODES[byte * 2] = digits.charCodeAt(0)
  HEX_CODES[byte * 2 + 1] = digits.charCodeAt(1)
}

function putHex(position: number, byte: number): void {
  uuidText[position] = HEX_CODES[byte * 2] as number
  uuidText[position + 1] = HEX_CODES[byte * 2 + 1] as number
}

/**
 * A random version 4 UUID written from a pool of random bytes (`crypto.getRandomValues`), as Node.js
 * does, but read as one flat string: `crypto.randomUUID()` returns a concatenation of 20 pieces that
 * is flattened again when the header is written, which makes it about twice as slow.
 */
function pooledUuid(): string {
  if (uuidOffset === uuidPool.length) {
    crypto.getRandomValues(uuidPool)
    uuidOffset = 0
  }
  const pool = uuidPool
  const at = uuidOffset
  uuidOffset = at + 16
  putHex(0, pool[at] as number)
  putHex(2, pool[at + 1] as number)
  putHex(4, pool[at + 2] as number)
  putHex(6, pool[at + 3] as number)
  putHex(9, pool[at + 4] as number)
  putHex(11, pool[at + 5] as number)
  putHex(14, ((pool[at + 6] as number) & 0x0f) | 0x40)
  putHex(16, pool[at + 7] as number)
  putHex(19, ((pool[at + 8] as number) & 0x3f) | 0x80)
  putHex(21, pool[at + 9] as number)
  putHex(24, pool[at + 10] as number)
  putHex(26, pool[at + 11] as number)
  putHex(28, pool[at + 12] as number)
  putHex(30, pool[at + 13] as number)
  putHex(32, pool[at + 14] as number)
  putHex(34, pool[at + 15] as number)
  return readUuidText()
}

/**
 * The text of {@link uuidText}: Node.js `Buffer#latin1Slice` (what `toString('latin1')` calls after
 * checking its arguments) when present.
 */
const readUuidText: () => string =
  typeof (uuidText as { latin1Slice?: unknown }).latin1Slice === 'function'
    ? () => (uuidText as unknown as { latin1Slice(start: number, end: number): string }).latin1Slice(0, 36)
    : () => uuidText.toString('latin1', 0, 36)

/** UUID generator: Bun's native `crypto.randomUUID()` is the fastest there. */
const uuid: () => string = isBun() ? () => crypto.randomUUID() : pooledUuid

/**
 * The request pipeline (architecture §9.1):
 * `runInScope({ HttpContext, RequestId }) → hooks.run('http:request') → guards → body → interceptors
 * → invoke → serialise`, errors being mapped to responses inside `hooks.run`.
 */
export class Pipeline {
  readonly #container: Container
  readonly #hooks: Hooks
  readonly #logger: CoreLogger
  readonly #options: PipelineOptions
  readonly #table: RouteTable<RoutePlan>
  /** The `securityHeaders` option as entries (lower-case names, values validated at boot). */
  readonly #securityHeaders: readonly (readonly [string, string])[]
  /** Every request id can be sent: an incoming one matched `REQUEST_ID`, the generated ones are UUIDs. */
  readonly #validIds: boolean
  /**
   * The headers of a JSON reply of the fast lane, in their final order (content type and length,
   * then the framework headers, see {@link #frameworkHeaders}): copied, then completed with the
   * length and the request id.
   */
  readonly #jsonHeaders: Readonly<Record<string, HeaderValue>>
  /** The request id header of {@link #jsonHeaders}, `undefined` when the reply has none. */
  readonly #jsonIdHeader: string | undefined
  /** The headers of a reply without body of the fast lane (the framework headers, see {@link #jsonHeaders}). */
  readonly #emptyHeaders: Readonly<Record<string, HeaderValue>>
  /** The request id header of {@link #emptyHeaders}, `undefined` when the reply has none. */
  readonly #emptyIdHeader: string | undefined
  /** Whether {@link #jsonHeaders} and {@link #emptyHeaders} hold every framework header (see {@link #fastRoute}). */
  readonly #fastHeaders: boolean
  /** The `cookies` option (secure defaults, no signing, when not set). */
  readonly #cookies: CookieSettings
  #inflight = 0
  #idle: (() => void)[] = []
  /** Open event streams. */
  readonly #streams = new Set<SseSession>()
  /** Set while the server drains: responses ask clients to close their connection. */
  draining = false

  constructor(
    container: Container,
    hooks: Hooks,
    logger: CoreLogger,
    options: PipelineOptions,
    table: RouteTable<RoutePlan>,
  ) {
    this.#container = container
    this.#hooks = hooks
    this.#logger = logger
    this.#options = options
    this.#table = table
    this.#validIds = options.generateRequestId === randomRequestId
    this.#cookies = options.cookies ?? DEFAULT_COOKIE_SETTINGS
    this.#securityHeaders = Object.entries(options.securityHeaders ?? {}).map(
      ([name, value]) => [name.toLowerCase(), value] as const,
    )
    // what #complete adds to the headers of serializeResult for a JSON value or no value (no CORS,
    // not draining), with a placeholder where the request id goes
    const placeholder = '-' as RequestId
    const idHeader = options.requestIdHeader
    // plain objects: a spread copies them several times faster than a record without prototype
    const json: Record<string, HeaderValue> = { 'content-type': ContentType.json, 'content-length': '0' }
    this.#frameworkHeaders(json, placeholder, undefined, false)
    this.#jsonHeaders = json
    this.#jsonIdHeader = idHeader !== undefined && json[idHeader] === placeholder ? idHeader : undefined
    const empty: Record<string, HeaderValue> = {}
    this.#frameworkHeaders(empty, placeholder, undefined, false)
    this.#emptyHeaders = empty
    this.#emptyIdHeader = idHeader !== undefined && empty[idHeader] === placeholder ? idHeader : undefined
    // a `__proto__` header is not a property of a plain object: such options take the general pipeline
    this.#fastHeaders = idHeader !== '__proto__' && this.#securityHeaders.every(([name]) => name !== '__proto__')
  }

  /** Number of requests being processed. */
  get inflight(): number {
    return this.#inflight
  }

  /** Number of open event streams. */
  get streams(): number {
    return this.#streams.size
  }

  /**
   * Starts the graceful close of every open event stream (`ctx.signal` aborts with `kind`, the source
   * gets `shutdownGraceMs` to finish, then the client receives a jittered `retry`).
   */
  closeStreams(kind: 'shutdown' | 'expired'): void {
    for (const session of [...this.#streams]) session.close(kind)
  }

  /** Resolves once no request is being processed. */
  whenIdle(): Promise<void> {
    if (this.#inflight === 0) return Promise.resolve()
    return new Promise(resolve => this.#idle.push(resolve))
  }

  /**
   * The adapter handler of a route: {@link handle}, or a fast lane for the routes that need no
   * guard, interceptor, event stream, raw response nor `@Header` when CORS is off (see
   * {@link #fast}).
   */
  handler(plan: RoutePlan): AdapterHandler {
    const route = this.#fastRoute(plan)
    if (route === undefined) return request => this.handle(plan, request)
    return request => this.#fast(route, request)
  }

  /** The fast lane of a route, `undefined` when the route needs the general pipeline. */
  #fastRoute(plan: RoutePlan): FastRoute | undefined {
    const definition = plan.definition
    if (
      !this.#fastHeaders ||
      this.#options.cors !== undefined ||
      plan.redirect === true ||
      plan.guards.length > 0 ||
      plan.interceptors.length > 0 ||
      definition.sse !== undefined ||
      definition.rawResponse === true ||
      definition.headers !== undefined ||
      definition.method === 'ALL'
    ) {
      return undefined
    }
    // the statuses of serializeResult: `@HttpCode` > 201 for POST routes > 200 (JSON) or 204 (none)
    const post = definition.method === 'POST'
    const json = definition.status ?? (post ? 201 : 200)
    return {
      plan,
      target: { kind: 'route', plan },
      method: definition.method,
      jsonStatus: isBodylessStatus(json) ? undefined : json,
      emptyStatus: definition.status ?? (post ? 201 : 204),
    }
  }

  /**
   * The fast lane: what {@link handle} does for a route of {@link #fastRoute}, decided once instead
   * of per request, without promises while the route stays synchronous. A request takes it when no
   * `http:request` wrapper nor listener is registered, the server is not draining and its method
   * is the route's (not a `HEAD` served by a `GET` route); a plain object or array returned by the
   * handler is serialised as JSON, and `undefined` answered without body, with the headers in their
   * final order (a template precomputed at boot).
   * Anything else — a malformed path (before the request starts), a thrown error, a thenable, an
   * `HttpResponse`, a `Response` or any other result, headers or cookies set through the context —
   * continues in the general pipeline, in the same request scope, with the same outcome.
   */
  #fast(route: FastRoute, request: AdapterRequest): Promise<AdapterReply> {
    const plan = route.plan
    const hooks = this.#hooks
    if (
      this.draining ||
      request.method !== route.method ||
      hooks.hasWrappers('http:request') ||
      hooks.hasListeners('http:request')
    ) {
      return this.handle(plan, request)
    }
    const url = request.url
    const mark = url.indexOf('?')
    const path = mark === -1 ? url : url.slice(0, mark)
    const params = routeParams(plan.path, path)
    // an unusual path (see #route): nothing started yet, the general pipeline handles it
    if (params === undefined) return this.handle(plan, request)
    this.#enter()
    let ctx: RequestContext
    try {
      const query = mark === -1 ? '' : url.slice(mark + 1)
      ctx = this.#context(request, this.#requestId(request), path, query, plan.info, params, plan.body)
    } catch (error) {
      this.#leave()
      return Promise.reject(error)
    }
    const scope = this.#container.openScope([
      [HttpTokens.Context, ctx],
      [HttpTokens.RequestId, ctx.requestId],
    ])
    const done = scope.run(this.#fastRun, route, request, ctx)
    if (done instanceof Exchange) {
      ;(done.done as Promise<void>).then(
        () => this.#end(done, scope, undefined),
        (error: unknown) => this.#end(done, scope, error),
      )
      if (!hooks.hasListeners('http:request')) return done.replied
      done.tracked = true
      return this.#emitted(done)
    }
    const closing = scope.close()
    if (closing === undefined) {
      ctx.complete()
      this.#leave()
    } else {
      const x = new Exchange(request, ctx, ctx.requestId, route.target)
      x.answer(done)
      closing.then(
        () => this.#over(x),
        (error: unknown) => this.#disposalFailed(x, error),
      )
    }
    // a listener registered while the handler ran (listeners are checked once the scope callback paused)
    if (!hooks.hasListeners('http:request')) return Promise.resolve(done)
    const event = requestEvent(request, ctx, performance.now())
    event.status = done.status
    return Promise.resolve(done).then(reply => {
      hooks.emit('http:request', event)
      return reply
    })
  }

  /**
   * The fast lane in the request scope: the reply when the handler answered synchronously with a
   * plain JSON value or `undefined`, otherwise the exchange finishing the request (see {@link #fast}).
   */
  readonly #fastRun = (route: FastRoute, request: AdapterRequest, ctx: RequestContext): AdapterReply | Exchange => {
    const plan = route.plan
    if (plan.parseBody) return this.#fastLater(route, request, ctx, NO_RESULT)
    let result: unknown
    let reply: AdapterReply | undefined
    try {
      result = plan.definition.invoke(this.#resolve(plan.controller), ctx)
      if (isThenable(result)) return this.#fastLater(route, request, ctx, result)
      reply = this.#fastReply(route, ctx, result)
    } catch (error) {
      const x = new Exchange(request, ctx, ctx.requestId, route.target)
      x.done = this.#respond(x, () => this.#failed(error, ctx, x.event))
      return x
    }
    if (reply !== undefined) {
      ctx.commit()
      ctx.releaseBody()
      return reply
    }
    const x = new Exchange(request, ctx, ctx.requestId, route.target)
    x.done = this.#respond(x, () => this.#settle(ctx, plan, x.event, result))
    return x
  }

  /** The fast lane of a route with a body to read or a handler that returned a thenable. */
  #fastLater(route: FastRoute, request: AdapterRequest, ctx: RequestContext, result: unknown): Exchange {
    const x = new Exchange(request, ctx, ctx.requestId, route.target)
    x.done = this.#fastAsync(x, route, result)
    return x
  }

  /**
   * The asynchronous part of the fast lane, in the request scope: the body read (`result` is
   * {@link NO_RESULT}) and the handler run, or the thenable it returned awaited. Never rejects.
   */
  async #fastAsync(x: Exchange, route: FastRoute, pending: unknown): Promise<void> {
    const ctx = x.ctx
    const plan = route.plan
    let result = pending
    let reply: AdapterReply | undefined
    try {
      if (result === NO_RESULT) {
        const controller = this.#resolve(plan.controller)
        await ctx.parseBody()
        result = plan.definition.invoke(controller, ctx)
      }
      if (isThenable(result)) result = await result
      reply = this.#fastReply(route, ctx, result)
    } catch (error) {
      await this.#respond(x, () => this.#failed(error, ctx, x.event))
      return
    }
    if (reply === undefined) {
      const value = result
      await this.#respond(x, () => this.#settle(ctx, plan, x.event, value))
      return
    }
    ctx.commit()
    ctx.releaseBody()
    // a listener registered since the request started gets a complete event
    if (x.tracked) x.event.status = reply.status
    x.answer(reply)
  }

  /**
   * The reply of a plain JSON value (see {@link isPlainJson}) or of `undefined`: what
   * `serializeResult` and {@link #complete} produce for it, the headers in their final order.
   * `undefined` when the result or the context needs the general pipeline. Throws like
   * `JSON.stringify`.
   */
  #fastReply(route: FastRoute, ctx: RequestContext, result: unknown): AdapterReply | undefined {
    const status = result === undefined ? route.emptyStatus : route.jsonStatus
    // draining since the request started (`connection: close`, see #frameworkHeaders)
    if (status === undefined || ctx.hasResponseHeaders || ctx.hasCookies || this.draining) return undefined
    const requestId = ctx.requestId
    // a custom generator's id that cannot be sent is left out (see #frameworkHeaders)
    if (!this.#validIds && !isHeaderValue(requestId)) return undefined
    if (result === undefined) {
      const headers: Record<string, HeaderValue> = { ...this.#emptyHeaders }
      const idHeader = this.#emptyIdHeader
      if (idHeader !== undefined) headers[idHeader] = requestId
      return { status, headers, body: null }
    }
    if (!isPlainJson(result)) return undefined
    const json = JSON.stringify(result)
    if (json === undefined) throw new TypeError(`Cannot serialise a ${typeof result} as a response body`)
    const headers: Record<string, HeaderValue> = { ...this.#jsonHeaders }
    // encoded once, its length from the bytes (see serialize.ts encodeText)
    const body = utf8(json)
    headers['content-length'] = String(body.byteLength)
    const idHeader = this.#jsonIdHeader
    if (idHeader !== undefined) headers[idHeader] = requestId
    return { status, headers, body, text: json }
  }

  /** Ends a fast-lane request once its asynchronous part settled: its scope is closed, then it is over. */
  #end(x: Exchange, scope: OpenedScope, error: unknown): void {
    const closing = scope.close()
    if (error !== undefined) {
      // like runInScope: the scope closes, then the failure is reported (#respond never rejects)
      const report = (): void => this.#disposalFailed(x, error)
      if (closing === undefined) report()
      else closing.then(report, report)
      return
    }
    if (closing === undefined) this.#over(x)
    else
      closing.then(
        () => this.#over(x),
        (failure: unknown) => this.#disposalFailed(x, failure),
      )
  }

  #disposalFailed(x: Exchange, error: unknown): void {
    this.#over(x)
    this.#logger.error('Failed to dispose request-scoped providers', { err: error, requestId: x.requestId })
  }

  /**
   * Handles a request routed to `plan` by the adapter. The request stays in flight (and its scope
   * open) until a streamed or file response body has been fully read or cancelled by the adapter.
   */
  handle(plan: RoutePlan, request: AdapterRequest): Promise<AdapterReply> {
    const startTime = performance.now()
    try {
      return this.#isPreflight(request) ? this.#preflight(request, startTime) : this.#route(plan, request, startTime)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  #route(plan: RoutePlan, request: AdapterRequest, startTime: number, rerouted = false): Promise<AdapterReply> {
    const url = splitUrl(request.url)
    const raw = matchRoutePath(plan.path, url.path)
    // the native router matched a path the Znight grammar rejects (e.g. an empty `:param` in Fastify)
    // or a normalised path (Hono): route the raw path with the route table instead
    if (raw === undefined) return this.#fallback(request, undefined, startTime, !rerouted)
    if (plan.redirect === true) {
      const canonical = sameOriginPath(url.path.slice(0, -1))
      const location = url.query === '' ? canonical : `${canonical}?${url.query}`
      const target: Target = { kind: 'redirect', location }
      return this.#serve(request, url, undefined, emptyRecord(), target, startTime, plan.body)
    }
    const params = emptyRecord<string>()
    let malformed: string | undefined
    for (const name of Object.keys(raw)) {
      const decoded = decodePathValue(raw[name] as string)
      if (decoded === undefined) malformed ??= name
      else params[name] = decoded
    }
    const target: Target =
      malformed === undefined
        ? { kind: 'route', plan }
        : { kind: 'error', error: new BadRequestException(`Malformed URL parameter "${malformed}"`) }
    return this.#serve(request, url, plan.info, params, target, startTime, plan.body)
  }

  /** Handles an unmatched request (404, 405, automatic OPTIONS) or a framework error. */
  fallback(request: AdapterRequest, error?: unknown): Promise<AdapterReply> {
    const startTime = performance.now()
    try {
      return this.#fallback(request, error, startTime)
    } catch (failure) {
      return Promise.reject(failure)
    }
  }

  #fallback(request: AdapterRequest, error: unknown, startTime: number, reroute = true): Promise<AdapterReply> {
    const body = this.#options.body
    if (error !== undefined) {
      const target: Target = { kind: 'error', error: frameworkError(error) }
      return this.#serve(request, splitUrl(request.url), undefined, emptyRecord(), target, startTime, body)
    }
    if (this.#isPreflight(request)) return this.#preflight(request, startTime)
    const url = splitUrl(request.url)
    const path = url.path
    if (reroute) {
      // routing happens on the raw path: serve a route the adapter's router missed (Hono routes the
      // WHATWG-normalised URL, where `/files/%2e%2e/x` became `/x`)
      const plan = this.#table.find(request.method, path)
      if (plan !== undefined) return this.#route(plan, request, startTime, true)
    }
    const allowed = this.#table.allowedMethods(path)
    let target: Target
    if (allowed.length === 0) {
      target = { kind: 'error', error: new NotFoundException(`Cannot ${request.method} ${truncate(path)}`) }
    } else if (request.method === 'OPTIONS') {
      target = { kind: 'options', allow: allowHeader(allowed) }
    } else {
      // OPTIONS is answered automatically, hence supported (RFC 9110 §15.5.6: the same list as OPTIONS)
      target = {
        kind: 'error',
        error: new MethodNotAllowedException(
          `Method ${request.method} is not allowed on ${truncate(path)}`,
          undefined,
          {
            headers: { allow: allowHeader(allowed) },
          },
        ),
      }
    }
    return this.#serve(request, url, undefined, emptyRecord(), target, startTime, body)
  }

  /** A CORS preflight (with the `cors` option): answered without running any route. */
  #isPreflight(request: AdapterRequest): boolean {
    return this.#options.cors !== undefined && isPreflight(request.method, request.headers)
  }

  #preflight(request: AdapterRequest, startTime: number): Promise<AdapterReply> {
    const url = splitUrl(request.url)
    const allowed = this.#table.allowedMethods(url.path)
    const target: Target = { kind: 'preflight', allow: allowed.length === 0 ? undefined : allowHeader(allowed) }
    return this.#serve(request, url, undefined, emptyRecord(), target, startTime, this.#options.body)
  }

  #serve(
    request: AdapterRequest,
    url: RequestTarget,
    route: HttpRouteInfo | undefined,
    params: Record<string, string>,
    target: Target,
    startTime: number,
    body: BodyPlan,
  ): Promise<AdapterReply> {
    this.#enter()
    let x: Exchange
    try {
      const requestId = this.#requestId(request)
      const ctx = this.#context(request, requestId, url.path, url.query, route, params, body)
      // an event stream requested while draining is served (guards run) with its signal already
      // aborted: a well-behaved source ends at once and the client gets a jittered retry
      if (this.draining && target.kind === 'route' && target.plan.definition.sse !== undefined) ctx.abort('shutdown')
      x = new Exchange(request, ctx, requestId, target, startTime)
    } catch (error) {
      // failed before its scope opened (a request id generator that throws...)
      this.#leave()
      return Promise.reject(error)
    }
    // the scope (request-scoped instances) stays open until a streamed or file body has been sent or abandoned
    this.#container
      .runInScope(
        () => this.#respond(x, undefined),
        [
          [HttpTokens.Context, x.ctx],
          [HttpTokens.RequestId, x.requestId],
        ],
      )
      .then(
        () => this.#over(x),
        (error: unknown) => {
          this.#over(x)
          // #respond never rejects: only the disposal of request-scoped instances can fail
          this.#logger.error('Failed to dispose request-scoped providers', { err: error, requestId: x.requestId })
        },
      )
    // listeners run once the reply is ready, before the adapter gets it, out of the request scope
    return this.#hooks.hasListeners('http:request') ? this.#emitted(x) : x.replied
  }

  /** The reply of a request once the `http:request` listeners saw its event. */
  #emitted(x: Exchange): Promise<AdapterReply> {
    return x.replied.then(reply => {
      this.#hooks.emit('http:request', x.event)
      return reply
    })
  }

  /** The request context of a request (internal). */
  #context(
    request: AdapterRequest,
    requestId: RequestId,
    path: string,
    query: string,
    route: HttpRouteInfo | undefined,
    params: Record<string, string>,
    body: BodyPlan,
  ): RequestContext {
    const proxy = this.#options.trustProxy
    return new RequestContext(
      request,
      requestId,
      this.#options.adapter,
      path,
      query,
      route,
      params,
      body,
      this.#cookies,
      proxy === undefined
        ? undefined
        : proxy.resolve(request.remoteAddress ?? request.ip, request.headers, request.encrypted === true),
    )
  }

  /**
   * Answers a request in its scope: its outcome (`process`, or the target of the exchange after the
   * CORS decision and through the `http:request` wrappers), checked, completed and handed to the
   * adapter; a streamed body is then tracked until it was sent or abandoned. Never rejects.
   * `process` is given by the fast lane, which decided at the start of the request that no wrapper
   * applies and that CORS is off.
   */
  async #respond(x: Exchange, process: (() => Outcome | Promise<Outcome>) | undefined): Promise<void> {
    const ctx = x.ctx
    const requestId = x.requestId
    const event = x.event
    let outcome: Outcome | undefined
    let hookError: unknown
    let failed = false
    let run: ContextRunner | undefined
    // only a wrapper can change a reply between its checks below and the adapter
    let recheck = false
    let work = process
    if (work === undefined) {
      if (this.#options.cors !== undefined) x.cors = await this.#corsDecision(x.request, requestId)
      recheck = this.#hooks.hasWrappers('http:request')
      const target = x.target
      work = () => this.#process(ctx, target, event, x.cors)
    }
    try {
      if (recheck) {
        const inner = work
        await this.#hooks.run('http:request', event, async () => {
          outcome = this.#checked(await inner(), ctx, event)
          // stream producers run in the context of the handler (scope, wrappers)
          if (outcome !== RAW && isStreamed(outcome.body)) run = captureContext()
          return outcome
        })
      } else {
        // what hooks.run() does without wrappers, in the same async context
        outcome = this.#checked(await work(), ctx, event)
      }
    } catch (error) {
      failed = true
      hookError = error
    }
    if (outcome === undefined) {
      // a wrapper failed before the request was handled, or did not call next(): answer anyway
      const error = failed ? hookError : new Error('An "http:request" hook wrapper did not call next()')
      event.error ??= error
      // the same checks as a handled reply: an exception mapper's HttpResponse may carry cookies
      const fallback = await this.#errorReply(error, ctx)
      outcome = this.#checkCookies(this.#checkHeaders(fallback, ctx, event), ctx, event)
      event.status = outcome.status
      recheck = true
    } else if (failed) {
      this.#logger.error('An "http:request" hook wrapper failed after the request was handled', {
        err: hookError,
        requestId,
      })
    }
    if (outcome === RAW) {
      ctx.commit()
      const status = x.request.rawStatus?.() ?? 200
      event.status ??= status
      x.answer({ status, headers: {}, body: null, raw: true })
      return
    }
    const serialized = this.#complete(outcome, ctx, event, requestId, x.cors, x.preflight, recheck)
    const body = serialized.body
    if (!isStreamed(body)) {
      const reply = adapterReply(serialized, body)
      ctx.commit()
      ctx.releaseBody()
      x.answer(reply)
      return
    }
    // files too: a file-backed Blob is read lazily, after the handler returned
    const tracked = trackStream(body, run ?? captureContext(), () => ctx.abort('client'))
    const session = serialized.sse
    const reply = adapterReply(serialized, tracked.stream, body instanceof Blob ? body : undefined)
    if (session !== undefined) {
      this.#streams.add(session)
      if (this.draining) session.close('shutdown')
    }
    ctx.commit()
    x.answer(reply)
    const failure = await tracked.done
    if (session !== undefined) this.#streams.delete(session)
    if (failure !== undefined) {
      this.#logger.error('The response stream failed', { err: failure, requestId, path: ctx.path })
    }
    ctx.releaseBody()
  }

  /** The request is over (response body sent or abandoned, scope closed). */
  #over(x: Exchange): void {
    const ctx = x.ctx
    ctx.complete()
    try {
      if (!x.answered) {
        const failure = new Error('Request not handled')
        const reply = serializeError(500, this.#internalBody(failure), ctx.method)
        const completed = this.#complete(reply, ctx, x.event, x.requestId, x.cors, x.preflight, true)
        x.event.status = 500
        x.answer(completed)
      }
    } catch (error) {
      x.fail(error)
    } finally {
      this.#leave()
    }
  }

  /**
   * Adds the headers of the `http:request` wrappers, then the framework headers (see
   * {@link #frameworkHeaders}). When wrappers ran (`recheck`), checks the final headers again (see
   * {@link #checkHeaders}): the reply was checked before, and the cookies and framework headers are
   * valid by construction.
   */
  #complete(
    reply: CheckedReply,
    ctx: RequestContext,
    event: HttpRequestEvent,
    requestId: RequestId,
    cors: CorsDecision | undefined,
    preflight: boolean,
    recheck: boolean,
  ): SerializedReply {
    addMissingHeaders(reply.headers, event.responseHeaders)
    applyCookies(reply, ctx)
    this.#frameworkHeaders(reply.headers, requestId, cors, preflight)
    if (!recheck) return reply
    const checked = this.#checkHeaders(reply, ctx, event)
    if (checked !== reply) {
      applyCookies(checked, ctx)
      this.#frameworkHeaders(checked.headers, requestId, cors, preflight)
    }
    return checked
  }

  /** Checks the headers (unless only the serialiser set them), then the cookies of a reply. */
  #checked(outcome: Outcome, ctx: RequestContext, event: HttpRequestEvent): Outcome {
    if (outcome === RAW) return outcome
    const checked = outcome.ownHeaders === true ? outcome : this.#checkHeaders(outcome, ctx, event)
    return this.#checkCookies(checked, ctx, event)
  }

  /**
   * Serialises the cookies of an `HttpResponse` (`withCookie`) with the plugin settings (defaults,
   * signing). A cookie breaking a rule that depends on them (a prefix with the `secure` default,
   * `SameSite=None` without `secure`, signing without secrets, the size after signing) turns the
   * reply into a plain 500, logged as `Invalid cookie "x": …` (like an invalid header).
   */
  #checkCookies(reply: SerializedReply, ctx: RequestContext, event: HttpRequestEvent): CheckedReply {
    const cookies = reply.cookies
    if (cookies === undefined || cookies.length === 0) return reply
    const settings = this.#cookies
    const lines: SerializedCookie[] = []
    try {
      for (const cookie of cookies) lines.push(serializeWith(cookie, settings))
    } catch (error) {
      if (reply.body instanceof ReadableStream) discardStream(reply.body)
      event.error = error
      event.status = 500
      this.#log(error, ctx)
      return serializeError(500, this.#internalBody(error), ctx.method)
    }
    return { ...reply, cookieLines: lines }
  }

  /**
   * Headers the plugin adds to every reply when nothing set them: the request id, the CORS headers
   * of an allowed origin (`vary: origin` whatever the origin) or, with a wildcard policy, of every
   * reply (`access-control-allow-origin: *` does not depend on the request, so a cached reply serves
   * CORS and non-CORS requests alike), the security headers; and `connection: close` while
   * draining.
   */
  #frameworkHeaders(
    headers: Record<string, HeaderValue>,
    requestId: RequestId,
    cors: CorsDecision | undefined,
    preflight: boolean,
  ): void {
    const header = this.#options.requestIdHeader
    if (header !== undefined && headers[header] === undefined && (this.#validIds || isHeaderValue(requestId))) {
      headers[header] = requestId
    }
    const policy = this.#options.cors
    if (policy !== undefined) {
      // a preflight answer carries its own CORS headers; other replies get them for allowed origins,
      // or always with a wildcard policy (with or without an origin header: no vary needed)
      if (!preflight) {
        if (policy.wildcard) addMissingHeaders(headers, corsReplyHeaders(policy, '*'))
        else if (cors?.allowed === true) addMissingHeaders(headers, corsReplyHeaders(policy, cors.origin))
      }
      if (policy.varyOrigin) mergeVary(headers, 'origin')
    }
    for (const [name, value] of this.#securityHeaders) if (headers[name] === undefined) headers[name] = value
    if (this.draining) headers['connection'] = 'close'
  }

  /**
   * The CORS decision of a request carrying an `origin` header, made once before the hooks run. An
   * origin function that throws or rejects denies the origin (logged).
   */
  async #corsDecision(request: AdapterRequest, requestId: RequestId): Promise<CorsDecision | undefined> {
    const policy = this.#options.cors
    const origin = request.headers['origin']
    if (policy === undefined || origin === undefined) return undefined
    let allowed = false
    try {
      // an origin that cannot be echoed in a response header is never allowed
      allowed = isHeaderValue(origin) && (await policy.allows(origin)) === true
    } catch (error) {
      this.#logger.error('The CORS origin check failed: the origin is denied', { err: error, requestId, origin })
    }
    return { policy, origin, allowed }
  }

  /**
   * A reply with a header no adapter can send (`ctx.setHeader('x', 'a\r\nb')`, a redirect to a
   * client-provided URL with CR/LF, a non Latin-1 value...) becomes a plain 500, identical on every
   * adapter: its body is discarded (a stream is cancelled) and the error logged.
   */
  #checkHeaders(reply: SerializedReply, ctx: RequestContext, event: HttpRequestEvent): SerializedReply {
    const name = findInvalidHeader(reply.headers)
    if (name === undefined) return reply
    if (reply.body instanceof ReadableStream) discardStream(reply.body)
    const error = new TypeError(`Invalid response header ${JSON.stringify(truncate(name))}: invalid name or value`)
    event.error = error
    event.status = 500
    this.#log(error, ctx)
    return serializeError(500, this.#internalBody(error), ctx.method)
  }

  /** The outcome of a request: its route run, or a reply of the framework. Never rejects (errors are mapped). */
  #process(
    ctx: RequestContext,
    target: Target,
    event: HttpRequestEvent,
    cors: CorsDecision | undefined,
  ): Promise<Outcome> {
    return target.kind === 'route' ? this.#invoke(ctx, target.plan, event) : this.#answer(ctx, target, event, cors)
  }

  /** Answers a request without running a route. Never rejects. */
  async #answer(
    ctx: RequestContext,
    target: Exclude<Target, { readonly kind: 'route' }>,
    event: HttpRequestEvent,
    cors: CorsDecision | undefined,
  ): Promise<SerializedReply> {
    try {
      switch (target.kind) {
        case 'error':
          throw target.error
        case 'preflight':
          // never runs guards, interceptors or handlers (@Options and @All routes included)
          if (target.allow === undefined) throw new NotFoundException(`Cannot OPTIONS ${truncate(ctx.path)}`)
          if (cors === undefined || !cors.allowed) throw new ForbiddenException('CORS origin not allowed')
          return this.#finish(event, {
            status: 204,
            headers: withContextHeaders(preflightHeaders(cors.policy, cors.origin, ctx.headers, target.allow), ctx),
            body: null,
          })
        case 'options':
          return this.#finish(event, {
            status: 204,
            headers: withContextHeaders({ allow: target.allow }, ctx),
            body: null,
          })
        case 'redirect':
          return this.#finish(
            event,
            serializeResult(undefined, {
              method: ctx.method,
              routeMethod: ctx.method,
              status: 308,
              headers: { location: target.location },
            }),
          )
      }
    } catch (error) {
      return await this.#failed(error, ctx, event)
    }
  }

  /** The reply of an error (see {@link #errorReply}), recorded on the event. */
  async #failed(error: unknown, ctx: RequestContext, event: HttpRequestEvent): Promise<SerializedReply> {
    event.error = error
    const reply = await this.#errorReply(error, ctx)
    event.status = reply.status
    return reply
  }

  /** Runs a route: guards, body, interceptors, handler, serialisation. Never rejects (errors are mapped). */
  async #invoke(ctx: RequestContext, plan: RoutePlan, event: HttpRequestEvent): Promise<Outcome> {
    let result: unknown
    try {
      const controller = this.#resolve(plan.controller)
      for (const guard of plan.guards) {
        const allowed = await this.#resolve(guard).canActivate(ctx)
        if (allowed !== true) throw new ForbiddenException('Forbidden resource')
      }
      if (plan.parseBody) await ctx.parseBody()
      const definition = plan.definition
      const interceptors = plan.interceptors
      if (interceptors.length === 0) {
        result = definition.invoke(controller, ctx)
      } else {
        const chain = async (index: number): Promise<unknown> => {
          if (index === interceptors.length) return await definition.invoke(controller, ctx)
          const interceptor = this.#resolve(interceptors[index] as Resolvable<HttpInterceptor>)
          return await interceptor.intercept(ctx, () => chain(index + 1))
        }
        result = chain(0)
      }
    } catch (error) {
      return await this.#failed(error, ctx, event)
    }
    const settled = this.#settle(ctx, plan, event, result)
    return settled instanceof Promise ? await settled : settled
  }

  /**
   * The rest of {@link #invoke} once the handler (and its interceptors) returned `result`: awaited
   * when it is a thenable, then serialised. Never throws nor rejects (errors are mapped).
   */
  #settle(ctx: RequestContext, plan: RoutePlan, event: HttpRequestEvent, result: unknown): Outcome | Promise<Outcome> {
    if (isThenable(result)) return this.#settleLater(ctx, plan, event, result)
    try {
      const outcome = this.#outcome(ctx, plan, event, result)
      return outcome instanceof Promise ? outcome.catch(error => this.#failed(error, ctx, event)) : outcome
    } catch (error) {
      return this.#failed(error, ctx, event)
    }
  }

  async #settleLater(
    ctx: RequestContext,
    plan: RoutePlan,
    event: HttpRequestEvent,
    pending: PromiseLike<unknown>,
  ): Promise<Outcome> {
    let result: unknown
    try {
      result = await pending
    } catch (error) {
      return await this.#failed(error, ctx, event)
    }
    const settled = this.#settle(ctx, plan, event, result)
    return settled instanceof Promise ? await settled : settled
  }

  /**
   * The outcome of a handler result: `RAW` for a `@Res()` route, otherwise its reply (files resolved,
   * event streams opened: only an `HttpResponse` may need an asynchronous step). Throws (or rejects)
   * when the result cannot be served.
   */
  #outcome(ctx: RequestContext, plan: RoutePlan, event: HttpRequestEvent, result: unknown): Outcome | Promise<Outcome> {
    const definition = plan.definition
    if (definition.rawResponse === true && !(result instanceof Response)) return RAW
    const options: SerializeOptions = {
      method: ctx.method,
      routeMethod: definition.method,
      status: definition.status,
      headers: definition.headers,
      context: ctx.hasResponseHeaders ? ctx.responseHeaders : undefined,
    }
    const sse = definition.sse
    if (sse !== undefined && !(result instanceof Response) && !isHttpResponse(result)) {
      // an @Sse route: the (awaited) result is the event source
      if (!isSseSource(result)) {
        throw new TypeError(
          `@Sse handler ${displayName(plan.info.controller)}.${definition.handler} must return an AsyncIterable, an Iterable or a ReadableStream of SseEvent (received ${describeResult(result)})`,
        )
      }
      return this.#finish(event, serializeSseReply(this.#openStream(result, sseOptions(sse), ctx), undefined, options))
    }
    if (!isHttpResponse(result)) return this.#finish(event, serializeResult(result, options))
    return this.#serialize(result, ctx, options, sse).then(reply => this.#finish(event, reply))
  }

  /** Serialises a handler (or exception mapper) result; file bodies are resolved, event streams opened. */
  async #serialize(
    result: unknown,
    ctx: RequestContext,
    options: SerializeOptions,
    route?: HttpSseDefinition,
  ): Promise<SerializedReply> {
    if (isHttpResponse(result)) {
      if (isFileBody(result.body)) return serializeFileReply(await resolveFile(result.body, ctx), result, options)
      if (isSseBody(result.body)) {
        const body = result.body
        // HttpResponse.sse() options win over the @Sse options of the route
        const merged = { ...(route === undefined ? {} : sseOptions(route)), ...definedOptions(body.options) }
        return serializeSseReply(this.#openStream(body.source, merged, ctx), result, options)
      }
    }
    return serializeResult(result, options)
  }

  /** An event stream reading `source` in the request (route options over the plugin `sse` option). */
  #openStream(source: SseSource, options: SseOptions, ctx: RequestContext): SseSession {
    const settings = this.#options.sse ?? DEFAULT_SSE_SETTINGS
    const heartbeat = options.heartbeat === undefined ? settings.heartbeat : options.heartbeat || 0
    const retry = options.retry ?? settings.retry
    const logger = this.#logger
    return new SseSession(
      source,
      {
        heartbeat,
        retry,
        maxDuration: options.maxDuration,
        graceMs: settings.shutdownGraceMs,
      },
      {
        abort: kind => ctx.abort(kind),
        error: (message, error) => logger.error(message, { err: error, requestId: ctx.requestId, path: ctx.path }),
        warn: message => logger.warn(message, { requestId: ctx.requestId, path: ctx.path }),
      },
    )
  }

  #finish(event: HttpRequestEvent, reply: SerializedReply): SerializedReply {
    event.status = reply.status
    return reply
  }

  /** Maps an error to a reply: exception mappers first, then the default rendering. Never throws. */
  async #errorReply(error: unknown, ctx: RequestContext): Promise<SerializedReply> {
    for (const mapper of this.#options.mappers) {
      let mapped: unknown
      try {
        mapped = await this.#resolve(mapper).map(error, ctx)
      } catch (mapperError) {
        this.#logger.error('An exception mapper failed', { err: mapperError, requestId: ctx.requestId })
        continue
      }
      if (mapped === undefined) continue
      try {
        if (isHttpResponse(mapped) && mapped.status === undefined) {
          // an error response without explicit status keeps the status of the error
          mapped = new HttpResponse(mapped.body, {
            status: isHttpException(error) ? error.status : 500,
            headers: mapped.headers,
            cookies: (mapped as { cookies?: HttpResponse['cookies'] }).cookies ?? [],
          })
        }
        if (mapped instanceof Response || isHttpResponse(mapped)) {
          return await this.#serialize(mapped, ctx, {
            method: ctx.method,
            routeMethod: ctx.method,
            status: undefined,
            headers: undefined,
            context: ctx.hasResponseHeaders ? ctx.responseHeaders : undefined,
          })
        }
        if (isHttpException(mapped)) return this.#renderException(mapped, ctx, error)
      } catch (renderError) {
        this.#logger.error('Failed to render the result of an exception mapper', {
          err: renderError,
          requestId: ctx.requestId,
        })
        continue
      }
      this.#logger.warn(
        'An exception mapper returned an unsupported value (expected HttpException, HttpResponse, Response or undefined)',
        {
          requestId: ctx.requestId,
        },
      )
    }
    return this.#renderException(error, ctx, error)
  }

  #renderException(error: unknown, ctx: RequestContext, original: unknown): SerializedReply {
    let status: number
    let body: unknown
    let extra: Readonly<Record<string, HeaderValue>> | undefined
    if (isHttpException(error)) {
      status = error.status
      try {
        body = error.toBody()
      } catch (bodyError) {
        this.#log(bodyError, ctx)
        status = 500
        body = this.#internalBody(bodyError)
      }
      extra = error.headers
      if (status >= 500) this.#log(original, ctx)
    } else {
      status = 500
      body = this.#internalBody(error)
      this.#log(error, ctx)
    }
    let reply: SerializedReply
    try {
      reply = serializeError(status, body, ctx.method)
    } catch (serializeFailure) {
      this.#log(serializeFailure, ctx)
      reply = serializeError(500, this.#internalBody(serializeFailure), ctx.method)
      extra = undefined
    }
    if (ctx.hasResponseHeaders) assignHeaders(reply.headers, ctx.responseHeaders)
    if (extra !== undefined) assignHeaders(reply.headers, extra)
    return reply
  }

  #internalBody(error: unknown): object {
    return this.#options.exposeErrors
      ? { statusCode: 500, error: 'Internal Server Error', message: errorMessage(error) }
      : { statusCode: 500, error: 'Internal Server Error' }
  }

  #log(error: unknown, ctx: RequestContext): void {
    const route = ctx.route
    this.#logger.error(`Request failed: ${ctx.method} ${route?.path ?? truncate(ctx.path)}`, {
      err: error,
      requestId: ctx.requestId,
      method: ctx.method,
      path: ctx.path,
      ...(route === undefined
        ? {}
        : { route: route.path, handler: `${displayName(route.controller)}.${route.handler}` }),
    })
  }

  #resolve<T>(resolvable: Resolvable<T>): T {
    return 'instance' in resolvable ? resolvable.instance : (this.#container.get(resolvable.token) as T)
  }

  #requestId(request: AdapterRequest): RequestId {
    const header = this.#options.requestIdHeader
    if (header !== undefined) {
      const incoming = request.headers[header]
      if (incoming !== undefined && REQUEST_ID.test(incoming)) return incoming as RequestId
    }
    return this.#options.generateRequestId() as RequestId
  }

  #enter(): void {
    this.#inflight++
  }

  #leave(): void {
    this.#inflight--
    if (this.#inflight === 0 && this.#idle.length > 0) {
      const waiting = this.#idle
      this.#idle = []
      for (const resolve of waiting) resolve()
    }
  }
}

/** A route served by the fast lane (see `Pipeline.handler`), decided at boot. */
interface FastRoute {
  readonly plan: RoutePlan
  readonly target: Target
  /** The method of the route definition (requests of another method take the general pipeline). */
  readonly method: string
  /** The status of a JSON reply, `undefined` when it has no body (such replies take the general pipeline). */
  readonly jsonStatus: number | undefined
  /** The status of a reply without value (`undefined` returned). */
  readonly emptyStatus: number
}

/** `#fastAsync` reads the body and runs the handler. */
const NO_RESULT: unique symbol = Symbol('no result')

/** A request being answered (internal): its context, its target and the promise of its reply. */
class Exchange {
  readonly request: AdapterRequest
  readonly ctx: RequestContext
  readonly requestId: RequestId
  readonly target: Target
  readonly preflight: boolean
  readonly replied: Promise<AdapterReply>
  cors: CorsDecision | undefined = undefined
  answered = false
  /** The `http:request` listeners will see the event (fast lane: keep its status). */
  tracked = false
  /** The asynchronous part of a fast-lane request (never rejects). */
  done: Promise<void> | undefined = undefined
  readonly #resolve: (reply: AdapterReply) => void
  readonly #reject: (error: unknown) => void
  #event: HttpRequestEvent | undefined

  /** `startTime`: the event is created now (general pipeline); otherwise when first needed (fast lane). */
  constructor(request: AdapterRequest, ctx: RequestContext, requestId: RequestId, target: Target, startTime?: number) {
    this.request = request
    this.ctx = ctx
    this.requestId = requestId
    this.target = target
    this.preflight = target.kind === 'preflight'
    let resolve: ((reply: AdapterReply) => void) | undefined
    let reject: ((error: unknown) => void) | undefined
    this.replied = new Promise<AdapterReply>((onReply, onError) => {
      resolve = onReply
      reject = onError
    })
    this.#resolve = resolve as (reply: AdapterReply) => void
    this.#reject = reject as (error: unknown) => void
    if (startTime !== undefined) this.#event = requestEvent(request, ctx, startTime)
  }

  /**
   * The `http:request` event. The fast lane creates it when the general pipeline takes over: no
   * hook saw the request start, so its `startTime` is not observed.
   */
  get event(): HttpRequestEvent {
    this.#event ??= requestEvent(this.request, this.ctx, performance.now())
    return this.#event
  }

  answer(reply: AdapterReply): void {
    this.answered = true
    this.#resolve(reply)
  }

  fail(error: unknown): void {
    this.#reject(error)
  }
}

/** The `http:request` event of a request. */
function requestEvent(request: AdapterRequest, ctx: RequestContext, startTime: number): HttpRequestEvent {
  return {
    method: request.method,
    path: ctx.path,
    route: ctx.route?.path,
    requestId: ctx.requestId,
    headers: request.headers,
    context: ctx,
    startTime,
    responseHeaders: {},
  }
}

/**
 * The decoded parameters of a raw request path matched against a route, in one pass: what
 * `matchRoutePath` then `decodePathValue` (see `Pipeline.#route`) give for a path they accept.
 * `undefined` when the path does not match or a value is not valid percent-encoding: the general
 * pipeline then answers it (a reroute, a 400).
 */
function routeParams(route: RoutePath, path: string): Record<string, string> | undefined {
  if (path.charCodeAt(0) !== 47 /* / */) return undefined
  const params = emptyRecord<string>()
  const segments = route.segments
  const last = segments.length - 1
  if (last === -1) return path === '/' ? params : undefined
  let position = 1
  for (let index = 0; index <= last; index++) {
    const segment = segments[index] as RouteSegment
    if (segment.kind === 'wildcard') {
      const rest = decodePathValue(path.slice(position))
      if (rest === undefined) return undefined
      params[WILDCARD_PARAM] = rest
      return params
    }
    const slash = path.indexOf('/', position)
    const end = slash === -1 ? path.length : slash
    if (segment.kind === 'static') {
      const value = segment.value
      if (end - position !== value.length || !path.startsWith(value, position)) return undefined
    } else {
      if (end === position) return undefined
      const decoded = decodePathValue(path.slice(position, end))
      if (decoded === undefined) return undefined
      params[segment.name] = decoded
    }
    if (index === last) return end === path.length ? params : undefined
    if (slash === -1) return undefined
    position = slash + 1
  }
  return params
}

/**
 * A value the fast lane serialises as JSON: a plain object or array (its own prototype and
 * constructor), not duck-typed as a Node.js stream. Anything `serializeResult` could treat otherwise
 * (`HttpResponse`, `Response`, bytes, streams, `Blob`, strings, `undefined`...) is not.
 */
function isPlainJson(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false
  const prototype: unknown = Object.getPrototypeOf(value)
  const ctor = (value as { constructor?: unknown }).constructor
  if (prototype === Object.prototype) {
    if (ctor !== Object) return false
  } else if (prototype !== Array.prototype || ctor !== Array) {
    return false
  }
  return typeof (value as { pipe?: unknown }).pipe !== 'function'
}

const ENCODER = new TextEncoder()

/** UTF-8 encoding of a text body, like the serialiser (a pooled `Buffer` on Node.js, `TextEncoder` on Bun). */
const utf8: (text: string) => Uint8Array = isBun() ? text => ENCODER.encode(text) : text => Buffer.from(text, 'utf8')

/**
 * The reply handed to the adapter (internal fields of the serialised reply left out). A streamed
 * `text/event-stream` body is an event stream whatever produced it (`@Sse`, `HttpResponse.sse()`, a
 * proxied `fetch()` response, `HttpResponse.stream()`): the adapter sends its headers at once, even
 * before a quiet stream's first byte, and lifts idle timeouts.
 */
function adapterReply(serialized: SerializedReply, body: ReplyBody, blob?: Blob): AdapterReply {
  const text = serialized.text
  if (text !== undefined) return { status: serialized.status, headers: serialized.headers, body, text }
  const reply: AdapterReply = { status: serialized.status, headers: serialized.headers, body }
  if (blob !== undefined) return { ...reply, blob }
  const eventStream =
    serialized.sse !== undefined ||
    (body instanceof ReadableStream && isEventStreamType(serialized.headers['content-type']))
  return eventStream ? { ...reply, eventStream: true } : reply
}

/**
 * Appends the cookies to `set-cookie`, after the raw values (`@Header`, `ctx.setHeader()`, the
 * `HttpResponse` headers, a Web `Response`): the cookies of the context (`ctx.setCookie()`), then
 * those of the `HttpResponse`, a cookie of the same key (name, domain, path) replacing the earlier
 * one in place. One line per cookie.
 */
function applyCookies(reply: CheckedReply, ctx: RequestContext): void {
  const own = reply.cookieLines ?? NO_COOKIE_LINES
  const context = ctx.cookieLines
  if (own.length === 0 && context.length === 0) return
  const merged = new Map<string, string>()
  for (const { key, line } of context) merged.set(key, line)
  for (const { key, line } of own) merged.set(key, line)
  const existing = reply.headers['set-cookie']
  let raw: string[] = []
  if (typeof existing === 'string') raw = [existing]
  else if (existing !== undefined) raw = [...existing]
  reply.headers['set-cookie'] = [...raw, ...merged.values()]
}

const NO_COOKIE_LINES: readonly SerializedCookie[] = Object.freeze([])

/** Whether a reply body is streamed (a file is read through a stream too). */
function isStreamed(body: ReplyBody): body is ReadableStream<Uint8Array> | Blob {
  return body instanceof ReadableStream || body instanceof Blob
}

/** `SseOptions` of the `sse` metadata of a route (`heartbeat: 0` disables the heartbeat). */
function sseOptions(definition: HttpSseDefinition): SseOptions {
  return {
    ...(definition.heartbeat === undefined
      ? {}
      : { heartbeat: definition.heartbeat === 0 ? false : definition.heartbeat }),
    ...(definition.retry === undefined ? {} : { retry: definition.retry }),
    ...(definition.maxDuration === undefined ? {} : { maxDuration: definition.maxDuration }),
  }
}

function definedOptions(options: SseOptions): SseOptions {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) if (value !== undefined) result[key] = value
  return result as SseOptions
}

function describeResult(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return 'a string'
  if (typeof value === 'object') return `an instance of ${(value as object).constructor?.name ?? 'Object'}`
  return typeof value
}

function withContextHeaders(headers: Record<string, HeaderValue>, ctx: RequestContext): Record<string, HeaderValue> {
  const result = emptyRecord<HeaderValue>()
  if (ctx.hasResponseHeaders) assignHeaders(result, ctx.responseHeaders)
  assignHeaders(result, headers)
  return result
}

/** Converts an error raised by the server framework (bad URL...) to an `HttpException`. */
function frameworkError(error: unknown): unknown {
  if (isHttpException(error)) return error
  const status =
    (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ??
    (error as { status?: unknown } | null)?.status
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new HttpException(status, errorMessage(error), undefined, { cause: error })
  }
  return error
}

/** `Allow` of a path: its methods and `OPTIONS`, answered automatically when no route declares it. */
function allowHeader(allowed: readonly string[]): string {
  return (allowed.includes('OPTIONS') ? allowed : [...allowed, 'OPTIONS']).join(', ')
}

/**
 * A raw request path usable as a same-origin `Location`: backslashes, controls and spaces are
 * percent-encoded and leading slashes collapsed, since browsers read `/\evil.com` or `//evil.com`
 * as another host (an open redirect through `trailingSlash: 'redirect'`).
 */
function sameOriginPath(path: string): string {
  let encoded = ''
  for (const char of path) {
    const code = char.charCodeAt(0)
    encoded +=
      code <= 0x20 || code === 0x7f || char === '\\' ? `%${code.toString(16).toUpperCase().padStart(2, '0')}` : char
  }
  return encoded.replace(/^\/{2,}/, '/')
}

function truncate(path: string): string {
  return path.length > MAX_PATH_IN_MESSAGE ? `${path.slice(0, MAX_PATH_IN_MESSAGE)}…` : path
}
