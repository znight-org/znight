/**
 * Upgrade routes (RFC 0003 §8.2): WebSocket handshakes served by `HttpPlugin` on behalf of another
 * plugin (`@znight/websocket`). The handshake is an HTTP request: it runs through the pipeline
 * (`http:request` hook, request scope, global guards, the route's guards, exception mappers), then
 * the plugin's `accept` takes the connection. The request scope stays open until the connection
 * closes.
 *
 * Upgrade routes live in their own route table, consulted only for upgrade requests: they never
 * change the ordinary routing, and a page and its socket may share a path.
 */
import type { Token } from '@znight/core'
import type { AdapterReply, AdapterRequest } from './adapter.ts'
import type { HttpContext } from './context.ts'
import type { RouteMetaEntry } from './decorators.ts'
import type { HeaderValue } from './exceptions.ts'
import type { GuardRef } from './plugin.ts'
import type { NormalizedMetaEntry, PluginHttpRoutesContext } from './plugin-routes.ts'

import { ErrorCode, ZnightError } from '@znight/core'

import { isGroupOf } from './decorators.ts'
import { BadRequestException, HttpException } from './exceptions.ts'
import { joinPaths, normalizePath, parseRoutePath, type RoutePath, RoutePathError } from './path.ts'

/**
 * The upgrade of a `node:http` server (`'upgrade'` event): every adapter built on `node:http`
 * (`node`, `express`, `fastify`, `hono` on Node.js), on Node.js and on Bun.
 */
export interface NodeUpgrade {
  readonly kind: 'node'
  /** The `IncomingMessage` of the handshake. */
  readonly request: unknown
  /** The `net.Socket` (a `Duplex`) of the connection. */
  readonly socket: unknown
  /** The first bytes after the handshake headers. */
  readonly head: Uint8Array
}

/** The upgrade of a `Bun.serve()` server (`honoAdapter()` on Bun). */
export interface BunUpgrade {
  readonly kind: 'bun'
  /** The Fetch `Request` of the handshake. */
  readonly request: Request
  /** The `Bun.serve()` server (`server.upgrade(request, { data, headers })`). */
  readonly server: unknown
}

/** An in-memory upgrade (`HttpPlugin.upgradeInMemory()`, tests): `peer` belongs to the caller. */
export interface MemoryUpgrade {
  readonly kind: 'memory'
  readonly peer: unknown
}

/** The native side of an upgrade request, completed by a transport. */
export type NativeUpgrade = NodeUpgrade | BunUpgrade | MemoryUpgrade

/** What {@link PluginUpgradeRoute.accept} receives to complete the handshake. */
export interface PendingUpgrade {
  readonly native: NativeUpgrade
  /**
   * Headers of the `101` response: the headers and cookies the guards set on the context, the
   * request id and the security headers are not included (they are HTTP response headers); read
   * once, when the transport completes the handshake.
   */
  readonly headers: Readonly<Record<string, HeaderValue>>
  /**
   * The handshake timed out and was answered `408`: the transport must not complete it. Check it
   * after every `await`, right before completing the handshake.
   */
  readonly expired: boolean
  /**
   * The client closed its connection before the handshake completed (`ctx.signal` aborted with the
   * kind `client`): the transport must not complete it. Check it like {@link expired}.
   */
  readonly disconnected: boolean
  /**
   * Keeps the request scope (and the in-flight count of `HttpPlugin`) open until `closed`
   * settles: the connection lives in the scope of its handshake. Call it once, after the transport
   * completed the handshake. From then on, the connection closing no longer aborts `ctx.signal`.
   */
  hold(closed: Promise<unknown>): void
}

/**
 * A route answering upgrade requests (`GET` with `upgrade: websocket`), declared by another plugin
 * through {@link PluginHttpUpgrades.httpUpgrades}.
 */
