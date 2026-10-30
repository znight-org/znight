import type { Container, Plugin, PluginContext, PluginOptions, ProviderKey, Token, ZnightMetadata } from '@znight/core'
import type {
  AdapterReply,
  HttpAdapter,
  HttpServerAddress,
  InjectRequest,
  InjectResponse,
  InjectStreamOptions,
  InjectStreamResponse,
} from './adapter.ts'
import type { HttpContext } from './context.ts'
import type { CookieSettings } from './cookie-settings.ts'
import type { CookieDefaults } from './cookies.ts'
import type { CorsOptions, CorsPolicy } from './cors.ts'
import type { InjectSseResponse } from './inject-sse.ts'
import type {
  CanActivate,
  ExceptionMapper,
  ExceptionMapperClass,
  GuardClass,
  HttpInterceptor,
  HttpInterceptorClass,
} from './interfaces.ts'
import type { HttpControllerDefinition, HttpMetadata, HttpMethod, HttpRouteDefinition } from './metadata.ts'
import type { CollectedPluginRoute } from './plugin-routes.ts'
import type { TrustPolicy, TrustProxy } from './proxy.ts'
import type { SecurityHeadersOptions } from './security-headers.ts'
import type { ByteSize } from './size.ts'

import { displayName, ErrorCode, resolveOptions, ZnightError } from '@znight/core'

import { nodeAdapter } from './adapters/node.ts'
import { DEFAULT_COOKIE_SETTINGS, missingSecrets, signValue } from './cookie-settings.ts'
import { type CookieSecret, CookieSigner, checkSecrets } from './cookie-signer.ts'
import { DEFAULT_COOKIE_OPTIONS, decodeCookieValue, isCookieName, serializeResponseCookie } from './cookies.ts'
import { resolveCors } from './cors.ts'
import {
  type CheckedRoute,
  checkDecisions,
  conflictingKeys,
  type EnforcementMode,
  effectiveMeta,
  enforcedBy,
  RouteGroups,
  type RouteMeta,
} from './decisions.ts'
import { isHeaderName } from './headers.ts'
import { openInjectSse } from './inject-sse.ts'
import { isMediaTypePattern } from './mime.ts'
import { invalidOption } from './option-error.ts'
import { compareRoutePaths, compareStrings, joinPaths, parseRoutePath, type RoutePath, RoutePathError } from './path.ts'
import {
  DEFAULT_SSE_SETTINGS,
  Pipeline,
  type Resolvable,
  type RoutePlan,
  randomRequestId,
  type SseSettings,
} from './pipeline.ts'
import { collectPluginRoutes } from './plugin-routes.ts'
import { resolveTrustProxy } from './proxy.ts'
import { RouteTable } from './router.ts'
import { resolveSecurityHeaders } from './security-headers.ts'
import { parseByteSize } from './size.ts'
import { MAX_SSE_TIMER_MS, MIN_SSE_INTERVAL_MS } from './sse.ts'
import { isValidStatus } from './status.ts'
import { HttpTokens } from './tokens.ts'
import { bodyPlan, DEFAULT_UPLOAD_LIMITS, type ResolvedUploadLimits, type UploadLimits } from './uploads.ts'

/** How requests whose path ends with an extra `/` are handled. */
export type TrailingSlashPolicy = 'strict' | 'ignore' | 'redirect'

/** A global guard: a provider class (resolved with the container) or an instance. */
export type GuardRef = GuardClass | CanActivate
/** A global interceptor: a provider class or an instance. */
export type InterceptorRef = HttpInterceptorClass | HttpInterceptor
/** An exception mapper: a provider class or an instance. */
export type ExceptionMapperRef = ExceptionMapperClass | ExceptionMapper

/** Options of {@link HttpPlugin.configure}. */
export interface HttpPluginOptions {
  /** Server implementation. Default: `nodeAdapter()` (built-in, `node:http`). */
  readonly adapter?: HttpAdapter
  /** Port to listen on (`0` picks a free port). Default: `3000`. */
  readonly port?: number
  /** Interface to bind. Default: `0.0.0.0`. */
  readonly host?: string
  /** Path prefix of every route (`/api`). Default: none. */
  readonly prefix?: string
  /** Guards run before the controller and route guards of every route. */
  readonly guards?: readonly GuardRef[]
  /** Interceptors wrapping every route (outermost first). */
  readonly interceptors?: readonly InterceptorRef[]
  /** Error-to-response mappers, tried in order (see `ExceptionMapper`). */
  readonly exceptionMappers?: readonly ExceptionMapperRef[]
  /**
   * `strict` (default): `/users/` does not match `/users`. `ignore`: it does. `redirect`: it is
   * redirected (308) to `/users`.
   */
  readonly trailingSlash?: TrailingSlashPolicy
  /** Send the message of unexpected errors in 500 responses (development only). Default: `false`. */
  readonly exposeErrors?: boolean
  /**
   * Maximum request body size (413 above): bytes or a size with a unit (`'10mb'`; `kb` = 1024
   * bytes), `Infinity` for no limit. Routes override it with `@BodyLimit`; upload routes default to
   * the sum of their file limits plus this value. Default: 1 MiB.
   */
  readonly bodyLimit?: ByteSize
  /** Limits of multipart bodies and defaults of the upload parameters (see `UploadLimits`). */
  readonly uploads?: UploadLimits
  /**
   * Header carrying the request id: reused when the client sends a valid one (≤ 128 characters of
   * `[A-Za-z0-9_-.:@/+=]`), echoed on every response. `false`: always generate, never echo.
   * Default: `x-request-id`.
   */
  readonly requestIdHeader?: string | false
  /** Request id generator. Default: `crypto.randomUUID()`. */
  readonly generateRequestId?: () => string
  /**
   * Maximum time `onStop` waits for in-flight requests before closing the remaining connections.
   * Keep it below the application `shutdown.hookTimeoutMs`. `Infinity`: no limit of its own (the
   * application's `hookTimeoutMs` still bounds `onStop`). Default: 4 000 ms.
   */
  readonly drainTimeoutMs?: number
  /**
   * CORS: preflights are answered before routing and guards (never by a route), and replies to
   * allowed origins get `access-control-allow-origin`, identically on every adapter. Default: off.
   *
   * ```ts
   * cors: { origin: ['https://app.example.com', /^https:\/\/[a-z0-9-]+\.preview\.example\.com$/], credentials: true }
   * ```
   */
  readonly cors?: CorsOptions | false
  /**
   * Security headers added to every reply that does not set them (`@Res()` raw replies excepted):
   * `true` (default) for the API defaults, an object merged over them, `false` for none.
   */
  readonly securityHeaders?: boolean | SecurityHeadersOptions
  /**
   * Proxies trusted for `x-forwarded-for` / `x-forwarded-proto` (`ctx.ip`, `ctx.protocol`): a number
   * of hops, or addresses, CIDR ranges and the aliases `'loopback'`, `'private'`, `'linklocal'`.
   * Default `false`: the headers are ignored and `ctx.ip` is the adapter's address.
   */
  readonly trustProxy?: TrustProxy
  /**
   * What the boot check of route decisions does when a route misses a decision of a required group,
   * or when no guard of its chain enforces its decision (ZNIGHT023): `'error'` (default) fails the
   * boot, `'warn'` logs one warning per group (tests that deliberately run without guards).
   */
  readonly enforcement?: EnforcementMode
  /** Cookies: signing keys and defaults (see {@link HttpCookieOptions}). */
  readonly cookies?: HttpCookieOptions
  /** Server-Sent Events defaults (see {@link HttpSseOptions}). */
  readonly sse?: HttpSseOptions
}

