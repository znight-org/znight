/**
 * `GraphQLPlugin` (RFC 0005 §5.11, §8.2): builds the schema from `metadata.extensions.graphql`,
 * provides `GraphQLContext`, `PubSub` and itself to the container, executes operations
 * (`execute()`, `subscribe()`, the `engine` of drivers, RFC 0009) and contributes the routes of its
 * driver (the built-in GraphQL-over-HTTP endpoint by default) to `HttpPlugin`.
 */
import type {
  Container,
  CoreLogger,
  Hooks,
  Plugin,
  PluginContext,
  PluginOptions,
  PluginRootsContext,
  ProviderKey,
  Token,
  ZnightMetadata,
} from '@znight/core'
import type { HttpPlugin, PluginHttpRoutes, PluginHttpRoutesContext, PluginRoute, SseOptions } from '@znight/http'
import type { FormattedExecutionResult, GraphQLSchema } from 'graphql'
import type { CheckedField } from './decisions.ts'
import type { GraphQLDriver, GraphQLDriverRoute } from './driver.ts'
import type { GraphQLEngine } from './engine.ts'
import type { ExecuteOptions, GraphQLRequest, GraphQLResultStream } from './execution.ts'
import type { Resolvable } from './format.ts'
import type { GraphQLInputTypeDefinition, GraphQLMetadata, GraphQLResolverBinding } from './metadata.ts'
import type { GraphQLPluginOptions, ResolvedGraphQLOptions } from './options.ts'
import type { GraphQLErrorMapper, GraphQLGuard, GraphQLResultMapper } from './types.ts'

import { displayName, ErrorCode, resolveOptions, ZnightError } from '@znight/core'
import { printSchema } from 'graphql'

import { checkFieldDecisions } from './decisions.ts'
import { Engine } from './engine.ts'
import { GraphQLExecutor, singleResult } from './execution.ts'
import { ErrorFormatter } from './format.ts'
import { LoaderFactory } from './loaders.ts'
import { MemoryPubSub } from './memory-pubsub.ts'
import { invalidOption, resolveGraphQLOptions } from './options.ts'
import { globalGuardsApply, pipelineFactory } from './pipeline.ts'
import { PubSub } from './pubsub.ts'
import { checkResultTypes, declaredTypes, ResultMappers } from './results.ts'
import { buildGraphQLSchema, checkGraphQLSection, graphqlSection } from './schema.ts'
import { GraphQLTokens } from './tokens.ts'
import { BUILTIN_DRIVER, BuiltinDriver } from './transport/builtin.ts'
import { checkSseOptions } from './transport/http.ts'

/** Options of {@link GraphQLPlugin.execute} and {@link GraphQLPlugin.subscribe}. */
export interface DirectExecuteOptions {
  /** Cancels the operation (graphql-js `abortSignal`, `GraphQLContext.signal`). */
  readonly signal?: AbortSignal
  /** `GraphQLContext.requestId`. Default: the request id of the enclosing scope, or a UUID. */
  readonly requestId?: string
}

/** What the plugin built at bootstrap. */
interface Runtime {
  readonly schema: GraphQLSchema
  readonly section: GraphQLMetadata
  readonly executor: GraphQLExecutor
  readonly engine: GraphQLEngine
}

let readExecutor: (plugin: GraphQLPlugin) => GraphQLExecutor
let readEndpoint: (plugin: GraphQLPlugin) => string | undefined

/**
 * The executor of a bootstrapped plugin: the internal API of the transports (statuses, streams).
 * Not exported from the package entry.
 */
export function executorOf(plugin: GraphQLPlugin): GraphQLExecutor {
  return readExecutor(plugin)
}

/**
 * The absolute path of the GraphQL-over-HTTP endpoint (prefix included), `undefined` without HTTP
 * transport (`http: false`, or before `HttpPlugin` collected the routes). Not exported from the
 * package entry: `@znight/graphql/testing` sends its requests there.
 */
