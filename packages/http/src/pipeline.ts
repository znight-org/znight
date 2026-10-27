import type { Container, CoreLogger, Hooks, HttpRequestEvent, Token } from '@znight/core'
import type { AdapterReply, AdapterRequest, ReplyBody } from './adapter.ts'
import type { CookieSettings } from './cookie-settings.ts'
import type { SerializedCookie } from './cookies.ts'
import type { CorsPolicy } from './cors.ts'
import type { CanActivate, ExceptionMapper, HttpInterceptor } from './interfaces.ts'
import type { HttpRouteDefinition, HttpSseDefinition } from './metadata.ts'
import type { TrustPolicy } from './proxy.ts'
import type { RouteTable } from './router.ts'
import type { BodyPlan } from './uploads.ts'

import { displayName } from '@znight/core'

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
import { decodePathValue, matchRoutePath, type RoutePath } from './path.ts'
import { splitUrl } from './query.ts'
import { HttpResponse, isHttpResponse } from './response.ts'
import {
  addMissingHeaders,
  assignHeaders,
  type SerializedReply,
  type SerializeOptions,
  serializeError,
  serializeFileReply,
  serializeResult,
  serializeSseReply,
} from './serialize.ts'
import { isSseBody, isSseSource, type SseOptions, SseSession, type SseSource } from './sse.ts'
import { type ContextRunner, captureContext, discardStream, trackStream } from './stream.ts'
import { HttpTokens } from './tokens.ts'
import { emptyRecord, errorMessage } from './utils.ts'

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

/** A reply, and a promise settled once the request is over (response body sent or abandoned, scope closed). */
interface Served {
  readonly reply: AdapterReply
  readonly done: Promise<void>
}

