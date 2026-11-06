/**
 * `validate` of the events extension (RFC 0011 §6): checks that need the bound graph. Detached
 * listeners whose host reaches a request-scoped external (ZNIGHT070, error), listeners of an
 * abstract class that no concrete provider extends (ZNIGHT070, warning). It also computes the
 * providers inheriting the listeners of abstract classes, which `generate` reads back.
 */
import type { GraphEdge, ValidateContext } from '@znight/compiler'
import type { EventsData, ListenerData } from './data.ts'
import type { ProviderClasses } from './inheritance.ts'

import { compareStrings, INVALID_LISTENER } from './constants.ts'
import { inheritorsOf, isExtended, providerClasses } from './inheritance.ts'

type Context = ValidateContext<EventsData>

/** Edges followed when a host is created: what its construction instantiates. */
const INSTANTIATING: ReadonlySet<GraphEdge['kind']> = new Set([
  'dependency',
  'multi',
  'optional',
  'factory',
  'interceptor',
])

/** Graph-wide checks of the listeners. */
export function validateEvents(ctx: Context): void {
  const listeners = ctx.stored.filter((data): data is ListenerData => data.kind === 'listener').sort(byLocation)
  if (listeners.length === 0) return
  const providers = providerClasses(ctx)
  for (const listener of listeners) {
    if (listener.host.abstract) inheritorsOf(listener, providers)
  }
  reportOrphans(listeners, providers, ctx)
  reportDetachedRequestValues(listeners, providers, ctx)
}

function reportOrphans(listeners: readonly ListenerData[], providers: ProviderClasses, ctx: Context): void {
  const reported = new Set<string>()
  for (const listener of listeners) {
    if (!listener.host.abstract) continue
    const key = `${listener.host.identity}#${listener.method}`
    if (reported.has(key)) continue
    if (isExtended(listener.host, providers)) continue
    reported.add(key)
    ctx.report({
      code: INVALID_LISTENER,
      severity: 'warning',
      message: `${listener.host.displayName}.${listener.method}() never runs: no provider extends the abstract class ${listener.host.displayName}`,
      location: listener.location,
      hints: [
        'Listeners of an abstract class run on its concrete providers: register a subclass, or make the host concrete',
      ],
    })
  }
}

/**
 * A detached listener runs in a fresh scope, without HTTP request, message or job: when its host's
 * construction reaches a request-scoped external (outside `Lazy<T>`), every run fails with ZNIGHT013.
 */
function reportDetachedRequestValues(
  listeners: readonly ListenerData[],
  providers: ProviderClasses,
  ctx: Context,
): void {
  const requestExternals = new Map<string, string>()
  for (const external of ctx.graph.externals) {
    if (external.scope === 'request') requestExternals.set(external.token, external.displayName)
  }
  if (requestExternals.size === 0) return
  const adjacency = edgesByProvider(ctx.graph.edges)
  const reported = new Set<string>()
  for (const listener of listeners) {
    if (!listener.detached) continue
    let tokens: string[]
    if (listener.host.abstract) {
      tokens = inheritorsOf(listener, providers).map(inheritor => inheritor.token)
    } else {
      const token = ctx.provider(listener.host.identity)?.token
      tokens = token === undefined ? [] : [token]
    }
    for (const token of tokens) {
      const key = `${token}#${listener.method}`
      if (reported.has(key)) continue
      const found = reach(token, adjacency, requestExternals)
      if (found === undefined) continue
      reported.add(key)
      const host = ctx.provider(token)?.displayName ?? listener.host.displayName
      ctx.report({
        code: INVALID_LISTENER,
        severity: 'error',
        message: `${host}.${listener.method}() is detached but ${host} depends on ${found}, which does not exist in a detached listener`,
        location: listener.location,
        hints: [
          'A detached listener runs after the publication, in its own scope: pass what you need in the event',
          `Or make the listener inline (remove detached: true), or inject it lazily (Lazy<${found}>)`,
        ],
      })
    }
  }
}

function edgesByProvider(edges: readonly GraphEdge[]): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    if (!INSTANTIATING.has(edge.kind)) continue
    let list = map.get(edge.from)
    if (list === undefined) {
      list = []
      map.set(edge.from, list)
    }
    list.push(edge)
  }
  return map
}

/** Display name of the first request-scoped external reached from `token`. */
function reach(
  token: string,
  adjacency: ReadonlyMap<string, readonly GraphEdge[]>,
  targets: ReadonlyMap<string, string>,
): string | undefined {
  const seen = new Set([token])
  const queue = [token]
  for (let index = 0; index < queue.length; index++) {
    for (const edge of adjacency.get(queue[index] as string) ?? []) {
      const name = targets.get(edge.to)
      if (name !== undefined) return name
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return undefined
}

function byLocation(a: ListenerData, b: ListenerData): number {
  return (
    compareStrings(a.location.file, b.location.file) ||
    a.location.start - b.location.start ||
    compareStrings(a.event.identity, b.event.identity)
  )
}
