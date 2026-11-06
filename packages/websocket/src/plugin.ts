/**
 * `WebSocketPlugin` (RFC 0003 §5.9, §8.9): serves the gateways of `metadata.extensions.websocket`
 * through the upgrade routes of `HttpPlugin`. The handshake runs through the HTTP pipeline (request
 * scope, hooks, guards); the plugin adds the origin, subprotocol and capacity checks, completes the
 * upgrade with a transport, and keeps the request scope open for the lifetime of the connection.
 */
import type {
  Container,
  Plugin,
  PluginContext,
  PluginOptions,
  PluginRootsContext,
  ProviderKey,
  Token,
  WebSocketConnectionEvent,
  ZnightMetadata,
} from '@znight/core'
import type {
  HttpContext,
  HttpMetadata,
  HttpPlugin,
  PendingUpgrade,
  PluginHttpUpgrades,
  PluginHttpUpgradesContext,
  PluginUpgradeRoute,
  PluginUpgrades,
  RouteMetaEntry,
} from '@znight/http'
import type { WsConnectOptions } from './client.ts'
import type { ConnectionLimits, WsCloseInfo, WsStats } from './connection.ts'
import type { WsExceptionMapper, WsGuard } from './context.ts'
import type { HandlerPlan } from './dispatcher.ts'
import type { GatewayDefinition, WebSocketMetadata } from './metadata.ts'
import type { ResolvedWebSocketOptions, WebSocketPluginOptions } from './options.ts'
import type { SocketEvents, WebSocketTransport } from './transport.ts'

import { AsyncLocalStorage } from 'node:async_hooks'
import { displayName, ErrorCode, resolveOptions, ZnightError } from '@znight/core'
import { BadRequestException, ForbiddenException, HttpException } from '@znight/http'

import { WsClient, WsHandshakeError } from './client.ts'
import { StatsCounter, WsConnectionImpl } from './connection.ts'
import { GatewayDispatcher } from './dispatcher.ts'
import { resolveWebSocketOptions } from './options.ts'
import { TokenBucket } from './rate-limit.ts'
import { RoomRegistry } from './rooms.ts'
import { WsServer } from './server.ts'
import { WsTokens } from './tokens.ts'
import { bunTransport } from './transports/bun.ts'
import { MemoryClient, memoryTransport } from './transports/memory.ts'
import { wsTransport } from './transports/ws.ts'

/** A served gateway, as listed by {@link WebSocketPlugin.gateways}. */
export interface WsGatewaySummary {
  /** The path, HTTP prefix included. */
  readonly path: string
  /** Display name of the gateway class. */
  readonly gateway: string
  readonly protocol: 'events' | 'raw'
  /** Handled events (`events` gateways), in declaration order. */
  readonly events: readonly string[]
}

/** One gateway, ready to accept connections (internal). */
interface GatewayPlan {
  readonly definition: GatewayDefinition
  readonly name: string
  /** Path, HTTP prefix included. */
  readonly path: string
  readonly rooms: RoomRegistry<WsConnectionImpl>
  readonly dispatcher: GatewayDispatcher
  readonly maxPayload: number
  readonly limits: ConnectionLimits
  readonly rateLimit: GatewayDefinition['rateLimit']
  readonly instance: (conn: WsConnectionImpl) => object | Promise<object>
  readonly requestScoped: boolean
}

type ContextRunner = <R>(fn: () => R) => R

/** The current async context (the handshake's request scope), to run the socket events in it. */
function captureContext(): ContextRunner {
  const snapshot = (AsyncLocalStorage as { snapshot?: () => ContextRunner }).snapshot
  return typeof snapshot === 'function' ? snapshot() : run => run()
}

const CONNECTION_HOOK = 'websocket:connection'