const REQUEST_ID = /^[\w\-.:@/+=]{1,128}$/
const MAX_PATH_IN_MESSAGE = 200

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
   * Handles a request routed to `plan` by the adapter. The request stays in flight (and its scope
   * open) until a streamed or file response body has been fully read or cancelled by the adapter.
   */
  async handle(plan: RoutePlan, request: AdapterRequest): Promise<AdapterReply> {
    const startTime = performance.now()
    this.#enter()
    let served: Served | undefined
    try {
      served = this.#isPreflight(request)
        ? await this.#preflight(request, startTime)
        : await this.#route(plan, request, startTime)
      return served.reply
    } finally {
      this.#leaveWhen(served)
    }
  }

  #route(plan: RoutePlan, request: AdapterRequest, startTime: number, rerouted = false): Promise<Served> {
    const { path, query } = splitUrl(request.url)
    const raw = matchRoutePath(plan.path, path)
    // the native router matched a path the Znight grammar rejects (e.g. an empty `:param` in Fastify)
    // or a normalised path (Hono): route the raw path with the route table instead
    if (raw === undefined) return this.#fallback(request, undefined, startTime, !rerouted)
    if (plan.redirect === true) {
      const canonical = sameOriginPath(path.slice(0, -1))
      const location = query === '' ? canonical : `${canonical}?${query}`
      return this.#serve(request, undefined, emptyRecord(), { kind: 'redirect', location }, startTime, plan.body)
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
    return this.#serve(request, plan.info, params, target, startTime, plan.body)
  }

  /** Handles an unmatched request (404, 405, automatic OPTIONS) or a framework error. */
  async fallback(request: AdapterRequest, error?: unknown): Promise<AdapterReply> {
    const startTime = performance.now()
    this.#enter()
    let served: Served | undefined
    try {
      served = await this.#fallback(request, error, startTime)
      return served.reply
    } finally {
      this.#leaveWhen(served)
    }
  }

  #fallback(request: AdapterRequest, error: unknown, startTime: number, reroute = true): Promise<Served> {
    const body = this.#options.body
    if (error !== undefined) {
      const target: Target = { kind: 'error', error: frameworkError(error) }
      return this.#serve(request, undefined, emptyRecord(), target, startTime, body)
    }
    if (this.#isPreflight(request)) return this.#preflight(request, startTime)
    const { path } = splitUrl(request.url)
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
    return this.#serve(request, undefined, emptyRecord(), target, startTime, body)
  }

  /** A CORS preflight (with the `cors` option): answered without running any route. */
  #isPreflight(request: AdapterRequest): boolean {
    return this.#options.cors !== undefined && isPreflight(request.method, request.headers)
  }

  #preflight(request: AdapterRequest, startTime: number): Promise<Served> {
    const allowed = this.#table.allowedMethods(splitUrl(request.url).path)
    const target: Target = { kind: 'preflight', allow: allowed.length === 0 ? undefined : allowHeader(allowed) }
    return this.#serve(request, undefined, emptyRecord(), target, startTime, this.#options.body)
  }

  async #serve(
    request: AdapterRequest,
    route: HttpRouteInfo | undefined,
    params: Record<string, string>,
    target: Target,
    startTime: number,
    body: BodyPlan,
  ): Promise<Served> {
    const requestId = this.#requestId(request)
    const proxy = this.#options.trustProxy
    const ctx = new RequestContext(request, {
      requestId,
      adapter: this.#options.adapter,
      route,
      params,
      body,
      cookies: this.#options.cookies ?? DEFAULT_COOKIE_SETTINGS,
      ...(proxy === undefined
        ? {}
        : { client: proxy.resolve(request.remoteAddress ?? request.ip, request.headers, request.encrypted === true) }),
    })
    // an event stream requested while draining is served (guards run) with its signal already
    // aborted: a well-behaved source ends at once and the client gets a jittered retry
    if (this.draining && target.kind === 'route' && target.plan.definition.sse !== undefined) ctx.abort('shutdown')
    const event: HttpRequestEvent = {
      method: request.method,
      path: ctx.path,
      route: route?.path,
      requestId,
      headers: request.headers,
      context: ctx,
      startTime,
      responseHeaders: {},
    }
    let outcome: Outcome | undefined
    let reply: AdapterReply | undefined
    let cors: CorsDecision | undefined
    const preflight = target.kind === 'preflight'
    let replied: () => void = () => undefined
    const ready = new Promise<void>(resolve => {
      replied = resolve
    })
    // the scope (request-scoped instances) stays open until a streamed or file body has been sent or abandoned
    const done = this.#container
      .runInScope(async () => {
        let hookError: unknown
        let failed = false
        let run: ContextRunner | undefined
        if (this.#options.cors !== undefined) cors = await this.#corsDecision(request, requestId)
        try {
          await this.#hooks.run('http:request', event, async () => {
            outcome = await this.#process(ctx, target, event, cors)
            if (outcome !== RAW) outcome = this.#checkCookies(this.#checkHeaders(outcome, ctx, event), ctx, event)
            run = captureContext() // stream producers run in the context of the handler (scope, hooks)
            return outcome
          })
        } catch (error) {
          failed = true
          hookError = error
        }
        if (outcome === undefined) {
          // a wrapper failed before the request was handled, or did not call next(): answer anyway
          const error = failed ? hookError : new Error('An "http:request" hook wrapper did not call next()')
          event.error ??= error
          outcome = await this.#errorReply(error, ctx)
          event.status = outcome.status
        } else if (failed) {
          this.#logger.error('An "http:request" hook wrapper failed after the request was handled', {
            err: hookError,
            requestId,
          })
        }
        if (outcome === RAW) {
          ctx.commit()
          replied()
          return
        }
        const serialized = this.#complete(outcome, ctx, event, requestId, cors, preflight)
        const body = serialized.body
        if (!(body instanceof ReadableStream || body instanceof Blob)) {
          reply = adapterReply(serialized, body)
          ctx.commit()
          replied()
          ctx.releaseBody()
          return
        }
        // files too: a file-backed Blob is read lazily, after the handler returned
        const tracked = trackStream(body, run ?? captureContext(), () => ctx.abort('client'))
        const session = serialized.sse
        reply = adapterReply(serialized, tracked.stream, body instanceof Blob ? body : undefined)
        if (session !== undefined) {
          this.#streams.add(session)
          if (this.draining) session.close('shutdown')
        }
        ctx.commit()
        replied()
        const failure = await tracked.done
        if (session !== undefined) this.#streams.delete(session)
        if (failure !== undefined) {
          this.#logger.error('The response stream failed', { err: failure, requestId, path: ctx.path })
        }
        ctx.releaseBody()
      }, [
        [HttpTokens.Context, ctx],
        [HttpTokens.RequestId, requestId],
      ])
      .then(
        () => {
          ctx.complete()
        },
        (error: unknown) => {
          ctx.complete()
          // the callback above never throws: only the disposal of request-scoped instances can fail
          this.#logger.error('Failed to dispose request-scoped providers', { err: error, requestId })
        },
      )
    await Promise.race([ready, done])
    if (outcome === RAW) {
      const status = request.rawStatus?.() ?? 200
      event.status ??= status
      this.#emit(event)
      return { reply: { status, headers: {}, body: null, raw: true }, done }
    }
    if (reply === undefined) {
      const failure = new Error('Request not handled')
      reply = this.#complete(
        serializeError(500, this.#internalBody(failure), ctx.method),
        ctx,
        event,
        requestId,
        cors,
        preflight,
      )
      event.status = 500
    }
    this.#emit(event)
    return { reply, done }
  }

  /**
   * Adds the headers of the `http:request` wrappers, then the framework headers (see
   * {@link #frameworkHeaders}), then checks the final headers (see {@link #checkHeaders}).
   */
  #complete(
    reply: CheckedReply,
    ctx: RequestContext,
    event: HttpRequestEvent,
    requestId: RequestId,
    cors: CorsDecision | undefined,
    preflight: boolean,
  ): SerializedReply {
    addMissingHeaders(reply.headers, event.responseHeaders)
    applyCookies(reply, ctx)
    this.#frameworkHeaders(reply.headers, requestId, cors, preflight)
    const checked = this.#checkHeaders(reply, ctx, event)
    if (checked !== reply) {
      applyCookies(checked, ctx)
      this.#frameworkHeaders(checked.headers, requestId, cors, preflight)
    }
    return checked
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
    const settings = this.#options.cookies ?? DEFAULT_COOKIE_SETTINGS
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
   * of an allowed origin (`vary: origin` whatever the origin), the security headers; and
   * `connection: close` while draining.
   */
  #frameworkHeaders(
    headers: Record<string, HeaderValue>,
    requestId: RequestId,
    cors: CorsDecision | undefined,
    preflight: boolean,
  ): void {
    const header = this.#options.requestIdHeader
    if (header !== undefined && headers[header] === undefined && isHeaderValue(requestId)) headers[header] = requestId
    const policy = this.#options.cors
    if (policy !== undefined) {
      // a preflight answer carries its own CORS headers; other replies get them for allowed origins
      if (cors?.allowed === true && !preflight) addMissingHeaders(headers, corsReplyHeaders(policy, cors.origin))
      if (policy.varyOrigin) mergeVary(headers, 'origin')
    }
    const security = this.#options.securityHeaders
    if (security !== undefined) addMissingHeaders(headers, security)
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

  async #process(
    ctx: RequestContext,
    target: Target,
    event: HttpRequestEvent,
    cors: CorsDecision | undefined,
  ): Promise<Outcome> {
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
        default:
          return await this.#invoke(ctx, target.plan, event)
      }
    } catch (error) {
      event.error = error
      const reply = await this.#errorReply(error, ctx)
      event.status = reply.status
      return reply
    }
  }

  async #invoke(ctx: RequestContext, plan: RoutePlan, event: HttpRequestEvent): Promise<Outcome> {
    const controller = this.#resolve(plan.controller)
    for (const guard of plan.guards) {
      const allowed = await this.#resolve(guard).canActivate(ctx)
      if (allowed !== true) throw new ForbiddenException('Forbidden resource')
    }
    if (plan.parseBody) await ctx.parseBody()
    const definition = plan.definition
    const interceptors = plan.interceptors
    let result: unknown
    if (interceptors.length === 0) {
      result = await definition.invoke(controller, ctx)
    } else {
      const chain = async (index: number): Promise<unknown> => {
        if (index === interceptors.length) return await definition.invoke(controller, ctx)
        const interceptor = this.#resolve(interceptors[index] as Resolvable<HttpInterceptor>)
        return await interceptor.intercept(ctx, () => chain(index + 1))
      }
      result = await chain(0)
    }
    if (definition.rawResponse === true && !(result instanceof Response)) return RAW
    const options: SerializeOptions = {
      method: ctx.method,
      routeMethod: definition.method,
      status: definition.status,
      headers: definition.headers,
      context: ctx.hasResponseHeaders ? ctx.responseHeaders : undefined,
    }
    const sse = definition.sse
    let reply: SerializedReply
    if (sse !== undefined && !(result instanceof Response) && !isHttpResponse(result)) {
      // an @Sse route: the (awaited) result is the event source
      if (!isSseSource(result)) {
        throw new TypeError(
          `@Sse handler ${displayName(plan.info.controller)}.${definition.handler} must return an AsyncIterable, an Iterable or a ReadableStream of SseEvent (received ${describeResult(result)})`,
        )
      }
      reply = serializeSseReply(this.#openStream(result, sseOptions(sse), ctx), undefined, options)
    } else {
      reply = await this.#serialize(result, ctx, options, sse)
    }
    return this.#finish(event, reply)
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

  #emit(event: HttpRequestEvent): void {
    if (this.#hooks.hasListeners('http:request')) this.#hooks.emit('http:request', event)
  }

  #enter(): void {
    this.#inflight++
  }

  /** Leaves once the request is over (immediately when it failed before being served). */
  #leaveWhen(served: Served | undefined): void {
    if (served === undefined) this.#leave()
    else void served.done.then(() => this.#leave())
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

/** The reply handed to the adapter (internal fields of the serialised reply left out). */
function adapterReply(serialized: SerializedReply, body: ReplyBody, blob?: Blob): AdapterReply {
  const reply: AdapterReply = { status: serialized.status, headers: serialized.headers, body }
  if (blob !== undefined) return { ...reply, blob }
  return serialized.sse === undefined ? reply : { ...reply, eventStream: true }
}

/**
 * Appends the cookies to `set-cookie`, after the raw values (`@Header`, `ctx.setHeader()`, the
 * `HttpResponse` headers, a Web `Response`): the cookies of the context (`ctx.setCookie()`), then
 * those of the `HttpResponse`, a cookie of the same key (name, domain, path) replacing the earlier
 * one in place. One line per cookie.
 */
function applyCookies(reply: CheckedReply, ctx: RequestContext): void {
  const own = reply.cookieLines ?? []
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