export function endpointOf(plugin: GraphQLPlugin): string | undefined {
  return readEndpoint(plugin)
}

/** A value of type `T` or a promise of it. */
export type MaybePromise<T> = T | Promise<T>

/**
 * The GraphQL plugin: `GraphQLPlugin.configure(options)` (name `graphql`).
 *
 * ```ts
 * await Application.create({
 *   metadata: __ZNIGHT_METADATA__,
 *   plugins: [HttpPlugin.configure(), GraphQLPlugin.configure({ guards: [AccessGuard] })],
 * })
 * ```
 */
export class GraphQLPlugin implements Plugin, PluginHttpRoutes {
  readonly name = 'graphql'
  readonly #options: PluginOptions<GraphQLPluginOptions>
  #resolved: ResolvedGraphQLOptions | undefined
  #container: Container | undefined
  #metadata: ZnightMetadata | undefined
  #logger: CoreLogger | undefined
  #hooks: Hooks | undefined
  #pubsub: PubSub | undefined
  #ownPubSub: MemoryPubSub | undefined
  #runtime: Runtime | undefined
  #stop: AbortController | undefined
  #endpoint: string | undefined
  /** The driver serving the schema: the `driver` option, or the built-in transport. */
  #driver: GraphQLDriver | undefined
  /** The driver was started (`onBootstrap`): `onStop` stops it. */
  #started = false
  #active = false

  private constructor(options: PluginOptions<GraphQLPluginOptions>) {
    this.#options = options
  }

  static {
    readExecutor = plugin => plugin.#ready().executor
    readEndpoint = plugin => plugin.#endpoint
  }

  /**
   * Creates the plugin. `options` may be a function of the container, evaluated once, when first
   * needed after the container is initialised: `GraphQLPlugin.configure(c => ({ exposeErrors: c.get(Env).dev }))`.
   */
  static configure(options: PluginOptions<GraphQLPluginOptions> = {}): GraphQLPlugin {
    return new GraphQLPlugin(options)
  }

  /**
   * Providers `TestApp` creates at boot: the classes of the `guards`, `errorMappers` and `resultMappers` options, and
   * the resolvers, guards and loaders of the metadata.
   */
  initRoots(context?: PluginRootsContext): readonly ProviderKey[] {
    const roots = new Set<ProviderKey>()
    try {
      const options: unknown = this.#options
      if (options !== null && typeof options === 'object') {
        for (const key of ['guards', 'errorMappers', 'resultMappers'] as const) {
          const refs: unknown = (options as GraphQLPluginOptions)[key]
          if (Array.isArray(refs)) for (const ref of refs) if (typeof ref === 'function') roots.add(ref as ProviderKey)
        }
      }
      const types: unknown = (context?.metadata.extensions?.graphql as { types?: unknown } | undefined)?.types
      if (Array.isArray(types)) {
        for (const type of types as { fields?: unknown }[]) {
          if (!Array.isArray(type?.fields)) continue
          for (const field of type.fields as { resolver?: Partial<GraphQLResolverBinding> }[]) {
            const binding = field?.resolver
            if (binding === undefined || typeof binding.token !== 'string') continue
            roots.add(binding.token)
            for (const token of [...(binding.guards ?? []), ...(binding.loaders ?? [])]) {
              if (typeof token === 'string') roots.add(token)
            }
          }
        }
      }
    } catch {
      // initRoots never throws: register() reports malformed options and metadata
    }
    return [...roots]
  }