export interface PluginUpgradeRoute {
  /** Path relative to the `HttpPlugin` prefix, with the route grammar (`/chat`, `/docs/:docId`). */
  readonly path: string
  /** Name of the route (the gateway), shown in `HttpPlugin.routes`, logs and errors. */
  readonly name: string
  /** `ctx.route.controller` during the handshake (the gateway token). Default: the plugin name. */
  readonly owner?: Token
  /** Route metadata (`ctx.route.meta`), one entry per group, checked at boot like plugin routes. */
  readonly meta?: readonly RouteMetaEntry[]
  /** Guards of the handshake (classes, instances or provider tokens), after the global guards. */
  readonly guards?: readonly (GuardRef | Token)[]
  /** Time the handshake gets before it is answered `408` (ms). Default: none. */
  readonly timeoutMs?: number
  /**
   * Cheap checks before the guards (origin, subprotocols, capacity), after the protocol checks of
   * RFC 6455. Throw an `HttpException` to refuse.
   */
  precheck?(ctx: HttpContext): void | Promise<void>
  /** After the guards: take the connection. Throw an `HttpException` to refuse. */
  accept(ctx: HttpContext, upgrade: PendingUpgrade): void | Promise<void>
}

/** What {@link PluginHttpUpgrades.httpUpgrades} returns. */
export interface PluginUpgrades {
  readonly routes: readonly PluginUpgradeRoute[]
  /**
   * Server-wide settings of the `websocket` option of `Bun.serve()` (`maxPayloadLength`,
   * `idleTimeout`, `backpressureLimit`, `sendPings`, `perMessageDeflate`...), used by adapters
   * serving with `Bun.serve()`. The handlers are set by `HttpPlugin`: they dispatch every event to
   * the `data` given to `server.upgrade()`, a {@link BunSocketHandlers}.
   */
  readonly bunWebSocket?: Readonly<Record<string, unknown>>
}

/** What {@link PluginHttpUpgrades.httpUpgrades} receives. */
export interface PluginHttpUpgradesContext extends PluginHttpRoutesContext {
  /** Name of the adapter (`node`, `fastify`...). */
  readonly adapter: string
  /**
   * The native upgrades the adapter produces (`node`: a `node:http` server, `bun`: `Bun.serve()`),
   * `undefined` when the adapter cannot upgrade connections.
   */
  readonly upgrades: 'node' | 'bun' | undefined
}

/**
 * Implemented, next to {@link PluginHttpRoutes}, by a plugin that accepts WebSocket connections
 * (`@znight/websocket`). `HttpPlugin` calls `httpUpgrades()` once in its `onBootstrap`, after
 * `httpRoutes()`, whatever the plugin order, and asks its adapter to route the matching upgrade
 * requests to the pipeline. `onHttpDrain()` is where the plugin closes its connections.
 */
export interface PluginHttpUpgrades {
  httpUpgrades(context: PluginHttpUpgradesContext): PluginUpgrades
}

/**
 * The `data` a transport gives to `server.upgrade()` on `Bun.serve()`: `HttpPlugin` dispatches
 * every event of the socket to it.
 */
export interface BunSocketHandlers {
  open(ws: unknown): void
  message(ws: unknown, message: string | Uint8Array): void
  close(ws: unknown, code: number, reason: string): void
  drain(ws: unknown): void
  pong?(ws: unknown): void
}

/** What `HttpPlugin` gives to {@link AdapterUpgrades.enable}. */
export interface UpgradeHandlerOptions {
  /** Whether an upgrade request to the raw `path` (no query string) is for Znight. */
  match(path: string): boolean
  /**
   * Runs the handshake through the pipeline. Resolves with the refusal to write (an HTTP response),
   * or `undefined` once the transport took the connection. Never rejects.
   */
  handle(request: AdapterRequest, native: NodeUpgrade | BunUpgrade): Promise<AdapterReply | undefined>
  /** The `websocket` option of `Bun.serve()` (settings and dispatching handlers), Bun adapters only. */
  readonly bunWebSocket: Readonly<Record<string, unknown>>
}

/** The optional upgrade capability of an adapter (RFC 0003 §8.2.3). */
export interface AdapterUpgrades {
  /** The native upgrades the adapter produces. */
  readonly kind: 'node' | 'bun'
  /** Called once, before `listen()`, when the application has upgrade routes. */
  enable(options: UpgradeHandlerOptions): void
}

