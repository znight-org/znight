/**
 * ZNIGHT003: a singleton depends — directly, through transient providers, multi injections,
 * interceptors, extension edges (guards...) or externals — on a request-scoped provider or external.
 * `Lazy<T>` edges are the escape hatch. Singleton → transient is allowed (the singleton owns it).
 */
import type { Scope, Token } from '@znight/core'
import type { Reporter } from '../analysis/arguments.ts'
import type { ExternalNode, GraphEdge, ProviderNode } from '../graph/types.ts'

import { ErrorCode } from '@znight/core'

import { displayNameOf } from '../project/index.ts'

/** Reports one ZNIGHT003 per singleton (the first request-scoped dependency found, breadth-first). */
export function checkScopes(
  providers: readonly ProviderNode[],
  externals: readonly ExternalNode[],
  edges: readonly GraphEdge[],
  report: Reporter,
): void {
  const scopes = new Map<Token, Scope>()
  for (const external of externals) {
    scopes.set(external.token, external.scope)
  }
  const providerTokens = new Set<Token>()
  for (const provider of providers) {
    scopes.set(provider.token, provider.scope)
    providerTokens.add(provider.token)
  }
  const outgoing = new Map<Token, GraphEdge[]>()
  for (const edge of edges) {
    if (edge.kind === 'lazy') {
      continue
    }
    const list = outgoing.get(edge.from)
    if (list) {
      list.push(edge)
    } else {
      outgoing.set(edge.from, [edge])
    }
  }

  for (const provider of providers) {
    if (provider.scope !== 'singleton') {
      continue
    }
    const parent = new Map<Token, GraphEdge>()
    const queue: Token[] = [provider.token]
    const seen = new Set<Token>([provider.token])
    let found: GraphEdge | undefined
    search: while (queue.length > 0) {
      const current = queue.shift() as Token
      for (const edge of outgoing.get(current) ?? []) {
        const scope = scopes.get(edge.to)
        if (scope === 'request') {
          found = edge
          break search
        }
        if (scope === 'transient' && providerTokens.has(edge.to) && !seen.has(edge.to)) {
          seen.add(edge.to)
          parent.set(edge.to, edge)
          queue.push(edge.to)
        }
      }
    }
    if (!found) {
      continue
    }
    const path: GraphEdge[] = [found]
    let edge = parent.get(found.from)
    while (edge) {
      path.unshift(edge)
      edge = parent.get(edge.from)
    }
    const first = path[0] as GraphEdge
    const singleton = provider.displayName
    const target = displayNameOf(found.to)
    const chain = [singleton, ...path.map(step => displayNameOf(step.to))].join(' -> ')
    report({
      code: ErrorCode.ScopeMismatch,
      severity: 'error',
      message: `Scope mismatch: singleton ${singleton} depends on request-scoped ${target} (${chain})`,
      ...(first.location ? { location: first.location } : {}),
      hints: [
        `Inject Lazy<${target}> and call .get() while a request is being handled`,
        `Or make ${singleton} request-scoped: @Injectable({ scope: 'request' })`,
      ],
      related: path.flatMap(step =>
        step.location
          ? [
              {
                message: `${displayNameOf(step.from)} -> ${displayNameOf(step.to)} (${step.label})`,
                location: step.location,
              },
            ]
          : [],
      ),
    })
  }
}