  register(ctx: PluginContext): void {
    if (this.#active) {
      throw new ZnightError(ErrorCode.DuplicateProvider, 'This GraphQLPlugin is already used by another application', {
        hints: ['Call GraphQLPlugin.configure() once per application'],
      })
    }
    this.#resolved = undefined
    this.#runtime = undefined
    this.#ownPubSub = undefined
    this.#endpoint = undefined
    this.#driver = undefined
    this.#started = false
    this.#container = ctx.container
    this.#metadata = ctx.metadata
    this.#logger = ctx.logger
    this.#hooks = ctx.hooks
    if (typeof this.#options !== 'function') {
      // static options: validated now, and the HTTP transport needs HttpPlugin
      this.#checkHttp(ctx, this.#resolve())
    }
    this.#active = true
    this.#stop = new AbortController()
    ctx.container.registerExternal({ token: GraphQLTokens.Context, scope: 'request', providedBy: 'GraphQLPlugin' })
    ctx.container.registerValue(
      GraphQLTokens.PubSub,
      typeof this.#options === 'function' ? new DeferredPubSub(() => this.pubsub) : this.pubsub,
    )
    ctx.container.registerValue(GraphQLTokens.Plugin, this)
  }

  /**
   * The `PluginHttpRoutes` contract of `@znight/http`: the routes of the driver, with the `http`
   * option's meta and guards, and its body limit on the routes that are not `GET`. For the built-in
   * transport, the GraphQL endpoint (`GET` and `POST` on `path`). `[]` with `http: false`.
   */
  httpRoutes(context: PluginHttpRoutesContext): readonly PluginRoute[] {
    this.#container ??= context.container
    const options = this.#resolve()
    const http = options.http
    if (http === false) return []
    const driver = this.#driverOf(options)
    // a server-mounted driver attaches itself to the adapter in start()
    if (driver.routes === undefined) return []
    const endpoint = endpointPath(context.prefix, options.path)
    const routes = driver.routes({ path: options.path, endpoint })
    if (!Array.isArray(routes))
      throw invalidOption(`routes() of the ${driver.name} driver`, 'an array of routes', routes)
    this.#endpoint = endpoint
    return routes.map(route => mount(route, http, driver))
  }