/**
 * The WebSocket plugin: `WebSocketPlugin.configure(options)` (name `websocket`). Requires
 * `HttpPlugin`: gateways are served on its server and port, whatever the plugin order.
 *
 * ```ts
 * await Application.create({
 *   metadata: __ZNIGHT_METADATA__,
 *   plugins: [HttpPlugin.configure({ port: 3000 }), WebSocketPlugin.configure({ maxPayload: '64kb' })],
 * })
 * ```
 */
export class WebSocketPlugin implements Plugin, PluginHttpUpgrades {
  readonly name = 'websocket'
  /** The `WsServer` of the application (also injectable). */
  readonly server: WsServer = new WsServer()
  readonly #options: PluginOptions<WebSocketPluginOptions>
  readonly #connections = new Map<WsConnectionImpl, number>()
  /** Connections whose heartbeat the plugin drives (the `ws` transport). */
  readonly #beating = new Set<WsConnectionImpl>()
  #stats = new StatsCounter()
  #ctx: PluginContext | undefined
  #resolved: ResolvedWebSocketOptions | undefined
  #plans: readonly GatewayPlan[] | undefined
  #transport: WebSocketTransport | undefined
  #memory: WebSocketTransport | undefined
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #draining = false
  #drain: Promise<void> | undefined
  #active = false

  private constructor(options: PluginOptions<WebSocketPluginOptions>) {
    this.#options = options
  }

  /**
   * Creates the plugin. `options` may be a function of the container, evaluated once the container
   * is initialised: `WebSocketPlugin.configure(c => ({ origins: c.get(ServerConfig).webOrigins }))`.
   */
  static configure(options: PluginOptions<WebSocketPluginOptions> = {}): WebSocketPlugin {
    return new WebSocketPlugin(options)
  }

  /** Name of the transport (`ws`, `bun`), `undefined` before `HttpPlugin` collected the upgrade routes. */
  get transport(): string | undefined {
    return this.#transport?.name
  }

  /** The served gateways (after bootstrap). */
  get gateways(): readonly WsGatewaySummary[] {
    return (this.#plans ?? []).map(plan =>
      Object.freeze({
        path: plan.path,
        gateway: plan.name,
        protocol: plan.definition.protocol,
        events: Object.freeze(plan.definition.handlers.flatMap(handler => handler.event ?? [])),
      }),
    )
  }

  /** Open connections of every gateway. */
  get connections(): number {
    return this.#connections.size
  }

  /** Totals since the application started. */
  stats(): WsStats {
    return this.#stats.snapshot(this.#connections.size)
  }

  /**
   * Providers `TestApp` creates at boot: the classes of the `messageGuards` and `exceptionMappers`
   * options, and the gateways of the metadata with their guards.
   */
  initRoots(context?: PluginRootsContext): readonly ProviderKey[] {
    const roots = new Set<ProviderKey>()
    try {
      const options: unknown = this.#options
      if (options !== null && typeof options === 'object') {
        for (const key of ['messageGuards', 'exceptionMappers'] as const) {
          const refs: unknown = (options as WebSocketPluginOptions)[key]
          if (Array.isArray(refs)) for (const ref of refs) if (typeof ref === 'function') roots.add(ref as ProviderKey)
        }
      }
      const gateways: unknown = (context?.metadata.extensions?.websocket as { gateways?: unknown } | undefined)
        ?.gateways
      if (Array.isArray(gateways)) {
        for (const gateway of gateways as Partial<GatewayDefinition>[]) {
          if (typeof gateway?.token !== 'string') continue
          roots.add(gateway.token)
          const handlers = Array.isArray(gateway.handlers) ? gateway.handlers : []
          const tokens = [
            ...(gateway.handshakeGuards ?? []),
            ...(gateway.messageGuards ?? []),
            ...handlers.flatMap(handler => handler?.guards ?? []),
          ]
          for (const token of tokens) if (typeof token === 'string') roots.add(token)
        }
      }
    } catch {
      // initRoots never throws: onBootstrap reports malformed options and metadata
    }
    return [...roots]
  }

