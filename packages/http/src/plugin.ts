import type { Container, Plugin, PluginContext, PluginOptions, Token, ZnightMetadata } from '@znight/core'
import type { AdapterReply, HttpAdapter, HttpServerAddress, InjectRequest, InjectResponse } from './adapter.ts'
import type {
  CanActivate,
  ExceptionMapper,
  ExceptionMapperClass,
  GuardClass,
  HttpInterceptor,
  HttpInterceptorClass,
} from './interfaces.ts'
import type { HttpControllerDefinition, HttpMetadata, HttpMethod, HttpRouteDefinition } from './metadata.ts'

import { displayName, ErrorCode, resolveOptions, ZnightError } from '@znight/core'

import { nodeAdapter } from './adapters/node.ts'
import { compareRoutePaths, compareStrings, joinPaths, parseRoutePath, type RoutePath, RoutePathError } from './path.ts'
import { Pipeline, type Resolvable, type RoutePlan } from './pipeline.ts'
import { RouteTable } from './router.ts'
import { isValidStatus } from './status.ts'
import { HttpTokens } from './tokens.ts'

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
  /** Maximum request body size in bytes (413 above). Default: 1 MiB. */
  readonly bodyLimit?: number
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
   * Keep it below the application `shutdown.hookTimeoutMs`. Default: 4 000 ms.
   */
  readonly drainTimeoutMs?: number
}

/** A route registered by the plugin (see {@link HttpPlugin.routes}). */
export interface HttpRouteSummary {
  readonly method: string
  readonly path: string
  /** Controller display name. */
  readonly controller: string
  readonly handler: string
}