  onBootstrap(ctx: PluginContext): void | Promise<void> {
    this.#container = ctx.container
    const options = this.#resolve()
    if (typeof this.#options === 'function') this.#checkHttp(ctx, options)
    if (options.driver === undefined) this.#checkSse(options)
    const runtime = this.#build(ctx, options)
    this.#runtime = runtime
    const driver = this.#driverOf(options)
    // the built-in transport reads the executor on its first request: nothing to start
    if (options.driver === undefined) return
    let started: void | Promise<void>
    try {
      started = driver.start(runtime.engine, {
        logger: ctx.logger,
        container: ctx.container,
        http: ctx.getPlugin<HttpPlugin>('http'),
      })
    } catch (error) {
      throw driverFailed(driver, error)
    }
    if (!isPromise(started)) {
      this.#started = true
      return
    }
    return started.then(
      () => {
        this.#started = true
      },
      (error: unknown) => {
        throw driverFailed(driver, error)
      },
    )
  }

  onStart(ctx: PluginContext): void {
    const runtime = this.#runtime
    const options = this.#resolved
    if (runtime === undefined || options === undefined) return
    const details = { types: runtime.section.types.length, schemaHash: runtime.section.schemaHash }
    if (options.http === false) ctx.logger.info('GraphQL schema ready', details)
    else ctx.logger.info('GraphQL endpoint ready', { path: options.path, ...details })
  }

  async onStop(): Promise<void> {
    this.#stop?.abort(new Error('The application is stopping'))
    // direct subscriptions and the driver's (engine) ones; built-in SSE streams end with HttpPlugin
    await this.#runtime?.executor.stopStreams()
    const driver = this.#driver
    if (this.#started && driver?.stop !== undefined) {
      this.#started = false
      await driver.stop()
    }
  }

  onDispose(): void {
    this.#active = false
    this.#ownPubSub?.close()
    this.#ownPubSub = undefined
    this.#pubsub = undefined
    this.#runtime?.executor.clear()
    this.#runtime = undefined
    this.#resolved = undefined
  }

  /** The schema (after bootstrap). */
  get schema(): GraphQLSchema {
    return this.#ready().schema
  }

  /**
   * The GraphQL engine (after bootstrap, RFC 0009): graphql-js-shaped `parse`, `validate`, `execute`
   * and `subscribe` running this plugin's schema with its guards, loaders, request scope, error
   * formatting and hook. What drivers receive in `start()`; any GraphQL server can call it.
   */
  get engine(): GraphQLEngine {
    return this.#ready().engine
  }

  /** The SDL of the schema (graphql-js `printSchema`). */
  printSchema(): string {
    return printSchema(this.#ready().schema)
  }

  /** The `PubSub` of the application: the `pubsub` option, or the plugin's `MemoryPubSub`. */
  get pubsub(): PubSub {
    let pubsub = this.#pubsub
    if (pubsub === undefined) {
      const options = this.#resolve()
      if (options.pubsub === undefined) {
        this.#ownPubSub = new MemoryPubSub({ bufferSize: options.bufferSize })
        pubsub = this.#ownPubSub
      } else {
        // the option accepts a PubSub of any event map; the container hands it out untyped
        pubsub = options.pubsub as unknown as PubSub
      }
      this.#pubsub = pubsub
    }
    return pubsub
  }

  /** Active subscriptions (every transport). */
  get activeSubscriptions(): number {
    return this.#runtime?.executor.activeSubscriptions ?? 0
  }

  /**
   * Executes a query or a mutation outside of HTTP (custom transports, tests, a controller calling
   * GraphQL), in the current request scope or in a scope of its own. Returns the result directly
   * when every resolver is synchronous; `await` it. A subscription is an error result: use
   * {@link subscribe}. Rejects only when `options.signal` aborts the execution.
   */
  execute(request: GraphQLRequest, options?: DirectExecuteOptions): MaybePromise<FormattedExecutionResult> {
    const response = this.#ready().executor.execute(request, direct(options))
    return isPromise(response) ? response.then(settled => settled.result) : response.result
  }

  /**
   * Subscribes outside of HTTP: the results of the subscription, one per event, until the source
   * ends, `options.signal` aborts, `return()` is called or the application stops. A request error
   * or a query gives a stream of one result.
   */
  async subscribe(request: GraphQLRequest, options?: DirectExecuteOptions): Promise<GraphQLResultStream> {
    const response = await this.#ready().executor.subscribe(request, direct(options))
    return 'status' in response ? singleResult(response.result) : response
  }

  // ------------------------------------------------------------------------------------------------

  #ready(): Runtime {
    const runtime = this.#runtime
    if (runtime === undefined) {
      throw new ZnightError(ErrorCode.LifecycleFailed, 'GraphQLPlugin is not bootstrapped yet', {
        hints: ['The schema and execute() are available once Application.create() resolved'],
      })
    }
    return runtime
  }

  #resolve(): ResolvedGraphQLOptions {
    if (this.#resolved !== undefined) return this.#resolved
    const container = this.#container
    if (container === undefined && typeof this.#options === 'function') {
      throw new ZnightError(ErrorCode.LifecycleFailed, 'GraphQLPlugin: the options are not available before register()')
    }
    this.#resolved = resolveGraphQLOptions(resolveOptions(this.#options, container as Container))
    return this.#resolved
  }

  /** The driver of the application: the `driver` option, or the built-in transport. */
  #driverOf(options: ResolvedGraphQLOptions): GraphQLDriver {
    let driver = this.#driver
    if (driver === undefined) {
      const http = options.http
      driver =
        options.driver ??
        new BuiltinDriver({
          // called on the first request: the routes are collected before or after this plugin's onBootstrap
          executor: () => this.#ready().executor,
          get: http !== false && http.get,
          graphiql: options.graphiql,
          sse: sseOptions(options),
        })
      this.#driver = driver
    }
    return driver
  }

