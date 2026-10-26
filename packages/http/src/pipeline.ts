import type { Container, CoreLogger, Hooks, HttpRequestEvent, Token } from '@znight/core'
import type { AdapterReply, AdapterRequest } from './adapter.ts'
import type { CanActivate, ExceptionMapper, HttpInterceptor } from './interfaces.ts'
import type { HttpRouteDefinition } from './metadata.ts'
import type { RouteTable } from './router.ts'
import type { BodyPlan } from './uploads.ts'

import { displayName } from '@znight/core'

import { type HttpRouteInfo, RequestContext, type RequestId } from './context.ts'
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
} from './serialize.ts'
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
}

type Target =
  | { readonly kind: 'route'; readonly plan: RoutePlan }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'options'; readonly allow: string }
  | { readonly kind: 'redirect'; readonly location: string }

const RAW = Symbol('raw response')
type Outcome = SerializedReply | typeof RAW

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
      served = await this.#route(plan, request, startTime)
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

  async #serve(
    request: AdapterRequest,
    route: HttpRouteInfo | undefined,
    params: Record<string, string>,
    target: Target,
    startTime: number,
    body: BodyPlan,
  ): Promise<Served> {
    const requestId = this.#requestId(request)
    const ctx = new RequestContext(request, {
      requestId,
      adapter: this.#options.adapter,
      route,
      params,
      body,
    })
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
        try {
          await this.#hooks.run('http:request', event, async () => {
            outcome = await this.#process(ctx, target, event)
            if (outcome !== RAW) outcome = this.#checkHeaders(outcome, ctx, event)
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
          replied()
          return
        }
        const serialized = this.#complete(outcome, ctx, event, requestId)
        const body = serialized.body
        if (!(body instanceof ReadableStream || body instanceof Blob)) {
          reply = serialized
          replied()
          ctx.releaseBody()
          return
        }
        // files too: a file-backed Blob is read lazily, after the handler returned
        const tracked = trackStream(body, run ?? captureContext())
        reply =
          body instanceof Blob
            ? { ...serialized, body: tracked.stream, blob: body }
            : { ...serialized, body: tracked.stream }
        replied()
        const failure = await tracked.done
        if (failure !== undefined) {
          this.#logger.error('The response stream failed', { err: failure, requestId, path: ctx.path })
        }
        ctx.releaseBody()
      }, [
        [HttpTokens.Context, ctx],
        [HttpTokens.RequestId, requestId],
      ])
      .then(
        () => undefined,
        (error: unknown) => {
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
      reply = this.#complete(serializeError(500, this.#internalBody(failure), ctx.method), ctx, event, requestId)
      event.status = 500
    }
    this.#emit(event)
    return { reply, done }
  }

  /**
   * Adds the headers of the `http:request` wrappers, the request id and `connection: close` while
   * draining, then checks the final headers (see {@link #checkHeaders}).
   */
  #complete(
    reply: SerializedReply,
    ctx: RequestContext,
    event: HttpRequestEvent,
    requestId: RequestId,
  ): SerializedReply {
    const headers = reply.headers
    addMissingHeaders(headers, event.responseHeaders)
    const header = this.#options.requestIdHeader
    if (header !== undefined && headers[header] === undefined && isHeaderValue(requestId)) headers[header] = requestId
    if (this.draining) headers['connection'] = 'close'
    const checked = this.#checkHeaders(reply, ctx, event)
    if (checked !== reply) {
      if (header !== undefined && isHeaderValue(requestId)) checked.headers[header] = requestId
      if (this.draining) checked.headers['connection'] = 'close'
    }
    return checked
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

  async #process(ctx: RequestContext, target: Target, event: HttpRequestEvent): Promise<Outcome> {
    try {
      switch (target.kind) {
        case 'error':
          throw target.error
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
    const reply = await serialize(result, ctx, {
      method: ctx.method,
      routeMethod: definition.method,
      status: definition.status,
      headers: definition.headers,
      context: ctx.hasResponseHeaders ? ctx.responseHeaders : undefined,
    })
    return this.#finish(event, reply)
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
          })
        }
        if (mapped instanceof Response || isHttpResponse(mapped)) {
          return await serialize(mapped, ctx, {
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

/** Serialises a handler (or exception mapper) result; file bodies are resolved for the request. */
async function serialize(result: unknown, ctx: RequestContext, options: SerializeOptions): Promise<SerializedReply> {
  if (isHttpResponse(result) && isFileBody(result.body)) {
    return serializeFileReply(await resolveFile(result.body, ctx), result, options)
  }
  return serializeResult(result, options)
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