/** A validated upgrade route (internal). */
export interface CollectedUpgradeRoute {
  readonly plugin: string
  readonly instance: object
  readonly path: RoutePath
  readonly relativePath: string
  readonly name: string
  readonly owner: Token
  readonly meta: readonly NormalizedMetaEntry[]
  readonly guards: readonly unknown[]
  readonly timeoutMs: number | undefined
  readonly precheck: ((ctx: HttpContext) => void | Promise<void>) | undefined
  readonly accept: (ctx: HttpContext, upgrade: PendingUpgrade) => void | Promise<void>
}

/** The upgrade routes of the plugins and the merged `Bun.serve()` settings (internal). */
export interface CollectedUpgrades {
  readonly routes: readonly CollectedUpgradeRoute[]
  readonly bunWebSocket: Readonly<Record<string, unknown>>
}

/** Calls `httpUpgrades()` on every other plugin implementing it, in plugin order, and validates the routes. */
export function collectPluginUpgrades(
  plugins: readonly object[],
  self: object,
  context: PluginHttpUpgradesContext,
): CollectedUpgrades {
  const routes: CollectedUpgradeRoute[] = []
  const bunWebSocket: Record<string, unknown> = {}
  for (const plugin of plugins) {
    if (plugin === self) continue
    const provider = plugin as Partial<PluginHttpUpgrades> & { readonly name?: unknown }
    if (typeof provider.httpUpgrades !== 'function') continue
    const name = String(provider.name)
    const result: unknown = provider.httpUpgrades(context)
    const declared = (result as Partial<PluginUpgrades> | null | undefined)?.routes
    if (!Array.isArray(declared)) {
      throw invalid(name, `httpUpgrades() must return { routes: [...] } (received ${describe(result)})`)
    }
    for (const route of declared as unknown[]) routes.push(validateRoute(plugin, name, route, context.prefix))
    const settings = (result as PluginUpgrades).bunWebSocket
    if (settings !== undefined) Object.assign(bunWebSocket, settings)
  }
  return { routes, bunWebSocket }
}

function validateRoute(instance: object, plugin: string, value: unknown, prefix: string): CollectedUpgradeRoute {
  if (value === null || typeof value !== 'object') throw invalid(plugin, `invalid upgrade route ${describe(value)}`)
  const route = value as Partial<PluginUpgradeRoute>
  if (typeof route.name !== 'string' || route.name === '') {
    throw invalid(plugin, `the upgrade route ${String(route.path)} needs a name`)
  }
  const where = `${String(route.path)} (${route.name})`
  if (typeof route.path !== 'string') throw invalid(plugin, `the upgrade route ${where} has no path`)
  if (typeof route.accept !== 'function') throw invalid(plugin, `the upgrade route ${where} has no accept function`)
  if (route.precheck !== undefined && typeof route.precheck !== 'function') {
    throw invalid(plugin, `the precheck of the upgrade route ${where} must be a function`)
  }
  let path: RoutePath
  try {
    path = parseRoutePath(joinPaths(prefix, route.path))
  } catch (error) {
    if (!(error instanceof RoutePathError)) throw error
    throw invalid(plugin, `invalid path of the upgrade route ${where}: ${error.issue.message}`, error)
  }
  const meta = route.meta ?? []
  if (!Array.isArray(meta)) throw invalid(plugin, `the meta of the upgrade route ${where} must be an array of entries`)
  const entries = (meta as unknown[]).map(entry => metaEntry(plugin, where, entry))
  const guards = route.guards ?? []
  if (!Array.isArray(guards)) throw invalid(plugin, `the guards of the upgrade route ${where} must be an array`)
  const timeoutMs = route.timeoutMs
  if (timeoutMs !== undefined && !(typeof timeoutMs === 'number' && timeoutMs > 0)) {
    throw invalid(plugin, `invalid timeoutMs ${describe(timeoutMs)} of the upgrade route ${where}`)
  }
  return {
    plugin,
    instance,
    path,
    relativePath: normalizePath(route.path),
    name: route.name,
    owner: route.owner ?? plugin,
    meta: entries,
    guards,
    timeoutMs: timeoutMs === Number.POSITIVE_INFINITY ? undefined : timeoutMs,
    precheck: route.precheck?.bind(route),
    accept: route.accept.bind(route),
  }
}