  register(ctx: PluginContext): void {
    if (this.#active) {
      throw new ZnightError(
        ErrorCode.DuplicateProvider,
        'This WebSocketPlugin is already used by another application',
        {
          hints: ['Call WebSocketPlugin.configure() once per application'],
        },
      )
    }
    if (ctx.getPlugin('http') === undefined) {
      throw new ZnightError(
        ErrorCode.WebSocketTransportUnavailable,
        'WebSocketPlugin needs HttpPlugin: gateways are served by the HTTP server',
        { hints: ['Add HttpPlugin.configure() to the plugins (without controllers for a WebSocket-only service)'] },
      )
    }
    this.#active = true
    this.#ctx = ctx
    this.#resolved = undefined
    this.#plans = undefined
    this.#transport = undefined
    this.#memory = undefined
    this.#draining = false
    this.#drain = undefined
    this.#stats = new StatsCounter()
    this.server.reset()
    ctx.container.registerExternal({ token: WsTokens.Connection, scope: 'request', providedBy: 'WebSocketPlugin' })
    ctx.container.registerValue(WsTokens.Server, this.server)
    ctx.container.registerValue(WsTokens.Plugin, this)
  }

  onBootstrap(ctx: PluginContext): void {
    this.#ctx = ctx
    this.#resolve()
    gatewaysOf(ctx.metadata)
  }

  /**
   * The `PluginHttpUpgrades` contract of `@znight/http`: one upgrade route per gateway, and the
   * `Bun.serve()` settings of the Bun transport. Called once by `HttpPlugin.onBootstrap`. No route
   * (and no transport) without gateways.
   */
  httpUpgrades(context: PluginHttpUpgradesContext): PluginUpgrades {
    const plans = this.#prepare(context)
    if (plans.length === 0) return { routes: [] }
    const extensions = this.#context().metadata.extensions
    const groups = {
      ...(extensions?.http as HttpMetadata | undefined)?.groups,
      ...(extensions?.websocket as WebSocketMetadata | undefined)?.groups,
    }
    const options = this.#resolve()
    const routes = plans.map(
      (plan): PluginUpgradeRoute => ({
        path: plan.definition.path,
        name: plan.name,
        owner: plan.definition.token,
        meta: metaEntries(plan.definition.meta, groups),
        guards: plan.definition.handshakeGuards,
        timeoutMs: options.handshakeTimeoutMs,
        precheck: ctx => this.#precheck(plan, ctx),
        accept: (ctx, upgrade) => this.#accept(plan, ctx, upgrade),
      }),
    )
    const bunWebSocket = this.#transport?.bunWebSocket?.()
    return bunWebSocket === undefined ? { routes } : { routes, bunWebSocket }
  }