/** The plugin option `cookies`. */
export interface HttpCookieOptions {
  /**
   * HMAC keys of signed cookies (`@SignedCookie`, `{ signed: true }`), at least 32 bytes each: the
   * first signs, all verify (rotation: deploy `[next, current]`, wait for the longest cookie
   * lifetime, then `[next]`). Default: none (signed cookies unavailable).
   */
  readonly secrets?: string | Uint8Array | readonly (string | Uint8Array)[]
  /**
   * Defaults of every cookie set by the application, merged over the secure defaults
   * `{ path: '/', secure: true, httpOnly: true, sameSite: 'lax' }` (e.g. `{ secure: false }` for
   * plain `http://` development setups on a non-localhost host).
   */
  readonly defaults?: CookieDefaults
}

/** The plugin option `sse`. */
export interface HttpSseOptions {
  /** Default heartbeat (ms, an integer ≥ 1 000, or `false`). Default: 8 000. */
  readonly heartbeat?: number | false
  /** Default `retry` sent first (ms). Default: none. */
  readonly retry?: number
  /**
   * Time an event source gets to finish after `ctx.signal` aborted on shutdown or `maxDuration` (ms),
   * before the stream ends with a jittered `retry`. Must be lower than `drainTimeoutMs`. Default:
   * 1 000.
   */
  readonly shutdownGraceMs?: number
}

/** A route registered by the plugin (see {@link HttpPlugin.routes}). */
export interface HttpRouteSummary {
  readonly method: string
  /** Registered path, prefix included. */
  readonly path: string
  /** Controller display name, or the name of the plugin declaring the route. */
  readonly controller: string
  readonly handler: string
  /** `'controller'` for compiled routes, the plugin name for plugin routes. */
  readonly source: string
  /** Effective route metadata (the nearest decision of each group). */
  readonly meta: Readonly<Record<string, unknown>>
  /** Display names of the guards, in chain order (global, controller, route). */
  readonly guards: readonly string[]
}

interface Resolved {
  readonly adapter: HttpAdapter
  readonly port: number
  readonly host: string
  readonly prefix: string
  readonly trailingSlash: TrailingSlashPolicy
  readonly exposeErrors: boolean
  readonly bodyLimit: number
  readonly uploads: ResolvedUploadLimits
  readonly requestIdHeader: string | undefined
  readonly generateRequestId: () => string
  readonly drainTimeoutMs: number
  readonly cors: CorsPolicy | undefined
  readonly securityHeaders: Readonly<Record<string, string>>
  readonly trustProxy: TrustPolicy | undefined
  readonly enforcement: EnforcementMode
  readonly cookies: CookieSettings
  readonly sse: SseSettings
}

/** Resolved options and the raw options they come from (memoised per application). */
interface ResolvedOptions {
  readonly raw: HttpPluginOptions
  readonly options: Resolved
}

interface Runtime {
  readonly adapter: HttpAdapter
  readonly pipeline: Pipeline
  readonly options: Resolved
  readonly routes: readonly HttpRouteSummary[]
}

interface Registration {
  readonly method: Exclude<HttpMethod, 'ALL'>
  readonly path: RoutePath
  readonly plan: RoutePlan
  /** `BookController.list`, `plugin "openapi" (document)`. */
  readonly label: string
  readonly source: string
  readonly guards: readonly string[]
}

/** A guard of a chain: how to resolve it, the class whose `enforces` counts, its display name. */
interface GuardEntry {
  readonly resolvable: Resolvable<CanActivate>
  readonly cls: unknown
  readonly name: string
}

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_BODY_LIMIT = 1_048_576
const DEFAULT_DRAIN_TIMEOUT_MS = 4_000
const DEFAULT_REQUEST_ID_HEADER = 'x-request-id'
/** Longest `setTimeout` delay (larger ones overflow to 1 ms). */
const MAX_TIMER_MS = 2_147_483_647
/** Adapters bound to a plugin (an adapter instance serves one application). */
const BOUND_ADAPTERS = new WeakSet<HttpAdapter>()
const CONCRETE_METHODS: readonly Exclude<HttpMethod, 'ALL'>[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]

/**
 * The HTTP plugin: serves the controllers compiled into `metadata.extensions.http` with the chosen
 * adapter.
 *
 * ```ts
 * const app = await Application.create({
 *   metadata: __ZNIGHT_METADATA__,
 *   plugins: [HttpPlugin.configure({ port: 3000, prefix: '/api' })],
 * })
 * await app.start()
 * ```
 *
 * Lifecycle: `register` declares the request-scoped externals `HttpContext` and `RequestId`;
 * `onBootstrap` resolves the options, controllers, guards and interceptors, collects the routes of
 * other plugins (`httpRoutes()`), checks route decisions and registers the routes; `onStart`
 * listens; `onStop` stops accepting connections and drains in-flight requests (`drainTimeoutMs`);
 * `onDispose` closes the server.
 */
export class HttpPlugin implements Plugin {
  readonly name = 'http'
  readonly #options: PluginOptions<HttpPluginOptions>
  /** Options resolved for the current application (reset in `register`). */
  #resolved: ResolvedOptions | undefined
  #container: Container | undefined
  #runtime: Runtime | undefined
  #address: HttpServerAddress | undefined
  #disposed = false
  /** Registered in an application that was not disposed yet. */
  #active = false

  private constructor(options: PluginOptions<HttpPluginOptions>) {
    this.#options = options
  }

  /**
   * Creates the plugin. `options` may be a function of the container, evaluated in `onBootstrap`:
   * `HttpPlugin.configure(c => ({ port: c.get(AppConfig).port }))`.
   */
  static configure(options: PluginOptions<HttpPluginOptions> = {}): HttpPlugin {
    return new HttpPlugin(options)
  }

  /** The adapter (available after `onBootstrap`). */
  get adapter(): HttpAdapter {
    return this.#require('adapter').adapter
  }

  /** Address of the server once listening (`String(address)` is its URL), `undefined` otherwise. */
  get address(): HttpServerAddress | undefined {
    return this.#address
  }

  /**
   * The path prefix of every route (`''` without prefix, `/api`), for plugins that serve routes or
   * publish URLs. Readable once the plugin is registered (before or after its `onBootstrap`; at any
   * time when the options are not a function of the container). Throws the options error when
   * the options are invalid.
   */
  get prefix(): string {
    const prefix = this.#resolve('prefix').options.prefix
    return prefix === '/' ? '' : prefix
  }

  /** Registered routes (after `onBootstrap`), in registration order. */
  get routes(): readonly HttpRouteSummary[] {
    return this.#runtime?.routes ?? []
  }

  /** Number of requests being processed. */
  get inflight(): number {
    return this.#runtime?.pipeline.inflight ?? 0
  }

  /** Number of open event streams (`@Sse`, `HttpResponse.sse()`): health checks, gauges, stream caps. */
  get streams(): number {
    return this.#runtime?.pipeline.streams ?? 0
  }

  /**
   * The signed wire value of a cookie (`<encoded value>.<signature>`, signed with the first secret of
   * `cookies.secrets`): what a browser would send back after `setCookie(name, value, { signed: true })`.
   * For gateways minting cookies and for tests. Available after `onBootstrap`.
   *
   * @throws TypeError for an invalid name or value; Error without `cookies.secrets`.
   */
  signCookie(name: string, value: string): string {
    const signer = this.#require('signCookie()').options.cookies.signer
    if (!isCookieName(name)) throw new TypeError(`Invalid cookie name ${JSON.stringify(String(name))}`)
    if (typeof value !== 'string') throw new TypeError(`The value of the cookie "${name}" must be a string`)
    if (signer === undefined) throw missingSecrets(`Cannot sign the cookie "${name}"`)
    return signValue(signer, name, value)
  }