  /** The SSE options are those of `HttpResponse.sse()` (heartbeat and maxDuration from 1 000 ms): checked at boot. */
  #checkSse(options: ResolvedGraphQLOptions): void {
    const sse = sseOptions(options)
    if (sse === false) return
    const problem = checkSseOptions(sse)
    if (problem !== undefined) throw invalidOption('subscriptions', `valid event stream options (${problem})`, sse)
  }

  #checkHttp(ctx: PluginContext, options: ResolvedGraphQLOptions): void {
    const driver = options.driver
    if (options.http === false && driver?.routes !== undefined) {
      throw new ZnightError(
        ErrorCode.InvalidGraphQLSetup,
        `GraphQLPlugin: the ${driver.name} driver serves routes, which http: false turns off`,
        { hints: ['Remove http: false: the driver serves the endpoint through HttpPlugin'] },
      )
    }
    if (options.http !== false && ctx.getPlugin('http') === undefined) {
      throw new ZnightError(
        ErrorCode.InvalidGraphQLSetup,
        'GraphQLPlugin serves its endpoint through HttpPlugin, which is not registered',
        {
          hints: [
            'Add HttpPlugin.configure() to the plugins of the application',
            'Or set http: false to use the schema and execute() only',
          ],
        },
      )
    }
  }

  #build(ctx: PluginContext, options: ResolvedGraphQLOptions): Runtime {
    const container = ctx.container
    const metadata = ctx.metadata
    const section = graphqlSection(metadata)
    const providers = new Providers(container, metadata)
    const globalGuards = options.guards.map(ref => providers.ref<GraphQLGuard>(ref, 'guard', 'canResolve'))
    const mappers = options.errorMappers.map(ref => providers.ref<GraphQLErrorMapper>(ref, 'error mapper', 'map'))
    const resultMappers = options.resultMappers.map(ref => ({
      ...providers.ref<GraphQLResultMapper>(ref, 'result mapper', 'toResult'),
      types: declaredTypes(ref),
    }))
    const inputs = new Map<string, GraphQLInputTypeDefinition>()
    const fields: CheckedField[] = []
    const types = Array.isArray(section?.types) ? section.types : []
    for (const type of types) {
      if (type?.kind === 'input') inputs.set(type.name, type)
      if (type?.kind !== 'object' || !Array.isArray(type.fields)) continue
      for (const field of type.fields) {
        const binding = field?.resolver
        if (binding === undefined || binding === null || typeof binding !== 'object') continue
        const root = binding.operation !== 'field'
        const guardRefs: readonly Token[] = Array.isArray(binding.guards) ? binding.guards : []
        fields.push({
          description: `${type.name}.${field.name} (${displayName(String(binding.token))}.${String(binding.method)})`,
          root,
          meta: binding.meta ?? {},
          guards: [
            ...(globalGuardsApply(binding) ? globalGuards.map(guard => ({ cls: guard.cls, name: guard.name })) : []),
            ...guardRefs.map(token => ({ cls: metadata.providers[token]?.class, name: displayName(token) })),
          ],
        })
      }
    }
    // a malformed section is reported by buildGraphQLSchema, not as types missing from it
    if (resultMappers.length > 0 && checkGraphQLSection(section).length === 0) checkResultTypes(resultMappers, types)
    const results = new ResultMappers(
      container,
      ctx.logger,
      resultMappers.map(mapper => ({
        resolvable: mapper.resolvable,
        name: mapper.name,
        types: mapper.types as readonly string[],
      })),
      types,
    )
    const schema = buildGraphQLSchema(
      section,
      pipelineFactory({
        container,
        globalGuards: globalGuards.map(guard => guard.resolvable),
        guard: (token, coordinate) => providers.token<GraphQLGuard>(token, `guard of ${coordinate}`, 'canResolve'),
        resolver: (binding, coordinate) =>
          providers.token<object>(binding.token, `resolver of ${coordinate}`, binding.method),
        inputs,
        results: (field, coordinate) => results.recover(field, coordinate),
      }),
    )
    checkFieldDecisions(fields, section.groups, options.enforcement, ctx.logger)
    const formatter = new ErrorFormatter({
      container,
      mappers: mappers.map(mapper => mapper.resolvable),
      exposeErrors: options.exposeErrors,
      logger: ctx.logger,
      schema,
    })
    const executor = new GraphQLExecutor({
      schema,
      container,
      hooks: ctx.hooks,
      logger: ctx.logger,
      formatter,
      runtime: {
        container,
        loaders: new LoaderFactory(container),
        signal: (this.#stop as AbortController).signal,
      },
      limits: options.limits,
      introspection: options.introspection,
      documentCache: options.documentCache,
      maxActiveSubscriptions: options.subscriptions === false ? undefined : options.subscriptions.maxActive,
      subscriptions: options.subscriptions !== false,
    })
    const http = ctx.getPlugin<HttpPlugin>('http')
    const engine = new Engine(
      executor,
      {
        path:
          this.#endpoint ?? endpointPath(options.http === false || http === undefined ? '' : http.prefix, options.path),
        introspection: options.introspection,
        ide: options.graphiql,
        exposeErrors: options.exposeErrors,
        maxTokens: options.limits.maxTokens,
        subscriptions: options.subscriptions === false ? false : { maxActive: options.subscriptions.maxActive },
        http: options.http === false ? false : { get: options.http.get, bodyLimit: options.http.bodyLimit },
      },
      options.driver?.name ?? BUILTIN_DRIVER,
    )
    ctx.logger.debug('GraphQL schema built', {
      types: types.length,
      schemaHash: section.schemaHash,
      ...(results.fields === 0 ? {} : { resultFields: results.fields }),
    })
    return { schema, section, executor, engine }
  }
}