function metaEntry(plugin: string, where: string, value: unknown): NormalizedMetaEntry {
  const entry = (value ?? {}) as Partial<RouteMetaEntry>
  if (value === null || typeof value !== 'object' || typeof entry.key !== 'string' || entry.key === '') {
    throw invalid(plugin, `invalid meta entry ${describe(value)} of the upgrade route ${where}`)
  }
  const group = entry.group ?? entry.key
  const required = entry.required ?? false
  if (!isGroupOf(group, entry.key) || typeof required !== 'boolean') {
    throw invalid(plugin, `invalid group of the meta entry "${entry.key}" of the upgrade route ${where}`)
  }
  return { key: entry.key, value: entry.value, group, required }
}

function invalid(plugin: string, reason: string, cause?: unknown): ZnightError {
  return new ZnightError(ErrorCode.InvalidRoute, `HttpPlugin: plugin "${plugin}": ${reason}`, {
    ...(cause === undefined ? {} : { cause }),
  })
}

function describe(value: unknown): string {
  try {
    return typeof value === 'function' ? 'a function' : (JSON.stringify(value) ?? String(value))
  } catch {
    return typeof value
  }
}

// -------------------------------------------------------------------------------------------------
// Handshake checks (RFC 6455 §4.2.1)
// -------------------------------------------------------------------------------------------------

const KEY = /^[A-Za-z0-9+/]{22}==$/

/** Whether a request asks for a WebSocket upgrade (`upgrade: websocket`, any case). */
export function isWebSocketUpgrade(headers: Readonly<Record<string, string | undefined>>): boolean {
  const upgrade = headers['upgrade']
  return upgrade !== undefined && upgrade.length === 9 && upgrade.toLowerCase() === 'websocket'
}

/**
 * The protocol checks of a handshake: `GET`, `sec-websocket-version: 13` (`426` with the supported
 * version otherwise) and a base64 16-byte `sec-websocket-key` (`400`).
 */
export function checkHandshake(ctx: HttpContext): void {
  if (ctx.method !== 'GET') throw new BadRequestException('A WebSocket handshake must be a GET request')
  if (ctx.headers['sec-websocket-version'] !== '13') {
    throw new HttpException(426, 'Unsupported WebSocket version', undefined, {
      headers: { 'sec-websocket-version': '13' },
    })
  }
  const key = ctx.headers['sec-websocket-key']
  if (key === undefined || !KEY.test(key.trim())) throw new BadRequestException('Invalid Sec-WebSocket-Key')
}

/** What the pipeline gives to a {@link PendingUpgradeState} (internal). */
export interface PendingUpgradeHooks {
  /** The headers of the `101` response. */
  headers(): Readonly<Record<string, HeaderValue>>
  /** Whether the client left (`ctx.signal` aborted with the kind `client`). */
  disconnected(): boolean
  /** Stops listening to the client disconnects: the transport took the connection. */
  accepted(): void
}

/** Internal: the pending upgrade of a handshake, created by the pipeline. */
export class PendingUpgradeState implements PendingUpgrade {
  readonly native: NativeUpgrade
  readonly #hooks: PendingUpgradeHooks
  /** The transport completed the handshake (`101`). */
  accepted = false
  /** The handshake timed out: the transport must not complete it. */
  expired = false
  held: Promise<unknown> | undefined

  constructor(native: NativeUpgrade, hooks: PendingUpgradeHooks) {
    this.native = native
    this.#hooks = hooks
  }

  get headers(): Readonly<Record<string, HeaderValue>> {
    return this.#hooks.headers()
  }

  get disconnected(): boolean {
    return this.#hooks.disconnected()
  }

  hold(closed: Promise<unknown>): void {
    if (this.held !== undefined) throw new Error('PendingUpgrade.hold() can only be called once')
    this.accepted = true
    this.#hooks.accepted()
    this.held = closed.then(
      () => undefined,
      () => undefined,
    )
  }
}