  async onStart(): Promise<void> {
    const transport = this.#transport
    if (transport === undefined) return
    await transport.ready?.()
    const intervalMs = this.#resolve().heartbeatMs
    if (intervalMs > 0 && transport.accepts === 'node') {
      this.#heartbeat = setInterval(() => {
        for (const conn of this.#beating) conn.heartbeat()
      }, intervalMs)
      this.#heartbeat.unref?.()
    }
  }

  /**
   * The `PluginHttpRoutes` contract: `HttpPlugin` starts draining, whatever the plugin order.
   * Refuses new handshakes and closes every connection gracefully (see {@link onStop}).
   */
  onHttpDrain(): Promise<void> {
    return this.#shutdown()
  }

  /**
   * Refuses handshakes (`503`), closes every connection with `shutdown.code`, waits for close
   * frames, running handlers and `@OnDisconnect` up to `shutdown.timeoutMs`, then terminates the
   * rest. Idempotent: the same drain as {@link onHttpDrain}.
   */
  onStop(): Promise<void> {
    return this.#shutdown()
  }

  async onDispose(): Promise<void> {
    this.#stopHeartbeat()
    try {
      // an application that never started (in-memory tests) still closes its connections gracefully
      await this.#shutdown()
      await Promise.all([this.#transport?.close(), this.#memory?.close()])
    } finally {
      this.#active = false
      this.#beating.clear()
      this.#connections.clear()
      this.#plans = undefined
    }
  }

  /**
   * Opens an in-memory connection (tests): the real handshake through the HTTP pipeline (guards,
   * hooks, origin and subprotocol checks) with an in-memory request, then the in-memory transport.
   * `path` is the URL path, HTTP prefix included. Rejects with {@link WsHandshakeError} when the
   * handshake is refused.
   *
   * ```ts
   * await using alice = await plugin.connect('/chat', { protocols: ['chat.v1'] })
   * expect(await alice.request('room.join', { room: 'general' })).toEqual({ members: 1 })
   * ```
   */
  async connect(path: string, options: WsConnectOptions = {}): Promise<WsClient> {
    const http = this.#ctx?.getPlugin<HttpPlugin>('http')
    if (http === undefined || this.#plans === undefined) {
      throw new ZnightError(ErrorCode.LifecycleFailed, 'WebSocketPlugin is not bootstrapped yet', {
        hints: ['connect() is available once Application.create() resolved'],
      })
    }
    const headers: Record<string, string> = { ...options.headers }
    if (options.protocols !== undefined && options.protocols.length > 0) {
      headers['sec-websocket-protocol'] = options.protocols.join(', ')
    }
    if (options.origin !== undefined) headers['origin'] = options.origin
    const peer = new MemoryClient()
    const refused = await http.upgradeInMemory(
      {
        method: 'GET',
        url: path,
        headers,
        ...(options.query === undefined ? {} : { query: options.query }),
        ...(options.cookies === undefined ? {} : { cookies: options.cookies }),
      },
      { kind: 'memory', peer },
    )
    if (refused !== undefined) throw new WsHandshakeError(refused)
    return new WsClient(peer)
  }

  // ------------------------------------------------------------------------------------------------

  #context(): PluginContext {
    const ctx = this.#ctx
    if (ctx === undefined) {
      throw new ZnightError(ErrorCode.LifecycleFailed, 'WebSocketPlugin is not registered in an application')
    }
    return ctx
  }

  #resolve(): ResolvedWebSocketOptions {
    if (this.#resolved !== undefined) return this.#resolved
    const container: Container = this.#context().container
    this.#resolved = resolveWebSocketOptions(resolveOptions(this.#options, container))
    return this.#resolved
  }

  /** Builds the gateway plans and selects the transport, once. */
  #prepare(context: PluginHttpUpgradesContext): readonly GatewayPlan[] {
    if (this.#plans !== undefined) return this.#plans
    const ctx = this.#context()
    const options = this.#resolve()
    const definitions = gatewaysOf(ctx.metadata)
    if (definitions.length === 0) {
      this.#plans = []
      return this.#plans
    }
    const transport = selectTransport(options, context)
    let maxPayload = options.maxPayload
    let backpressureLimit = options.backpressure.limit
    for (const definition of definitions) {
      maxPayload = Math.max(maxPayload, definition.maxPayload ?? 0)
      backpressureLimit = Math.max(backpressureLimit, definition.backpressure?.limit ?? 0)
    }
    transport.configure({ maxPayload, backpressureLimit, heartbeatMs: options.heartbeatMs })
    this.#transport = transport
    const refs = new Refs(ctx.container, ctx.metadata)
    const globalGuards = options.messageGuards.map(ref => refs.guard(ref, 'global message guard'))
    const mappers = options.exceptionMappers.map(ref => refs.mapper(ref))
    const plans = definitions.map(definition => {
      const name = displayName(definition.token)
      const path = joinPath(context.prefix, definition.path)
      const classGuards = definition.messageGuards.map(token => refs.guard(token, `message guard of ${name}`))
      const handlers: HandlerPlan[] = definition.handlers.map(handler => ({
        definition: handler,
        guards: [
          ...globalGuards,
          ...classGuards,
          ...handler.guards.map(token => refs.guard(token, `message guard of ${name}.${handler.method}`)),
        ],
        meta: Object.freeze({ ...definition.meta, ...handler.meta }),
      }))
      const requestScoped = ctx.metadata.providers[definition.token]?.scope === 'request'
      const instance = gatewayInstance(ctx.container, definition.token, requestScoped)
      const rooms = new RoomRegistry<WsConnectionImpl>(options.codec)
      const backpressure = definition.backpressure
      const gatewayMaxPayload = definition.maxPayload ?? options.maxPayload
      const plan: GatewayPlan = {
        definition,
        name,
        path,
        rooms,
        maxPayload: gatewayMaxPayload,
        limits: {
          maxPayload: gatewayMaxPayload,
          maxPendingMessages: options.maxPendingMessages,
          concurrency: definition.concurrency ?? 1,
          backpressureLimit: backpressure?.limit ?? options.backpressure.limit,
          onBackpressure: backpressure?.onLimit ?? options.backpressure.onLimit,
          closeTimeoutMs: options.closeTimeoutMs,
        },
        rateLimit: definition.rateLimit,
        instance,
        requestScoped,
        dispatcher: new GatewayDispatcher({
          definition,
          path,
          handlers,
          instance,
          handlerTimeoutMs: options.handlerTimeoutMs,
          exposeErrors: options.exposeErrors,
          hooks: ctx.hooks,
          name,
          mappers,
          codec: options.codec,
          ...(process.env['NODE_ENV'] === 'production'
            ? {}
            : {
                ignoredResult: (handler: string, event: string | undefined) =>
                  ctx.logger.debug(
                    `WebSocketPlugin: the result of ${name}.${handler} is ignored: "${event}" was sent without id (fire and forget)`,
                    { gateway: name, handler, event },
                  ),
              }),
          logError: (message, error, conn) => {
            ctx.logger.error(`WebSocketPlugin: ${message}`, {
              err: error,
              gateway: name,
              path,
              connectionId: conn.id,
              requestId: conn.requestId,
            })
          },
          closed: (conn, info) => this.#closed(plan, conn, info),
        }),
      }
      this.server.register({
        type: classOf(ctx.metadata, definition.token),
        declaredPath: definition.path,
        path,
        rooms,
      })
      return plan
    })
    this.#plans = plans
    ctx.logger.debug('WebSocket gateways ready', { gateways: plans.length, transport: transport.name })
    return plans
  }

  /** Origin, subprotocol and capacity checks, before the guards. */
  async #precheck(plan: GatewayPlan, ctx: HttpContext): Promise<void> {
    if (this.#draining) throw unavailable('The server is shutting down')
    const options = this.#resolve()
    const origin = ctx.header('origin')
    if (origin !== undefined) {
      let allowed = false
      try {
        allowed = (await options.origins.allows(origin, ctx)) === true
      } catch {
        allowed = false
      }
      if (!allowed) throw new ForbiddenException('Origin not allowed')
    }
    selectProtocol(plan, ctx)
    if (this.#connections.size >= options.maxConnections) throw unavailable('Too many WebSocket connections')
  }

  /** After the guards: completes the upgrade and starts the connection in the handshake's scope. */
  async #accept(plan: GatewayPlan, ctx: HttpContext, upgrade: PendingUpgrade): Promise<void> {
    if (this.#draining) throw unavailable('The server is shutting down')
    const ws = this.#context()
    const protocol = selectProtocol(plan, ctx)
    const rate = plan.rateLimit
    const conn = new WsConnectionImpl({
      id: crypto.randomUUID(),
      gateway: plan.path,
      handshake: ctx,
      protocol,
      limits:
        rate === undefined
          ? plan.limits
          : {
              ...plan.limits,
              rateLimit: { bucket: new TokenBucket(rate.messages, rate.intervalMs), onLimit: rate.onLimit },
            },
      rooms: plan.rooms,
      driver: plan.dispatcher,
      stats: this.#stats,
    })
    ws.container.currentScope()?.set(WsTokens.Connection, conn)
    // a request-scoped gateway is created at the handshake: a factory error answers 500
    if (plan.requestScoped) await plan.instance(conn)
    const memory = upgrade.native.kind === 'memory'
    let transport = this.#transport as WebSocketTransport
    if (memory) {
      this.#memory ??= memoryTransport()
      transport = this.#memory
    }
    const run = captureContext()
    const events = conn.socketEvents()
    // socket events arrive outside of any async context: dispatch them in the connection's scope
    const scoped: SocketEvents = {
      message: (frame, binary) => run(() => events.message(frame, binary)),
      pong: () => events.pong(),
      drain: () => events.drain(),
      close: (code, reason) => run(() => events.close(code, reason)),
    }
    const socket = await transport.accept(
      upgrade.native,
      { protocol, headers: upgrade.headers, maxPayload: plan.maxPayload },
      scoped,
    )
    const openedAt = performance.now()
    this.#connections.set(conn, openedAt)
    if (!memory && transport.accepts === 'node') this.#beating.add(conn)
    this.#stats.opened++
    if (ws.hooks.hasListeners(CONNECTION_HOOK)) {
      ws.hooks.emit(CONNECTION_HOOK, connectionEvent('open', plan, conn, openedAt, undefined))
    }
    conn.start(socket)
    upgrade.hold(conn.finished)
  }

  /** A connection fully closed (after `@OnDisconnect`, rooms left). */
  #closed(plan: GatewayPlan, conn: WsConnectionImpl, info: WsCloseInfo): void {
    const openedAt = this.#connections.get(conn) ?? performance.now()
    this.#connections.delete(conn)
    this.#beating.delete(conn)
    this.#stats.closed++
    const hooks = this.#ctx?.hooks
    if (hooks?.hasListeners(CONNECTION_HOOK)) {
      hooks.emit(CONNECTION_HOOK, connectionEvent('close', plan, conn, openedAt, info))
    }
  }

  #shutdown(): Promise<void> {
    this.#drain ??= this.#closeAll()
    return this.#drain
  }

  async #closeAll(): Promise<void> {
    this.#draining = true
    this.#stopHeartbeat()
    const options = this.#resolved
    const connections = [...this.#connections.keys()]
    if (options === undefined || connections.length === 0) return
    const { code, reason, timeoutMs } = options.shutdown
    for (const conn of connections) conn.closeWith(code, reason, 'shutdown')
    const all = Promise.all(connections.map(conn => conn.finished))
    if (await within(all, timeoutMs)) return
    for (const conn of connections) if (conn.readyState !== 'closed') conn.terminateWith('shutdown')
    await within(all, options.closeTimeoutMs)
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
  }
}