function direct(options: DirectExecuteOptions | undefined): ExecuteOptions {
  if (options === undefined) return DIRECT
  return {
    transport: 'direct',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  }
}

const DIRECT: ExecuteOptions = Object.freeze({ transport: 'direct' })

/** A route of the driver as a plugin route: the `http` option's meta and guards, its body limit unless `GET`. */
function mount(
  route: GraphQLDriverRoute,
  http: Exclude<ResolvedGraphQLOptions['http'], false>,
  driver: GraphQLDriver,
): PluginRoute {
  if (route === null || typeof route !== 'object' || typeof route.handler !== 'function') {
    throw invalidOption(`routes() of the ${driver.name} driver`, 'routes { method, path, name, handler }', route)
  }
  return {
    method: route.method,
    path: route.path,
    name: route.name,
    handler: route.handler,
    ...(http.meta.length === 0 ? {} : { meta: http.meta }),
    ...(http.guards.length === 0 ? {} : { guards: http.guards }),
    ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { bodyLimit: http.bodyLimit }),
  }
}

/** ZNIGHT066 for a driver whose `start()` failed, the original error as `cause`. */
function driverFailed(driver: GraphQLDriver, error: unknown): ZnightError {
  return new ZnightError(ErrorCode.InvalidGraphQLSetup, `GraphQLPlugin: the ${driver.name} driver failed to start`, {
    cause: error,
    hints: ['See the cause: the driver could not create its server'],
  })
}

/** `prefix` (`''`, `/api`) joined with `path` (`/graphql`), without trailing slash: `/api/graphql`. */
function endpointPath(prefix: string, path: string): string {
  const joined = `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+|\/+$/g, '')}`
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined
}