  /**
   * The provider classes the plugin resolves in `onBootstrap` although no compiled metadata
   * references them: the classes of the `guards`, `interceptors` and `exceptionMappers` options
   * (instances are left out), in that order, without duplicates. `TestApp` from `@znight/testing`
   * creates them at boot with their dependencies (an async dependency cannot be created on demand);
   * pass them to `init: { only }` when restricting the boot with `Application.create()`.
   *
   * Options given as a function of the container cannot be read before the bootstrap: the result is
   * then empty. Never throws: invalid options are reported by `onBootstrap`.
   */
  initRoots(): readonly ProviderKey[] {
    const options: unknown = this.#options
    if (options === null || typeof options !== 'object') return []
    const roots = new Set<ProviderKey>()
    for (const key of GLOBAL_KEYS) {
      try {
        const refs: unknown = (options as HttpPluginOptions)[key]
        if (!Array.isArray(refs)) continue
        for (const ref of refs) {
          if (typeof ref === 'function') roots.add(ref as GuardClass)
        }
      } catch {
        // a throwing getter: reported when onBootstrap reads the option
      }
    }
    return [...roots]
  }

  /**
   * Sends a request in memory through the adapter and the whole pipeline (no socket; the server
   * does not need to listen). Available after `onBootstrap`.
   *
   * ```ts
   * const res = await http.inject({ method: 'POST', url: '/users', body: { name: 'Ada' } })
   * expect(res.status).toBe(201)
   * expect(res.json()).toEqual({ id: 1, name: 'Ada' })
   * ```
   */
  inject(request: InjectRequest): Promise<InjectResponse> {
    try {
      const runtime = this.#require('inject()')
      return runtime.adapter.inject(withSignedCookies(request, runtime.options.cookies, 'inject()'))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Sends a request in memory and resolves at the response headers, the body being read as it is
   * produced (`body`). Cancelling `body` (or aborting `signal`) disconnects the client. Requires an
   * adapter implementing `injectStream()` (the four built-in ones do).
   */
  injectStream(request: InjectStreamOptions): Promise<InjectStreamResponse> {
    try {
      if (request === null || typeof request !== 'object')
        throw new TypeError('injectStream() expects a request object')
      const runtime = this.#require('injectStream()')
      const adapter = runtime.adapter
      if (typeof adapter.injectStream !== 'function') {
        throw new ZnightError(
          ErrorCode.LifecycleFailed,
          `HttpPlugin: the ${adapter.name} adapter does not implement injectStream()`,
          { hints: ['Use a built-in adapter (node, fastify, express, hono) or implement HttpAdapter.injectStream()'] },
        )
      }
      const sent = { ...request, method: request.method ?? 'GET' }
      return adapter.injectStream(withSignedCookies(sent, runtime.options.cookies, 'injectStream()'))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Opens an event stream in memory (`accept: text/event-stream`) and reads its events like
   * `EventSource`: `next()`, `take()`, `comments`, `retry`, `lastEventId`, `reconnect()`, `close()`
   * (the server sees a client disconnect). A response that is not an event stream (404, 204...) is
   * read to its end (`body`). Resolves at the first chunk of the stream (an `@Sse` stream sends
   * `retry` or a comment at once), or after 2 000 ms for a stream that sends nothing yet; rejects,
   * naming the request (which is aborted), when no response headers arrive within 2 000 ms.
   *
   * ```ts
   * await using stream = await http.injectSse({ url: '/orders/o-1/events' })
   * const event = await stream.next() // rejects after 2 000 ms
   * expect(event.json()).toMatchObject({ status: 'paid' })
   * ```
   */
  injectSse(request: InjectStreamOptions): Promise<InjectSseResponse> {
    return openInjectSse(stream => this.injectStream(stream), request)
  }

  register(ctx: PluginContext): void {
    if (this.#active) {
      throw new ZnightError(ErrorCode.DuplicateProvider, 'This HttpPlugin is already used by another application', {
        hints: ['Call HttpPlugin.configure() once per application'],
      })
    }
    // an instance may serve several applications one after the other (shared test setups)
    this.#active = true
    this.#disposed = false
    this.#runtime = undefined
    this.#address = undefined
    this.#resolved = undefined
    this.#container = ctx.container
    ctx.container.registerExternal({ token: HttpTokens.Context, scope: 'request', providedBy: 'HttpPlugin' })
    ctx.container.registerExternal({ token: HttpTokens.RequestId, scope: 'request', providedBy: 'HttpPlugin' })
    ctx.container.registerValue(HttpTokens.Plugin, this)
  }

  onBootstrap(ctx: PluginContext): void {
    this.#container = ctx.container
    const { raw, options } = this.#resolve('onBootstrap')
    if (BOUND_ADAPTERS.has(options.adapter)) {
      throw new ZnightError(
        ErrorCode.LifecycleFailed,
        `HttpPlugin: this ${options.adapter.name} adapter instance already served an application`,
        {
          hints: [
            'An adapter instance serves one application: create it per application, e.g. HttpPlugin.configure(() => ({ adapter: fastifyAdapter() }))',
          ],
        },
      )
    }
    BOUND_ADAPTERS.add(options.adapter)
    const table = new RouteTable<RoutePlan>()
    const pipeline = new Pipeline(
      ctx.container,
      ctx.hooks,
      ctx.logger,
      {
        adapter: options.adapter.name,
        body: bodyPlan({}, options.bodyLimit, options.uploads),
        exposeErrors: options.exposeErrors,
        requestIdHeader: options.requestIdHeader,
        generateRequestId: options.generateRequestId,
        mappers: globalRefs<ExceptionMapper>(ctx.container, ctx.metadata, raw, 'exceptionMappers'),
        cors: options.cors,
        securityHeaders: options.securityHeaders,
        trustProxy: options.trustProxy,
        cookies: options.cookies,
        sse: options.sse,
      },
      table,
    )
    const pluginRoutes = collectPluginRoutes(ctx.app.plugins, this, {
      prefix: options.prefix === '/' ? '' : options.prefix,
      container: ctx.container,
    })
    const { registrations, checked } = buildRegistrations(ctx, options, raw, pluginRoutes)
    checkDecisions(checked.routes, checked.groups, options.enforcement, ctx.logger, checked.enforcers)
    const adapter = options.adapter
    const routes: HttpRouteSummary[] = []
    for (const registration of registrations) {
      table.add(registration.method, registration.path, registration.plan)
      const plan = registration.plan
      adapter.registerRoute({
        method: registration.method,
        path: registration.path,
        handler: (request): Promise<AdapterReply> => pipeline.handle(plan, request),
      })
      routes.push(
        Object.freeze({
          method: registration.method,
          path: registration.path.path,
          controller: registration.source === 'controller' ? displayName(plan.info.controller) : registration.source,
          handler: plan.info.handler,
          source: registration.source,
          meta: plan.info.meta,
          guards: registration.guards,
        }),
      )
    }
    adapter.setFallbackHandler((request, error) => pipeline.fallback(request, error))
    this.#runtime = { adapter, pipeline, options, routes: Object.freeze(routes) }
  }

  async onStart(ctx: PluginContext): Promise<void> {
    const runtime = this.#require('onStart')
    runtime.pipeline.draining = false
    this.#address = await runtime.adapter.listen(runtime.options.port, runtime.options.host)
    ctx.logger.info(`HTTP server listening on ${this.#address.url}`, {
      adapter: runtime.adapter.name,
      routes: runtime.routes.length,
    })
  }

  async onStop(ctx: PluginContext): Promise<void> {
    const runtime = this.#runtime
    if (runtime === undefined) return
    runtime.pipeline.draining = true
    // event streams never end by themselves: let their sources finish, then send them a jittered retry
    runtime.pipeline.closeStreams('shutdown')
    const timeoutMs = runtime.options.drainTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    // no timer for Infinity; larger delays than setTimeout supports are clamped (they would fire at once)
    const timeout = new Promise<'timeout'>(resolve => {
      if (timeoutMs !== Number.POSITIVE_INFINITY) {
        timer = setTimeout(() => resolve('timeout'), Math.min(timeoutMs, MAX_TIMER_MS))
      }
    })
    try {
      const drained = Promise.all([runtime.adapter.close(), runtime.pipeline.whenIdle()]).then(() => 'drained' as const)
      if ((await Promise.race([drained, timeout])) === 'timeout') {
        ctx.logger.warn(`HTTP server: closing ${runtime.pipeline.inflight} in-flight request(s) after ${timeoutMs} ms`)
        await runtime.adapter.close({ force: true })
      }
    } finally {
      clearTimeout(timer)
      this.#address = undefined
    }
  }

  async onDispose(): Promise<void> {
    this.#active = false
    if (this.#disposed) return
    this.#disposed = true
    const runtime = this.#runtime
    this.#address = undefined
    if (runtime !== undefined) await runtime.adapter.close({ force: true })
  }

  /** Resolves the options once per application (`prefix` may need them before `onBootstrap`). */
  #resolve(action: string): ResolvedOptions {
    if (this.#resolved !== undefined) return this.#resolved
    let raw: HttpPluginOptions
    if (typeof this.#options === 'function') {
      const container = this.#container
      if (container === undefined) {
        throw new ZnightError(
          ErrorCode.LifecycleFailed,
          `HttpPlugin: ${action} is only available once the plugin is registered in an application (its options are a function of the container)`,
        )
      }
      raw = resolveOptions(this.#options, container)
    } else {
      raw = this.#options
    }
    const resolved: ResolvedOptions = { raw, options: resolve(raw) }
    this.#resolved = resolved
    return resolved
  }

  #require(action: string): Runtime {
    if (this.#disposed) {
      throw new ZnightError(ErrorCode.LifecycleFailed, `HttpPlugin: cannot use ${action} after the application stopped`)
    }
    if (this.#runtime === undefined) {
      throw new ZnightError(
        ErrorCode.LifecycleFailed,
        `HttpPlugin: ${action} is only available once the application is created (after onBootstrap)`,
      )
    }
    return this.#runtime
  }
}

// -------------------------------------------------------------------------------------------------
// Options
// -------------------------------------------------------------------------------------------------

function resolve(options: HttpPluginOptions): Resolved {
  if (options === null || typeof options !== 'object') throw invalidOption('options', 'an object', options)
  const port = options.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw invalidOption('port', 'an integer between 0 and 65535', port)
  const host = options.host ?? DEFAULT_HOST
  if (typeof host !== 'string' || host === '') throw invalidOption('host', 'a non-empty string', host)
  const prefix = options.prefix ?? ''
  if (typeof prefix !== 'string') throw invalidOption('prefix', 'a string', prefix)
  let parsedPrefix: RoutePath
  try {
    parsedPrefix = parseRoutePath(prefix)
  } catch (error) {
    throw invalidOption('prefix', 'a valid static path', prefix, error)
  }
  if (parsedPrefix.segments.some(segment => segment.kind !== 'static')) {
    throw invalidOption('prefix', 'a static path (no :param or *)', prefix)
  }
  const trailingSlash = options.trailingSlash ?? 'strict'
  if (trailingSlash !== 'strict' && trailingSlash !== 'ignore' && trailingSlash !== 'redirect') {
    throw invalidOption('trailingSlash', '"strict", "ignore" or "redirect"', trailingSlash)
  }
  const bodyLimit = parseByteSize(options.bodyLimit ?? DEFAULT_BODY_LIMIT)
  if (bodyLimit === undefined) {
    throw invalidOption('bodyLimit', "a size in bytes (1048576, '10mb', Infinity)", options.bodyLimit)
  }
  const uploads = resolveUploadLimits(options.uploads)
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  if (typeof drainTimeoutMs !== 'number' || !(drainTimeoutMs >= 0)) {
    throw invalidOption('drainTimeoutMs', 'a positive number (or Infinity)', drainTimeoutMs)
  }
  const requestIdHeader = options.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER
  if (requestIdHeader !== false && (typeof requestIdHeader !== 'string' || !isHeaderName(requestIdHeader))) {
    throw invalidOption('requestIdHeader', 'a header name or false', requestIdHeader)
  }
  const generateRequestId = options.generateRequestId ?? randomRequestId
  if (typeof generateRequestId !== 'function') throw invalidOption('generateRequestId', 'a function', generateRequestId)
  const adapter = options.adapter ?? nodeAdapter()
  if (
    adapter === null ||
    typeof adapter !== 'object' ||
    typeof adapter.registerRoute !== 'function' ||
    typeof adapter.listen !== 'function' ||
    typeof adapter.inject !== 'function'
  ) {
    throw invalidOption('adapter', 'an HttpAdapter (nodeAdapter(), fastifyAdapter()...)', adapter)
  }
  const enforcement = options.enforcement ?? 'error'
  if (enforcement !== 'error' && enforcement !== 'warn') {
    throw invalidOption('enforcement', '"error" or "warn"', enforcement)
  }
  const resolvedRequestIdHeader = requestIdHeader === false ? undefined : requestIdHeader.toLowerCase()
  const cookies = resolveCookies(options.cookies)
  const sse = resolveSse(options.sse, drainTimeoutMs)
  return {
    adapter,
    port,
    host,
    prefix: parsedPrefix.path,
    trailingSlash,
    exposeErrors: options.exposeErrors === true,
    bodyLimit,
    uploads,
    requestIdHeader: resolvedRequestIdHeader,
    generateRequestId,
    drainTimeoutMs,
    cors: resolveCors(options.cors, resolvedRequestIdHeader),
    securityHeaders: resolveSecurityHeaders(options.securityHeaders),
    trustProxy: resolveTrustProxy(options.trustProxy),
    enforcement,
    cookies,
    sse,
  }
}

const COOKIE_DEFAULT_KEYS = ['domain', 'path', 'secure', 'httpOnly', 'sameSite', 'partitioned', 'priority']

function resolveCookies(value: HttpCookieOptions | undefined): CookieSettings {
  if (value === undefined) return DEFAULT_COOKIE_SETTINGS
  if (value === null || typeof value !== 'object')
    throw invalidOption('cookies', 'an object { secrets?, defaults? }', value)
  for (const key of Object.keys(value)) {
    if (key !== 'secrets' && key !== 'defaults') {
      throw invalidOption('cookies', 'an object { secrets?, defaults? }', `unknown key "${key}"`)
    }
  }
  let signer: CookieSigner | undefined
  if (value.secrets !== undefined) {
    const checked = checkSecrets(value.secrets)
    // never echo a secret in an error
    if ('problem' in checked) {
      throw new ZnightError(
        ErrorCode.InvalidDecorator,
        `HttpPlugin: option "cookies.secrets" must be ${checked.problem}`,
        {
          hints: ["Generate secrets with crypto.randomBytes(32).toString('base64url') and load them with @Secret"],
        },
      )
    }
    signer = new CookieSigner(checked.secrets as readonly CookieSecret[])
  }
  const given = value.defaults
  if (given !== undefined && (given === null || typeof given !== 'object' || Array.isArray(given))) {
    throw invalidOption('cookies.defaults', `an object { ${COOKIE_DEFAULT_KEYS.join('?, ')}? }`, given)
  }
  const defaults: CookieDefaults = { ...DEFAULT_COOKIE_OPTIONS }
  for (const [key, option] of Object.entries(given ?? {})) {
    if (!COOKIE_DEFAULT_KEYS.includes(key)) {
      throw invalidOption(
        'cookies.defaults',
        `an object { ${COOKIE_DEFAULT_KEYS.join('?, ')}? }`,
        `unknown key "${key}"`,
      )
    }
    if (option !== undefined) (defaults as Record<string, unknown>)[key] = option
  }
  try {
    // a probe cookie checks every default and their combination (SameSite=None without Secure...)
    serializeResponseCookie({ name: 'probe', value: '', options: {} }, defaults)
  } catch (error) {
    throw invalidOption('cookies.defaults', 'valid cookie attributes', given, error, [
      error instanceof Error ? error.message.replace('Invalid cookie "probe": ', '') : String(error),
    ])
  }
  return Object.freeze({ defaults: Object.freeze(defaults), signer })
}

function resolveSse(value: HttpSseOptions | undefined, drainTimeoutMs: number): SseSettings {
  if (value === undefined) return DEFAULT_SSE_SETTINGS
  const shape = '{ heartbeat?, retry?, shutdownGraceMs? }'
  if (value === null || typeof value !== 'object') throw invalidOption('sse', `an object ${shape}`, value)
  for (const key of Object.keys(value)) {
    if (key !== 'heartbeat' && key !== 'retry' && key !== 'shutdownGraceMs') {
      throw invalidOption('sse', `an object ${shape}`, `unknown key "${key}"`)
    }
  }
  const heartbeat = value.heartbeat ?? DEFAULT_SSE_SETTINGS.heartbeat
  if (
    heartbeat !== false &&
    !(Number.isSafeInteger(heartbeat) && heartbeat >= MIN_SSE_INTERVAL_MS && heartbeat <= MAX_SSE_TIMER_MS)
  ) {
    throw invalidOption(
      'sse.heartbeat',
      `an integer number of ms from ${MIN_SSE_INTERVAL_MS} to ${MAX_SSE_TIMER_MS}, or false`,
      heartbeat,
    )
  }
  const retry = value.retry
  if (retry !== undefined && !(Number.isSafeInteger(retry) && retry >= 0)) {
    throw invalidOption('sse.retry', 'an integer number of ms ≥ 0', retry)
  }
  const shutdownGraceMs = value.shutdownGraceMs ?? DEFAULT_SSE_SETTINGS.shutdownGraceMs
  if (!(Number.isSafeInteger(shutdownGraceMs) && shutdownGraceMs >= 0 && shutdownGraceMs <= MAX_SSE_TIMER_MS)) {
    throw invalidOption('sse.shutdownGraceMs', `an integer number of ms from 0 to ${MAX_SSE_TIMER_MS}`, shutdownGraceMs)
  }
  if (drainTimeoutMs !== Number.POSITIVE_INFINITY && shutdownGraceMs >= drainTimeoutMs) {
    throw invalidOption(
      'sse.shutdownGraceMs',
      `lower than drainTimeoutMs (${drainTimeoutMs})`,
      shutdownGraceMs,
      undefined,
      [
        'Event streams get shutdownGraceMs to finish, within the drain of in-flight requests: shutdownGraceMs < drainTimeoutMs < shutdown.hookTimeoutMs',
      ],
    )
  }
  return Object.freeze({ heartbeat: heartbeat === false ? 0 : heartbeat, retry, shutdownGraceMs })
}

/**
 * The request with its `signedCookies` signed (first secret) and merged into `cookies`: adapters
 * never receive `signedCookies`.
 */
function withSignedCookies<R extends InjectRequest>(request: R, cookies: CookieSettings, action: string): R {
  if (request === null || typeof request !== 'object' || request.signedCookies === undefined) return request
  const signed = request.signedCookies
  if (signed === null || typeof signed !== 'object') throw new TypeError(`${action}: signedCookies must be an object`)
  const signer = cookies.signer
  if (signer === undefined) {
    throw new TypeError(
      `${action}: signedCookies require the HttpPlugin option cookies.secrets (HttpPlugin.configure({ cookies: { secrets: [...] } }))`,
    )
  }
  const merged: Record<string, string> = { ...request.cookies }
  for (const name of Object.keys(signed)) {
    const value = signed[name]
    if (!isCookieName(name)) throw new TypeError(`${action}: invalid signed cookie name ${JSON.stringify(name)}`)
    if (typeof value !== 'string')
      throw new TypeError(`${action}: the value of the signed cookie "${name}" must be a string`)
    // the decoded wire value: inject() encodes cookie values again (the encoding is canonical)
    merged[name] = decodeCookieValue(signValue(signer, name, value))
  }
  const { signedCookies: _signed, ...rest } = request
  return { ...rest, cookies: merged } as R
}

function resolveUploadLimits(value: UploadLimits | undefined): ResolvedUploadLimits {
  if (value === undefined) return DEFAULT_UPLOAD_LIMITS
  if (value === null || typeof value !== 'object') throw invalidOption('uploads', 'an object', value)
  const size = (key: 'maxFileSize' | 'maxFieldSize'): number => {
    const raw = value[key]
    if (raw === undefined) return DEFAULT_UPLOAD_LIMITS[key]
    const parsed = parseByteSize(raw)
    if (parsed === undefined) throw invalidOption(`uploads.${key}`, "a size in bytes (1048576, '10mb', Infinity)", raw)
    return parsed
  }
  const count = (key: 'maxFiles' | 'maxParts'): number => {
    const raw = value[key]
    if (raw === undefined) return DEFAULT_UPLOAD_LIMITS[key]
    if (raw !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(raw) || raw < 1)) {
      throw invalidOption(`uploads.${key}`, 'a positive integer (or Infinity)', raw)
    }
    return raw
  }
  for (const key of Object.keys(value)) {
    if (!['maxFileSize', 'maxFiles', 'maxParts', 'maxFieldSize'].includes(key)) {
      throw invalidOption('uploads', '{ maxFileSize?, maxFiles?, maxParts?, maxFieldSize? }', value)
    }
  }
  return {
    maxFileSize: size('maxFileSize'),
    maxFiles: count('maxFiles'),
    maxParts: count('maxParts'),
    maxFieldSize: size('maxFieldSize'),
  }
}

// -------------------------------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------------------------------

function httpMetadata(metadata: ZnightMetadata): HttpMetadata {
  const http = metadata.extensions?.http
  if (http === undefined) return { controllers: [] }
  if (http === null || typeof http !== 'object' || !Array.isArray(http.controllers)) {
    throw new ZnightError(ErrorCode.InvalidRoute, 'Invalid metadata.extensions.http: expected { controllers: [...] }')
  }
  return http
}

/** Routes as seen by the boot check of route decisions, with the groups they are checked against. */
interface Checked {
  readonly routes: readonly CheckedRoute[]
  readonly groups: RouteGroups
  /** Group → the guard classes enforcing it, in a chain or not. */
  readonly enforcers: ReadonlyMap<string, ReadonlySet<string>>
}

/** A declared route (controller route or plugin route), before HEAD, `@All` and trailing-slash expansion. */
interface Declared {
  readonly method: HttpMethod
  readonly path: RoutePath
  readonly plan: (method: string) => RoutePlan
  readonly label: string
  readonly source: string
  readonly guards: readonly GuardEntry[]
  /** Effective metadata (available once every group is known). */
  meta(): RouteMeta
}

function buildRegistrations(
  ctx: PluginContext,
  options: Resolved,
  raw: HttpPluginOptions,
  pluginRoutes: readonly CollectedPluginRoute[],
): { readonly registrations: Registration[]; readonly checked: Checked } {
  const { container, metadata } = ctx
  const http = httpMetadata(metadata)
  const groups = RouteGroups.fromMetadata(http.groups)
  const groupOf = (key: string): string => groups.groupOf(key)
  const resolvables = new Map<Token, Resolvable<unknown>>()
  const lookup = <T>(token: Token, what: string): Resolvable<T> => {
    let found = resolvables.get(token)
    if (found === undefined) {
      found = resolvable(container, metadata, token, what)
      resolvables.set(token, found)
    }
    return found as Resolvable<T>
  }
  const compiledGuard = (token: Token, what: string): GuardEntry => ({
    resolvable: lookup<CanActivate>(token, what),
    // the compiled class: a guard replaced through `overrides` in a test keeps its declaration
    cls: Object.hasOwn(metadata.providers, token) ? metadata.providers[token]?.class : undefined,
    name: displayName(token),
  })
  const globalGuards = guardEntries(container, metadata, raw.guards ?? [], ref =>
    invalidOption('guards', 'classes or objects with a canActivate() method', ref),
  )
  const globalInterceptors = globalRefs<HttpInterceptor>(container, metadata, raw, 'interceptors')
  const declared: Declared[] = []
  /** Checks run once every group is declared. */
  const pending: (() => void)[] = []

  for (const controller of http.controllers) {
    assertController(controller)
    const name = displayName(controller.token)
    const instance = lookup<object>(controller.token, `controller ${name}`)
    const controllerGuards = controller.guards.map(token => compiledGuard(token, `guard of ${name}`))
    const controllerInterceptors = controller.interceptors.map(token =>
      lookup<HttpInterceptor>(token, `interceptor of ${name}`),
    )
    const controllerMeta = assertMeta(controller.meta, name)
    pending.push(() => checkTargetMeta(controllerMeta, groupOf, name))
    for (const route of controller.routes) {
      const where = `${name}.${String(route?.handler)}`
      assertRoute(route, where)
      if (options.cookies.signer === undefined) {
        const signed = route.params.find(param => param?.source === 'signedCookie')
        if (signed !== undefined) {
          throw new ZnightError(
            ErrorCode.MissingConfig,
            `HttpPlugin: ${where} reads a signed cookie (@SignedCookie('${signed.name ?? ''}')) but cookies.secrets is not set`,
            {
              hints: [
                "Set HttpPlugin.configure({ cookies: { secrets: [...] } }) with secrets of at least 32 bytes (crypto.randomBytes(32).toString('base64url'))",
              ],
            },
          )
        }
      }
      let path: RoutePath
      try {
        path = parseRoutePath(joinPaths(options.prefix, route.fullPath))
      } catch (error) {
        if (!(error instanceof RoutePathError)) throw error
        throw new ZnightError(
          ErrorCode.InvalidRoute,
          `Invalid route ${route.method} ${route.fullPath} (${where}): ${error.issue.message}`,
          { cause: error },
        )
      }
      const routeMeta = assertMeta(route.meta, where)
      const guards = [
        ...globalGuards,
        ...controllerGuards,
        ...route.guards.map(token => compiledGuard(token, `guard of ${where}`)),
      ]
      const interceptors = [
        ...globalInterceptors,
        ...controllerInterceptors,
        ...route.interceptors.map(token => lookup<HttpInterceptor>(token, `interceptor of ${where}`)),
      ]
      const body = bodyPlan(route, options.bodyLimit, options.uploads)
      const parseBody = body.upload || route.params.some(param => param.source === 'body')
      const chain = guards.map(guard => guard.resolvable)
      // computed once every group is declared (guards of every chain, plugin routes), then frozen
      let meta: RouteMeta | undefined
      const effective = (): RouteMeta => {
        meta ??= effectiveMeta(controllerMeta, routeMeta, groupOf)
        return meta
      }
      pending.push(() => checkTargetMeta(routeMeta, groupOf, where))
      declared.push({
        method: route.method,
        path,
        plan: (method: string): RoutePlan => ({
          definition: route,
          path,
          info: Object.freeze({
            method,
            path: path.path,
            controller: controller.token,
            handler: route.handler,
            meta: effective(),
          }),
          controller: instance,
          guards: chain,
          interceptors,
          parseBody,
          body,
        }),
        label: where,
        source: 'controller',
        guards,
        meta: effective,
      })
    }
  }

  for (const route of pluginRoutes) {
    const label = `plugin "${route.plugin}" (${route.name})`
    const where = `${route.method} ${route.path.path} (${route.name})`
    const guards = [
      ...globalGuards,
      ...guardEntries(
        container,
        metadata,
        route.guards,
        ref =>
          new ZnightError(
            ErrorCode.InvalidRoute,
            `HttpPlugin: plugin "${route.plugin}": the guards of the route ${where} must be classes or objects with a canActivate() method (received ${describeValue(ref)})`,
          ),
      ),
    ]
    const values: Record<string, unknown> = {}
    for (const entry of route.meta) {
      groups.declare(entry, `the plugin "${route.plugin}"`)
      values[entry.key] = entry.value
    }
    const meta: RouteMeta = Object.freeze(values)
    pending.push(() => checkTargetMeta(meta, groupOf, `the route ${where} of the plugin "${route.plugin}"`))
    const handler = route.handler
    const definition: HttpRouteDefinition = Object.freeze({
      method: route.method,
      path: route.relativePath,
      fullPath: route.relativePath,
      handler: route.name,
      meta,
      guards: [],
      interceptors: [],
      params: [],
      invoke: (_plugin: unknown, http: HttpContext): unknown => handler(http),
    })
    const instance: Resolvable<object> = { instance: route.instance }
    const body = bodyPlan({}, options.bodyLimit, options.uploads)
    const chain = guards.map(guard => guard.resolvable)
    const path = route.path
    declared.push({
      method: route.method,
      path,
      plan: (method: string): RoutePlan => ({
        definition,
        path,
        info: Object.freeze({ method, path: path.path, controller: route.plugin, handler: route.name, meta }),
        controller: instance,
        guards: chain,
        // global interceptors wrap controllers only (a response envelope would break a document)
        interceptors: [],
        parseBody: false,
        body,
      }),
      label,
      source: route.plugin,
      guards,
      meta: () => meta,
    })
  }

  // `enforces` of every guard class, read once per class. The guards of the chains declare their
  // groups; the guard classes of the application that sit in no chain only make their groups known,
  // so that a decision whose guard was forgotten everywhere (a second entrypoint, a worker, a test)
  // is still reported instead of being silently unenforced
  const enforcedGroups = new Map<unknown, ReadonlySet<string>>()
  const enforcers = new Map<string, Set<string>>()
  const readEnforces = (cls: unknown, name: string, chained: boolean): void => {
    if (enforcedGroups.has(cls)) return
    const infos = enforcedBy(cls, name)
    if (chained) for (const info of infos) groups.declare(info, `the guard ${name}`)
    enforcedGroups.set(cls, new Set(infos.map(info => info.group)))
    for (const info of infos) {
      let names = enforcers.get(info.group)
      if (names === undefined) {
        names = new Set()
        enforcers.set(info.group, names)
      }
      names.add(name)
    }
  }
  for (const route of declared) for (const guard of route.guards) readEnforces(guard.cls, guard.name, true)
  for (const token of Object.keys(metadata.providers)) {
    const cls = metadata.providers[token]?.class
    if (isGuardClass(cls)) readEnforces(cls, displayName(token), false)
  }
  for (const check of pending) check()
  const checked: CheckedRoute[] = declared.map(route => {
    const enforced = new Set<string>()
    for (const guard of route.guards) for (const group of enforcedGroups.get(guard.cls) ?? []) enforced.add(group)
    return {
      description: `${route.method} ${route.path.path} (${route.label})`,
      meta: route.meta(),
      enforced,
      ...(route.source === 'controller' ? {} : { plugin: route.source }),
    }
  })

  const registration = (route: Declared, method: Exclude<HttpMethod, 'ALL'>): Registration => ({
    method,
    path: route.path,
    plan: route.plan(method),
    label: route.label,
    source: route.source,
    guards: Object.freeze(route.guards.map(guard => guard.name)),
  })
  const explicit: Registration[] = []
  const catchAll: Declared[] = []
  for (const route of declared) {
    if (route.method === 'ALL') catchAll.push(route)
    else explicit.push(registration(route, route.method))
  }

  // explicit routes, then HEAD for GET routes, then @All routes for the methods left
  const table = new RouteTable<Registration>()
  const accepted: Registration[] = []
  const add = (candidate: Registration, duplicate: boolean): void => {
    const existing = table.add(candidate.method, candidate.path, candidate)
    if (existing === undefined) accepted.push(candidate)
    else if (duplicate) throw duplicateRoute(candidate, existing)
  }
  for (const candidate of explicit) add(candidate, true)
  for (const candidate of explicit) {
    if (candidate.method === 'GET') add({ ...candidate, method: 'HEAD' }, false)
  }
  const catchAllShapes = new Map<string, Registration>()
  for (const route of catchAll) {
    const first = registration(route, 'GET')
    const other = catchAllShapes.get(route.path.shape)
    if (other !== undefined) throw duplicateRoute(first, other)
    catchAllShapes.set(route.path.shape, first)
    for (const method of CONCRETE_METHODS) add(method === 'GET' ? first : registration(route, method), false)
  }

  // trailing-slash variants
  const result: Registration[] = [...accepted]
  if (options.trailingSlash !== 'strict') {
    for (const candidate of accepted) {
      const path = candidate.path
      if (path.segments.length === 0 || path.wildcard) continue
      const variant: RoutePath = {
        path: `${path.path}/`,
        segments: [...path.segments, { kind: 'static', value: '' }],
        params: path.params,
        wildcard: false,
        shape: `${path.shape}/`,
      }
      const plan: RoutePlan =
        options.trailingSlash === 'redirect'
          ? { ...candidate.plan, path: variant, redirect: true }
          : { ...candidate.plan, path: variant }
      result.push({ ...candidate, path: variant, plan })
    }
  }

  // HEAD first (Express answers HEAD with the first matching GET route), then most specific first
  const registrations = result.sort((a, b) => {
    const head = (a.method === 'HEAD' ? 0 : 1) - (b.method === 'HEAD' ? 0 : 1)
    if (head !== 0) return head
    return compareRoutePaths(a.path, b.path) || compareStrings(a.method, b.method)
  })
  return { registrations, checked: { routes: checked, groups, enforcers } }
}

const EMPTY_META: RouteMeta = Object.freeze({})

/** Hand-written metadata: two keys of one group on one target (ZNIGHT007). */
function checkTargetMeta(meta: RouteMeta, groupOf: (key: string) => string, target: string): void {
  const conflict = conflictingKeys(meta, groupOf)
  if (conflict === undefined) return
  throw new ZnightError(
    ErrorCode.InvalidRoute,
    `Invalid route metadata of ${target}: "${conflict[0]}" and "${conflict[1]}" are two decisions of the "${conflict[2]}" group`,
    { hints: ['The decorators of a group are alternatives: keep one per controller or route'] },
  )
}

function duplicateRoute(registration: Registration, existing: Registration): ZnightError {
  const plugin = registration.source === 'controller' ? existing.source : registration.source
  return new ZnightError(
    ErrorCode.InvalidRoute,
    `Duplicate route ${registration.method} ${registration.path.path}: ${registration.label} conflicts with ${existing.label} (${existing.path.path})`,
    {
      hints: [
        'Two routes with the same method and the same path shape (parameter names aside) cannot coexist',
        ...(plugin === 'controller' ? [] : [`Change the path of the route in the options of the plugin "${plugin}"`]),
      ],
    },
  )
}

/** Route metadata must be a plain object (hand-written metadata). */
function assertMeta(meta: unknown, where: string): RouteMeta {
  if (meta === undefined) return EMPTY_META
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new ZnightError(
      ErrorCode.InvalidRoute,
      `Invalid route metadata of ${where}: expected an object (received ${describeValue(meta)})`,
    )
  }
  return meta as RouteMeta
}

function assertController(controller: HttpControllerDefinition): void {
  if (
    controller === null ||
    typeof controller !== 'object' ||
    typeof controller.token !== 'string' ||
    !Array.isArray(controller.routes) ||
    !Array.isArray(controller.guards) ||
    !Array.isArray(controller.interceptors)
  ) {
    throw new ZnightError(
      ErrorCode.InvalidRoute,
      `Invalid controller definition in metadata.extensions.http: ${describeValue(controller)}`,
    )
  }
}

function assertRoute(route: HttpRouteDefinition, where: string): void {
  if (
    route === null ||
    typeof route !== 'object' ||
    typeof route.invoke !== 'function' ||
    typeof route.handler !== 'string'
  ) {
    throw new ZnightError(ErrorCode.InvalidRoute, `Invalid route definition ${where}: missing handler or invoke()`)
  }
  if (!(CONCRETE_METHODS as readonly string[]).includes(route.method) && route.method !== 'ALL') {
    throw new ZnightError(
      ErrorCode.InvalidRoute,
      `Invalid route ${where}: unknown method ${describeValue(route.method)}`,
    )
  }
  if (typeof route.fullPath !== 'string') {
    throw new ZnightError(ErrorCode.InvalidRoute, `Invalid route ${where}: missing fullPath`)
  }
  if (route.status !== undefined && !isValidStatus(route.status)) {
    throw new ZnightError(
      ErrorCode.InvalidRoute,
      `Invalid route ${where}: @HttpCode(${describeValue(route.status)}) is not a valid status`,
    )
  }
  if (!Array.isArray(route.guards) || !Array.isArray(route.interceptors) || !Array.isArray(route.params)) {
    throw new ZnightError(
      ErrorCode.InvalidRoute,
      `Invalid route ${where}: guards, interceptors and params must be arrays`,
    )
  }
  if (route.bodyLimit !== undefined && !isSize(route.bodyLimit)) {
    throw new ZnightError(
      ErrorCode.InvalidRoute,
      `Invalid route ${where}: bodyLimit must be a number of bytes (or Infinity), got ${describeValue(route.bodyLimit)}`,
    )
  }
  if (route.uploads !== undefined) assertUploads(route, where)
  if (route.sse !== undefined) assertSse(route, where)
}

function assertSse(route: HttpRouteDefinition, where: string): void {
  const sse: unknown = route.sse
  const invalid = (reason: string): ZnightError =>
    new ZnightError(ErrorCode.InvalidRoute, `Invalid route ${where}: ${reason}`, {
      hints: [
        'sse: { heartbeat?: 0 | 1000 ≤ ms ≤ 2147483647, retry?: ms ≥ 0, maxDuration?: 1000 ≤ ms ≤ 2147483647 } on a GET route',
      ],
    })
  if (route.method !== 'GET') throw invalid(`sse is only valid on GET routes (method ${route.method})`)
  if (sse === null || typeof sse !== 'object' || Array.isArray(sse)) throw invalid('sse must be an object')
  for (const [key, value] of Object.entries(sse)) {
    if (value === undefined) continue
    const integer = typeof value === 'number' && Number.isSafeInteger(value)
    const timer = integer && value >= MIN_SSE_INTERVAL_MS && value <= MAX_SSE_TIMER_MS
    const valid =
      (key === 'heartbeat' && integer && (value === 0 || timer)) ||
      (key === 'retry' && integer && value >= 0) ||
      (key === 'maxDuration' && timer)
    if (!valid) throw invalid(`invalid sse.${key} ${describeValue(value)}`)
  }
}

function isSize(value: unknown): boolean {
  return value === Number.POSITIVE_INFINITY || (Number.isSafeInteger(value) && (value as number) >= 0)
}

function assertUploads(route: HttpRouteDefinition, where: string): void {
  const invalid = (reason: string): ZnightError =>
    new ZnightError(ErrorCode.InvalidRoute, `Invalid route ${where}: ${reason}`, {
      hints: ['uploads: [{ field?, multiple?, required?, maxSize?, maxFiles?, mimeTypes? }]'],
    })
  if (!Array.isArray(route.uploads)) throw invalid('uploads must be an array')
  const fields = new Set<string | undefined>()
  for (const upload of route.uploads) {
    if (upload === null || typeof upload !== 'object') throw invalid(`invalid upload ${describeValue(upload)}`)
    const { field, maxSize, maxFiles, mimeTypes } = upload
    if (field !== undefined && (typeof field !== 'string' || field === '')) {
      throw invalid(`invalid upload field ${describeValue(field)}`)
    }
    if (fields.has(field) || (fields.size > 0 && (field === undefined || fields.has(undefined)))) {
      throw invalid(
        field === undefined
          ? 'an upload without field (every file) cannot be combined with other uploads'
          : `several uploads for the field "${field}"`,
      )
    }
    fields.add(field)
    if (maxSize !== undefined && !isSize(maxSize)) throw invalid(`invalid maxSize ${describeValue(maxSize)}`)
    if (maxFiles !== undefined && (!isSize(maxFiles) || maxFiles < 1)) {
      throw invalid(`invalid maxFiles ${describeValue(maxFiles)}`)
    }
    if (
      mimeTypes !== undefined &&
      (!Array.isArray(mimeTypes) ||
        mimeTypes.length === 0 ||
        !mimeTypes.every(type => typeof type === 'string' && isMediaTypePattern(type)))
    ) {
      throw invalid(`invalid mimeTypes ${describeValue(mimeTypes)}`)
    }
  }
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// -------------------------------------------------------------------------------------------------
// Provider resolution
// -------------------------------------------------------------------------------------------------

/**
 * Singletons (and registered values) are resolved once at bootstrap; request-scoped and transient
 * providers on every request.
 */
function resolvable<T>(container: Container, metadata: ZnightMetadata, token: Token, what: string): Resolvable<T> {
  const scope = Object.hasOwn(metadata.providers, token) ? metadata.providers[token]?.scope : undefined
  if (!container.has(token)) {
    throw new ZnightError(ErrorCode.MissingProvider, `HttpPlugin: the ${what} (${token}) is not a provider`, {
      hints: ['Add @Injectable() to the class (controllers are providers through @Controller())'],
    })
  }
  if (scope === 'request' || scope === 'transient') return { token }
  try {
    return { instance: container.get(token) as T }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === ErrorCode.NoActiveScope) return { token }
    throw error
  }
}

type GlobalKey = 'guards' | 'interceptors' | 'exceptionMappers'
const GLOBAL_KEYS: readonly GlobalKey[] = ['guards', 'interceptors', 'exceptionMappers']
const GLOBAL_METHOD: Readonly<Record<GlobalKey, string>> = {
  guards: 'canActivate',
  interceptors: 'intercept',
  exceptionMappers: 'map',
}
const GLOBAL_WHAT: Readonly<Record<GlobalKey, string>> = {
  guards: 'guard',
  interceptors: 'interceptor',
  exceptionMappers: 'exception mapper',
}

/** Resolves global guards / interceptors / exception mappers given as classes or instances. */
function globalRefs<T>(
  container: Container,
  metadata: ZnightMetadata,
  options: HttpPluginOptions,
  key: GlobalKey,
): Resolvable<T>[] {
  const refs: unknown = options[key] ?? []
  if (!Array.isArray(refs)) throw invalidOption(key, 'an array', refs)
  const method = GLOBAL_METHOD[key]
  const what = GLOBAL_WHAT[key]
  return refs.map(
    (ref: unknown): Resolvable<T> =>
      resolveRef<T>(container, metadata, ref, what, method, () =>
        invalidOption(key, `classes or objects with a ${method}() method`, ref),
      ).resolvable,
  )
}

/** A provider class whose instances are guards (a `canActivate()` method on its prototype). */
function isGuardClass(cls: unknown): boolean {
  if (typeof cls !== 'function') return false
  const prototype: unknown = (cls as { prototype?: unknown }).prototype
  return (
    typeof prototype === 'object' &&
    prototype !== null &&
    typeof (prototype as { canActivate?: unknown }).canActivate === 'function'
  )
}

/** Guards given as classes or instances (`guards` option, plugin routes), with their class and name. */
function guardEntries(
  container: Container,
  metadata: ZnightMetadata,
  refs: unknown,
  invalid: (ref: unknown) => ZnightError,
): GuardEntry[] {
  if (!Array.isArray(refs)) throw invalidOption('guards', 'an array', refs)
  return refs.map((ref: unknown) =>
    resolveRef<CanActivate>(container, metadata, ref, 'guard', 'canActivate', () => invalid(ref)),
  )
}

function resolveRef<T>(
  container: Container,
  metadata: ZnightMetadata,
  ref: unknown,
  what: string,
  method: string,
  invalid: () => ZnightError,
): { readonly resolvable: Resolvable<T>; readonly cls: unknown; readonly name: string } {
  if (typeof ref === 'function') {
    const token = container.tokenOf(ref as GuardClass)
    if (token === undefined) {
      const name = (ref as { name?: string }).name || '<anonymous>'
      throw new ZnightError(ErrorCode.MissingProvider, `HttpPlugin: the global ${what} ${name} is not a provider`, {
        hints: ['Add @Injectable() to the class, or pass an instance'],
      })
    }
    return {
      resolvable: resolvable<T>(container, metadata, token, `global ${what}`),
      cls: ref,
      name: displayName(token),
    }
  }
  if (ref !== null && typeof ref === 'object' && typeof (ref as Record<string, unknown>)[method] === 'function') {
    const cls: unknown = (ref as { constructor?: unknown }).constructor
    const className = typeof cls === 'function' && cls !== Object ? (cls as { name?: string }).name : undefined
    return { resolvable: { instance: ref as T }, cls, name: className || `${what} instance` }
  }
  throw invalid()
}
