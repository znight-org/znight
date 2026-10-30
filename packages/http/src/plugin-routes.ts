/**
 * Plugin routes (RFC 0002 H1): routes another plugin asks `HttpPlugin` to serve (documentation,
 * health or metrics endpoints), registered on every adapter in the same pipeline as the compiled
 * controllers.
 */
import type { Container, Plugin } from '@znight/core'
import type { HttpContext } from './context.ts'
import type { RouteMetaEntry } from './decorators.ts'
import type { HttpMethod } from './metadata.ts'
import type { GuardRef } from './plugin.ts'

import { ErrorCode, ZnightError } from '@znight/core'

import { isGroupOf } from './decorators.ts'
import { joinPaths, normalizePath, parseRoutePath, type RoutePath, RoutePathError } from './path.ts'

/**
 * A route served by `HttpPlugin` on behalf of another plugin. It runs through the same pipeline as
 * controller routes: `http:request` hook, request scope, global guards, then its own `guards`, the
 * handler, the exception mappers; global interceptors do not wrap it. The handler result is
 * serialised like a controller result (`HttpResponse`, objects as JSON, strings, streams...).
 */
export interface PluginRoute {
  /** `GET` routes also answer `HEAD`; `ALL` registers every method without its own route. */
  readonly method: HttpMethod
  /** Path relative to the `HttpPlugin` prefix, with the controller grammar (`/openapi.json`, `/docs/_assets/*`). */
  readonly path: string
  /** Handler name, shown in `HttpPlugin.routes`, logs and errors (`document`). */
  readonly name: string
  readonly handler: (ctx: HttpContext) => unknown
  /**
   * Route metadata (`[Public.meta()]`): read by guards (`Public.get(ctx)`) and by the boot check of
   * required route decorator groups. One entry per group.
   */
  readonly meta?: readonly RouteMetaEntry[]
  /** Guards of the route (provider classes or instances), run after the global guards. */
  readonly guards?: readonly GuardRef[]
}

/** What {@link PluginHttpRoutes.httpRoutes} receives. */
export interface PluginHttpRoutesContext {
  /** The `HttpPlugin` prefix (`''` or `/api`), already applied to the paths of the routes. */
  readonly prefix: string
  /** The application container (initialised). */
  readonly container: Container
}

/**
 * Implemented by a plugin that serves HTTP routes. `HttpPlugin` calls `httpRoutes()` once in its
 * `onBootstrap`, after `container.init()` and whatever the plugin order, then registers the routes
 * on its adapter. A path that breaks the grammar, or that collides with another route, is ZNIGHT007
 * naming the plugin.
 *
 * ```ts
 * export class StatusPlugin implements Plugin, PluginHttpRoutes {
 *   readonly name = 'status'
 *   httpRoutes(): readonly PluginRoute[] {
 *     return [{ method: 'GET', path: '/status', name: 'status', handler: () => ({ up: true }), meta: [Public.meta()] }]
 *   }
 * }
 * ```
 */
export interface PluginHttpRoutes {
  httpRoutes(context: PluginHttpRoutesContext): readonly PluginRoute[]
}

/** A validated plugin route (internal). */
export interface CollectedPluginRoute {
  readonly plugin: string
  /** The plugin instance (the "controller" of the route). */
  readonly instance: object
  readonly method: HttpMethod
  /** Full path, prefix included. */
  readonly path: RoutePath
  /** Normalised path without the prefix. */
  readonly relativePath: string
  readonly name: string
  readonly handler: (ctx: HttpContext) => unknown
  readonly meta: readonly NormalizedMetaEntry[]
  readonly guards: readonly unknown[]
}

/** A plugin route metadata entry with its group (internal). */
export interface NormalizedMetaEntry {
  readonly key: string
  readonly value: unknown
  readonly group: string
  readonly required: boolean
}

const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'])

/** Calls `httpRoutes()` on every other plugin implementing it, in plugin order, and validates the routes. */
export function collectPluginRoutes(
  plugins: readonly Plugin[],
  self: Plugin,
  context: PluginHttpRoutesContext,
): CollectedPluginRoute[] {
  const collected: CollectedPluginRoute[] = []
  for (const plugin of plugins) {
    if (plugin === self) continue
    const provider = plugin as Plugin & Partial<PluginHttpRoutes>
    if (typeof provider.httpRoutes !== 'function') continue
    const name = String(plugin.name)
    const routes: unknown = provider.httpRoutes(context)
    if (!Array.isArray(routes)) {
      throw invalid(name, `httpRoutes() must return an array of routes (received ${describe(routes)})`)
    }
    for (const route of routes as unknown[]) collected.push(validateRoute(plugin, name, route, context.prefix))
  }
  return collected
}

function validateRoute(instance: object, plugin: string, value: unknown, prefix: string): CollectedPluginRoute {
  if (value === null || typeof value !== 'object') throw invalid(plugin, `invalid route ${describe(value)}`)
  const route = value as Partial<PluginRoute>
  const label = `${String(route.method)} ${String(route.path)}`
  if (typeof route.name !== 'string' || route.name === '') {
    throw invalid(plugin, `the route ${label} needs a name (handler name shown in HttpPlugin.routes)`)
  }
  const where = `${label} (${route.name})`
  if (typeof route.method !== 'string' || !METHODS.has(route.method)) {
    throw invalid(plugin, `unknown method ${describe(route.method)} of the route ${where}`)
  }
  if (typeof route.handler !== 'function') throw invalid(plugin, `the route ${where} has no handler function`)
  if (typeof route.path !== 'string') throw invalid(plugin, `the route ${where} has no path`)
  let path: RoutePath
  try {
    path = parseRoutePath(joinPaths(prefix, route.path))
  } catch (error) {
    if (!(error instanceof RoutePathError)) throw error
    throw invalid(plugin, `invalid path of the route ${where}: ${error.issue.message}`, error)
  }
  const meta = route.meta ?? []
  if (!Array.isArray(meta)) throw invalid(plugin, `the meta of the route ${where} must be an array of entries`)
  const entries = (meta as unknown[]).map(entry => metaEntry(plugin, where, entry))
  const groups = new Map<string, string>()
  for (const entry of entries) {
    const other = groups.get(entry.group)
    if (other !== undefined) {
      throw invalid(
        plugin,
        `the route ${where} has two entries of the "${entry.group}" group (${other}, ${entry.key}): keep one`,
      )
    }
    groups.set(entry.group, entry.key)
  }
  const guards = route.guards ?? []
  if (!Array.isArray(guards)) throw invalid(plugin, `the guards of the route ${where} must be an array`)
  return {
    plugin,
    instance,
    method: route.method as HttpMethod,
    path,
    relativePath: normalizePath(route.path),
    name: route.name,
    handler: route.handler,
    meta: entries,
    guards,
  }
}

function metaEntry(plugin: string, where: string, value: unknown): NormalizedMetaEntry {
  const entry = (value ?? {}) as Partial<RouteMetaEntry>
  if (value === null || typeof value !== 'object' || typeof entry.key !== 'string' || entry.key === '') {
    throw invalid(plugin, `invalid meta entry ${describe(value)} of the route ${where}: expected Decorator.meta(value)`)
  }
  const group = entry.group ?? entry.key
  const required = entry.required ?? false
  if (!isGroupOf(group, entry.key) || typeof required !== 'boolean') {
    throw invalid(plugin, `invalid group of the meta entry "${entry.key}" of the route ${where}`)
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