interface Resolved {
  readonly adapter: HttpAdapter
  readonly port: number
  readonly host: string
  readonly prefix: string
  readonly trailingSlash: TrailingSlashPolicy
  readonly exposeErrors: boolean
  readonly bodyLimit: number
  readonly requestIdHeader: string | undefined
  readonly generateRequestId: () => string
  readonly drainTimeoutMs: number
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
}

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_BODY_LIMIT = 1_048_576
const DEFAULT_DRAIN_TIMEOUT_MS = 4_000
const DEFAULT_REQUEST_ID_HEADER = 'x-request-id'
const CONCRETE_METHODS: readonly Exclude<HttpMethod, 'ALL'>[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

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
 * `onBootstrap` resolves the options, controllers, guards and interceptors and registers the
 * routes; `onStart` listens; `onStop` stops accepting connections and drains in-flight requests
 * (`drainTimeoutMs`); `onDispose` closes the server.
 */
export class HttpPlugin implements Plugin {
  readonly name = 'http'
  readonly #options: PluginOptions<HttpPluginOptions>
  #runtime: Runtime | undefined
  #address: HttpServerAddress | undefined
  #disposed = false

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

  /** Registered routes (after `onBootstrap`), in registration order. */
  get routes(): readonly HttpRouteSummary[] {
    return this.#runtime?.routes ?? []
  }

  /** Number of requests being processed. */
  get inflight(): number {
    return this.#runtime?.pipeline.inflight ?? 0
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
      return this.#require('inject()').adapter.inject(request)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  register(ctx: PluginContext): void {
    ctx.container.registerExternal({ token: HttpTokens.Context, scope: 'request', providedBy: 'HttpPlugin' })
    ctx.container.registerExternal({ token: HttpTokens.RequestId, scope: 'request', providedBy: 'HttpPlugin' })
    ctx.container.registerValue(HttpTokens.Plugin, this)
  }

  onBootstrap(ctx: PluginContext): void {
    const raw = resolveOptions(this.#options, ctx.container)
    const options = resolve(raw)
    const table = new RouteTable<unknown>()
    const pipeline = new Pipeline(
      ctx.container,
      ctx.hooks,
      ctx.logger,
      {
        adapter: options.adapter.name,
        bodyLimit: options.bodyLimit,
        exposeErrors: options.exposeErrors,
        requestIdHeader: options.requestIdHeader,
        generateRequestId: options.generateRequestId,
        mappers: globalRefs<ExceptionMapper>(ctx.container, ctx.metadata, raw, 'exceptionMappers'),
      },
      table,
    )
    const registrations = buildRegistrations(ctx.container, ctx.metadata, options, raw)
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
      routes.push({
        method: registration.method,
        path: registration.path.path,
        controller: displayName(plan.info.controller),
        handler: plan.info.handler,
      })
    }
    adapter.setFallbackHandler((request, error) => pipeline.fallback(request, error))
    this.#runtime = { adapter, pipeline, options, routes }
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
    const timeoutMs = runtime.options.drainTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
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
    if (this.#disposed) return
    this.#disposed = true
    const runtime = this.#runtime
    this.#address = undefined
    if (runtime !== undefined) await runtime.adapter.close({ force: true })
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
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 0)
    throw invalidOption('bodyLimit', 'a positive integer', bodyLimit)
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  if (typeof drainTimeoutMs !== 'number' || !(drainTimeoutMs >= 0)) {
    throw invalidOption('drainTimeoutMs', 'a positive number', drainTimeoutMs)
  }
  const requestIdHeader = options.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER
  if (requestIdHeader !== false && (typeof requestIdHeader !== 'string' || !HEADER_NAME.test(requestIdHeader))) {
    throw invalidOption('requestIdHeader', 'a header name or false', requestIdHeader)
  }
  const generateRequestId = options.generateRequestId ?? ((): string => crypto.randomUUID())
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
  return {
    adapter,
    port,
    host,
    prefix: parsedPrefix.path,
    trailingSlash,
    exposeErrors: options.exposeErrors === true,
    bodyLimit,
    requestIdHeader: requestIdHeader === false ? undefined : requestIdHeader.toLowerCase(),
    generateRequestId,
    drainTimeoutMs,
  }
}

function invalidOption(name: string, expected: string, value: unknown, cause?: unknown): ZnightError {
  let received: string
  try {
    received = typeof value === 'function' ? 'a function' : (JSON.stringify(value) ?? String(value))
  } catch {
    received = typeof value
  }
  return new ZnightError(
    ErrorCode.InvalidDecorator,
    `HttpPlugin: option "${name}" must be ${expected} (received ${received})`,
    {
      ...(cause === undefined ? {} : { cause }),
    },
  )
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

function buildRegistrations(
  container: Container,
  metadata: ZnightMetadata,
  options: Resolved,
  raw: HttpPluginOptions,
): Registration[] {
  const http = httpMetadata(metadata)
  const globalGuards = globalRefs<CanActivate>(container, metadata, raw, 'guards')
  const globalInterceptors = globalRefs<HttpInterceptor>(container, metadata, raw, 'interceptors')
  const resolvables = new Map<Token, Resolvable<unknown>>()
  const lookup = <T>(token: Token, what: string): Resolvable<T> => {
    let found = resolvables.get(token)
    if (found === undefined) {
      found = resolvable(container, metadata, token, what)
      resolvables.set(token, found)
    }
    return found as Resolvable<T>
  }

  const explicit: Registration[] = []
  const catchAll: { readonly path: RoutePath; readonly plan: (method: string) => RoutePlan }[] = []
  for (const controller of http.controllers) {
    assertController(controller)
    const name = displayName(controller.token)
    const instance = lookup<object>(controller.token, `controller ${name}`)
    const controllerGuards = controller.guards.map(token => lookup<CanActivate>(token, `guard of ${name}`))
    const controllerInterceptors = controller.interceptors.map(token =>
      lookup<HttpInterceptor>(token, `interceptor of ${name}`),
    )
    for (const route of controller.routes) {
      const where = `${name}.${String(route?.handler)}`
      assertRoute(route, where)
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
      const meta = Object.freeze({ ...controller.meta, ...route.meta })
      const guards = [
        ...globalGuards,
        ...controllerGuards,
        ...route.guards.map(token => lookup<CanActivate>(token, `guard of ${where}`)),
      ]
      const interceptors = [
        ...globalInterceptors,
        ...controllerInterceptors,
        ...route.interceptors.map(token => lookup<HttpInterceptor>(token, `interceptor of ${where}`)),
      ]
      const parseBody = route.params.some(param => param.source === 'body')
      const plan = (method: string): RoutePlan => ({
        definition: route,
        path,
        info: Object.freeze({ method, path: path.path, controller: controller.token, handler: route.handler, meta }),
        controller: instance,
        guards,
        interceptors,
        parseBody,
      })
      if (route.method === 'ALL') catchAll.push({ path, plan })
      else explicit.push({ method: route.method, path, plan: plan(route.method) })
    }
  }

  // explicit routes, then HEAD for GET routes, then @All routes for the methods left
  const table = new RouteTable<Registration>()
  const accepted: Registration[] = []
  const add = (registration: Registration, duplicate: boolean): void => {
    const existing = table.add(registration.method, registration.path, registration)
    if (existing === undefined) accepted.push(registration)
    else if (duplicate) throw duplicateRoute(registration, existing)
  }
  for (const registration of explicit) add(registration, true)
  for (const registration of explicit) {
    if (registration.method === 'GET') add({ ...registration, method: 'HEAD' }, false)
  }
  const catchAllShapes = new Map<string, Registration>()
  for (const { path, plan } of catchAll) {
    const first: Registration = { method: 'GET', path, plan: plan('GET') }
    const other = catchAllShapes.get(path.shape)
    if (other !== undefined) throw duplicateRoute(first, other)
    catchAllShapes.set(path.shape, first)
    for (const method of CONCRETE_METHODS) add(method === 'GET' ? first : { method, path, plan: plan(method) }, false)
  }

  // trailing-slash variants
  const result: Registration[] = [...accepted]
  if (options.trailingSlash !== 'strict') {
    for (const registration of accepted) {
      const path = registration.path
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
          ? { ...registration.plan, path: variant, redirect: true }
          : { ...registration.plan, path: variant }
      result.push({ method: registration.method, path: variant, plan })
    }
  }

  // HEAD first (Express answers HEAD with the first matching GET route), then most specific first
  return result.sort((a, b) => {
    const head = (a.method === 'HEAD' ? 0 : 1) - (b.method === 'HEAD' ? 0 : 1)
    if (head !== 0) return head
    return compareRoutePaths(a.path, b.path) || compareStrings(a.method, b.method)
  })
}

function duplicateRoute(registration: Registration, existing: Registration): ZnightError {
  const describe = (plan: RoutePlan): string => `${displayName(plan.info.controller)}.${plan.info.handler}`
  return new ZnightError(
    ErrorCode.InvalidRoute,
    `Duplicate route ${registration.method} ${registration.path.path}: ${describe(registration.plan)} conflicts with ${describe(existing.plan)} (${existing.path.path})`,
    { hints: ['Two routes with the same method and the same path shape (parameter names aside) cannot coexist'] },
  )
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
  return refs.map((ref: unknown): Resolvable<T> => {
    if (typeof ref === 'function') {
      const token = container.tokenOf(ref as GuardClass)
      if (token === undefined) {
        const name = (ref as { name?: string }).name || '<anonymous>'
        throw new ZnightError(ErrorCode.MissingProvider, `HttpPlugin: the global ${what} ${name} is not a provider`, {
          hints: ['Add @Injectable() to the class, or pass an instance'],
        })
      }
      return resolvable<T>(container, metadata, token, `global ${what}`)
    }
    if (ref !== null && typeof ref === 'object' && typeof (ref as Record<string, unknown>)[method] === 'function') {
      return { instance: ref as T }
    }
    throw invalidOption(key, `classes or objects with a ${method}() method`, ref)
  })
}