/** The `HttpResponse.sse()` options of GraphQL over SSE (`subscriptions`), `false` when disabled. */
function sseOptions(options: ResolvedGraphQLOptions): SseOptions | false {
  const subscriptions = options.subscriptions
  if (subscriptions === false) return false
  return Object.freeze({
    ...(subscriptions.heartbeat === undefined ? {} : { heartbeat: subscriptions.heartbeat }),
    ...(subscriptions.maxDuration === undefined ? {} : { maxDuration: subscriptions.maxDuration }),
  })
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

/**
 * Resolves providers once at bootstrap: singletons (and registered values) to their instance,
 * request-scoped and transient providers to their token, resolved per use in the current scope.
 */
class Providers {
  readonly #container: Container
  readonly #metadata: ZnightMetadata
  readonly #resolvables = new Map<Token, Resolvable<unknown>>()

  constructor(container: Container, metadata: ZnightMetadata) {
    this.#container = container
    this.#metadata = metadata
  }

  /** A provider token (`@UseGuard`, a resolver), checked to have `method` when its class is known. */
  token<T>(token: Token, what: string, method: string): Resolvable<T> {
    const cls: unknown = Object.hasOwn(this.#metadata.providers, token)
      ? this.#metadata.providers[token]?.class
      : undefined
    if (
      typeof cls === 'function' &&
      typeof (cls.prototype as Record<string, unknown> | undefined)?.[method] !== 'function'
    ) {
      throw new ZnightError(
        ErrorCode.InvalidGraphQLSetup,
        `GraphQLPlugin: the ${what} (${displayName(token)}) has no ${method}() method`,
        {
          hints:
            method === 'canResolve'
              ? ['A GraphQL guard implements GraphQLGuard: canResolve(ctx: ResolverContext)']
              : [],
        },
      )
    }
    return this.#resolvable<T>(token, what)
  }

  /** A global ref: a provider class or an instance with `method`. */
  ref<T>(
    ref: unknown,
    what: string,
    method: string,
  ): { readonly resolvable: Resolvable<T>; readonly cls: unknown; readonly name: string } {
    if (typeof ref === 'function') {
      const token = this.#container.tokenOf(ref as ProviderKey)
      if (token === undefined) {
        const name = (ref as { name?: string }).name || '<anonymous>'
        throw new ZnightError(
          ErrorCode.MissingProvider,
          `GraphQLPlugin: the global ${what} ${name} is not a provider`,
          {
            hints: ['Add @Injectable() to the class, or pass an instance'],
          },
        )
      }
      const prototype: unknown = (ref as { prototype?: unknown }).prototype
      if (typeof (prototype as Record<string, unknown> | undefined)?.[method] !== 'function') {
        throw invalidOption(`${what}s`, `classes with a ${method}() method`, ref)
      }
      return { resolvable: this.#resolvable<T>(token, `global ${what}`), cls: ref, name: displayName(token) }
    }
    const cls: unknown = (ref as { constructor?: unknown }).constructor
    const name = typeof cls === 'function' && cls !== Object ? (cls as { name?: string }).name : undefined
    return { resolvable: { instance: ref as T }, cls, name: name || `${what} instance` }
  }

  #resolvable<T>(token: Token, what: string): Resolvable<T> {
    let found = this.#resolvables.get(token)
    if (found === undefined) {
      found = this.#create(token, what)
      this.#resolvables.set(token, found)
    }
    return found as Resolvable<T>
  }

  #create(token: Token, what: string): Resolvable<unknown> {
    const container = this.#container
    if (!container.has(token)) {
      throw new ZnightError(ErrorCode.MissingProvider, `GraphQLPlugin: the ${what} (${token}) is not a provider`, {
        hints: ['Add @Injectable() to the class (resolvers are providers through @Resolver())'],
      })
    }
    const scope = Object.hasOwn(this.#metadata.providers, token) ? this.#metadata.providers[token]?.scope : undefined
    if (scope === 'request' || scope === 'transient') return { token }
    try {
      return { instance: container.get(token) }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === ErrorCode.NoActiveScope) return { token }
      throw error
    }
  }
}

/**
 * The `PubSub` registered when the options are a function of the container (they are only known
 * after `container.init()`): delegates to the plugin's `PubSub`, resolved on first use.
 */
class DeferredPubSub extends PubSub {
  readonly #target: () => PubSub

  constructor(target: () => PubSub) {
    super()
    this.#target = target
  }

  publish(topic: string, payload: unknown): Promise<void> {
    return this.#target().publish(topic, payload)
  }

  subscribe(topic: string, options?: { readonly signal?: AbortSignal }): AsyncIterableIterator<unknown> {
    return this.#target().subscribe(topic, options)
  }
}