/** Resolves when `task` settles (`true`) or after `ms` (`false`). */
async function within(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([task.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function unavailable(message: string): HttpException {
  return new HttpException(503, message, undefined, { headers: { 'retry-after': '1' } })
}

function connectionEvent(
  type: 'open' | 'close',
  plan: GatewayPlan,
  conn: WsConnectionImpl,
  openedAt: number,
  info: WsCloseInfo | undefined,
): WebSocketConnectionEvent {
  return {
    type,
    gateway: plan.name,
    path: plan.path,
    connectionId: conn.id,
    requestId: conn.requestId,
    connection: conn,
    openedAt,
    ...(info === undefined ? {} : { code: info.code, reason: info.reason, initiator: info.initiator }),
  }
}

/** The subprotocol of a handshake: the first of the gateway's `protocols` the client offers (400 otherwise). */
function selectProtocol(plan: GatewayPlan, ctx: HttpContext): string {
  const accepted = plan.definition.protocols
  if (accepted === undefined || accepted.length === 0) return ''
  const offered = (ctx.header('sec-websocket-protocol') ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
  const selected = accepted.find(protocol => offered.includes(protocol))
  if (selected === undefined) throw new BadRequestException('Unsupported WebSocket subprotocol')
  return selected
}

/** The transport of the `transport` option for the native upgrades of the adapter (ZNIGHT051). */
function selectTransport(options: ResolvedWebSocketOptions, context: PluginHttpUpgradesContext): WebSocketTransport {
  const kind = context.upgrades
  if (kind === undefined) {
    throw new ZnightError(
      ErrorCode.WebSocketTransportUnavailable,
      `WebSocketPlugin: the ${context.adapter} adapter cannot serve WebSocket upgrades`,
      { hints: ['Use a built-in adapter (node, fastify, express, hono) on a server Znight starts'] },
    )
  }
  let transport = options.transport
  if (transport === 'auto') transport = kind === 'bun' ? bunTransport() : wsTransport()
  if (transport.accepts !== kind) {
    throw new ZnightError(
      ErrorCode.WebSocketTransportUnavailable,
      `WebSocketPlugin: the ${transport.name} transport completes ${transport.accepts} upgrades, but the ${context.adapter} adapter produces ${kind} upgrades`,
      {
        hints:
          kind === 'bun'
            ? ["Use bunTransport() (or transport: 'auto') with honoAdapter() on Bun"]
            : ["Use wsTransport() (or transport: 'auto') with the node:http adapters"],
      },
    )
  }
  return transport
}

/** `prefix` (`''`, `/api`) joined with a normalized gateway path (`/chat`, `/`). */
function joinPath(prefix: string, path: string): string {
  if (prefix === '' || prefix === '/') return path
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return path === '/' ? base : `${base}${path}`
}

/** Route decorator metadata as upgrade route entries, with the groups of `metadata.extensions.http`. */
function metaEntries(
  meta: Readonly<Record<string, unknown>>,
  groups: NonNullable<HttpMetadata['groups']>,
): RouteMetaEntry[] {
  return Object.keys(meta)
    .sort()
    .map(key => {
      for (const [group, definition] of Object.entries(groups)) {
        if (definition.keys.includes(key)) return { key, value: meta[key], group, required: definition.required }
      }
      return { key, value: meta[key] }
    })
}

function classOf(metadata: ZnightMetadata, token: Token): abstract new (...args: never[]) => object {
  return metadata.providers[token]?.class as abstract new (
    ...args: never[]
  ) => object
}

/** The gateway instance of a connection: the singleton, or the request-scoped one of its handshake. */
function gatewayInstance(
  container: Container,
  token: Token,
  requestScoped: boolean,
): (conn: WsConnectionImpl) => object | Promise<object> {
  if (requestScoped) return () => container.get(token) as object | Promise<object>
  let instance: object | undefined
  return () => {
    instance ??= container.get(token) as object
    return instance
  }
}

/** `metadata.extensions.websocket`, checked (ZNIGHT050): `[]` without gateways. */
function gatewaysOf(metadata: ZnightMetadata): readonly GatewayDefinition[] {
  const section: unknown = metadata.extensions?.websocket
  if (section === undefined) return []
  const gateways = (section as Partial<WebSocketMetadata> | null)?.gateways
  if (!Array.isArray(gateways)) throw malformed('"gateways" must be an array')
  for (const gateway of gateways as Partial<GatewayDefinition>[]) {
    const where = typeof gateway?.token === 'string' ? gateway.token : JSON.stringify(gateway)
    if (gateway === null || typeof gateway !== 'object' || typeof gateway.token !== 'string') {
      throw malformed(`invalid gateway ${where}`)
    }
    if (!Object.hasOwn(metadata.providers, gateway.token)) {
      throw malformed(`the gateway ${where} is not a provider of the metadata`)
    }
    if (typeof gateway.path !== 'string' || !gateway.path.startsWith('/')) throw malformed(`invalid path of ${where}`)
    if (gateway.protocol !== 'events' && gateway.protocol !== 'raw') throw malformed(`invalid protocol of ${where}`)
    if (
      !Array.isArray(gateway.handlers) ||
      !Array.isArray(gateway.handshakeGuards) ||
      !Array.isArray(gateway.messageGuards)
    ) {
      throw malformed(`handlers, handshakeGuards and messageGuards of ${where} must be arrays`)
    }
    for (const lifecycle of [gateway.onConnect, gateway.onDisconnect]) {
      if (lifecycle !== undefined && typeof lifecycle?.invoke !== 'function') {
        throw malformed(`invalid lifecycle handler of ${where}`)
      }
    }
    for (const handler of gateway.handlers) {
      if (
        handler === null ||
        typeof handler !== 'object' ||
        typeof handler.invoke !== 'function' ||
        !Array.isArray(handler.guards)
      ) {
        throw malformed(`invalid handler of ${where}`)
      }
    }
  }
  return gateways as GatewayDefinition[]
}

function malformed(reason: string): ZnightError {
  return new ZnightError(
    ErrorCode.InvalidGateway,
    `WebSocketPlugin: malformed metadata.extensions.websocket: ${reason}`,
    {
      hints: ['Regenerate the container module (znight generate) with the same @znight/websocket version'],
    },
  )
}

/**
 * Message guards and exception mappers resolved once at bootstrap: singletons to their instance,
 * request-scoped and transient providers per call, in the connection's scope.
 */
class Refs {
  readonly #container: Container
  readonly #metadata: ZnightMetadata

  constructor(container: Container, metadata: ZnightMetadata) {
    this.#container = container
    this.#metadata = metadata
  }

  guard(ref: unknown, what: string): WsGuard {
    const resolve = this.#resolve<WsGuard>(ref, what, 'canHandle')
    return typeof resolve === 'function' ? { canHandle: ctx => resolve().canHandle(ctx) } : resolve
  }

  mapper(ref: unknown): WsExceptionMapper {
    const resolve = this.#resolve<WsExceptionMapper>(ref, 'exception mapper', 'map')
    return typeof resolve === 'function' ? { map: (error, ctx) => resolve().map(error, ctx) } : resolve
  }

  /** The instance, or a function resolving it per call (request-scoped and transient providers). */
  #resolve<T extends object>(ref: unknown, what: string, method: string): T | (() => T) {
    if (typeof ref !== 'function' && typeof ref !== 'string') return ref as T
    const token = typeof ref === 'string' ? ref : this.#container.tokenOf(ref as ProviderKey)
    if (token === undefined || !this.#container.has(token)) {
      const name = typeof ref === 'string' ? displayName(ref) : (ref as { name?: string }).name || '<anonymous>'
      throw new ZnightError(ErrorCode.MissingProvider, `WebSocketPlugin: the ${what} ${name} is not a provider`, {
        hints: ['Add @Injectable() to the class, or pass an instance'],
      })
    }
    const definition = Object.hasOwn(this.#metadata.providers, token) ? this.#metadata.providers[token] : undefined
    const cls: unknown = definition?.class
    if (typeof cls === 'function' && typeof (cls.prototype as Record<string, unknown>)?.[method] !== 'function') {
      throw new ZnightError(
        ErrorCode.InvalidGateway,
        `WebSocketPlugin: the ${what} ${displayName(token)} has no ${method}() method`,
      )
    }
    const scope = definition?.scope
    if (scope === 'request' || scope === 'transient') return () => this.#container.get(token) as T
    return this.#container.get(token) as T
  }
}
