/**
 * ZNIGHT002: circular dependencies over the full instantiation edge set — constructor and method
 * parameters (optional and multi included), interceptors and `@Factory` → `@Provides` edges.
 * `Lazy<T>` edges break cycles; extension edges (resolved by plugins at runtime) are not part of it.
 */
import type { Token } from '@znight/core'
import type { Reporter } from '../analysis/arguments.ts'
import type { GraphEdge, ProviderNode } from '../graph/types.ts'

import { ErrorCode } from '@znight/core'

import { stronglyConnectedComponents } from '../graph/order.ts'
import { compareStrings } from '../project/compare.ts'
import { displayNameOf } from '../project/index.ts'

/** Reports one ZNIGHT002 per strongly connected component (a cycle through its smallest token). */
export function checkCycles(providers: readonly ProviderNode[], edges: readonly GraphEdge[], report: Reporter): void {
  const tokens = new Set(providers.map(provider => provider.token))
  const outgoing = new Map<Token, GraphEdge[]>()
  for (const edge of edges) {
    if (edge.kind === 'lazy' || edge.kind === 'extension' || !tokens.has(edge.to)) {
      continue
    }
    const list = outgoing.get(edge.from)
    if (list) {
      list.push(edge)
    } else {
      outgoing.set(edge.from, [edge])
    }
  }
  const successors = new Map<Token, Token[]>()
  for (const [from, list] of outgoing) {
    successors.set(from, [...new Set(list.map(edge => edge.to))].sort(compareStrings))
  }
  const next = (token: Token): readonly Token[] => successors.get(token) ?? []

  for (const component of stronglyConnectedComponents([...tokens], next)) {
    const start = component[0] as Token
    if (component.length === 1 && !next(start).includes(start)) {
      continue
    }
    const members = new Set(component)
    const path = shortestCycle(start, members, next)
    const cycleEdges = path.slice(0, -1).map((from, index) => {
      const to = path[index + 1] as Token
      return (outgoing.get(from) ?? []).find(edge => edge.to === to) as GraphEdge
    })
    const first = cycleEdges[0]
    const display = path.map(displayNameOf)
    const lazyTarget = display[1] ?? display[0]
    report({
      code: ErrorCode.CircularDependency,
      severity: 'error',
      message: `Circular dependency: ${display.join(' -> ')}`,
      ...(first?.location ? { location: first.location } : {}),
      hints: [
        `Break the cycle with Lazy<T>: inject Lazy<${lazyTarget}> in ${display[0]} and call .get() when the dependency is needed`,
      ],
      related: cycleEdges.flatMap(edge =>
        edge.location
          ? [
              {
                message: `${displayNameOf(edge.from)} -> ${displayNameOf(edge.to)} (${edge.label})`,
                location: edge.location,
              },
            ]
          : [],
      ),
    })
  }
}

/** Shortest path `start -> ... -> start` inside a component (BFS, successors in token order). */
function shortestCycle(start: Token, members: ReadonlySet<Token>, next: (token: Token) => readonly Token[]): Token[] {
  const parent = new Map<Token, Token>()
  const queue: Token[] = [start]
  const seen = new Set<Token>()
  while (queue.length > 0) {
    const current = queue.shift() as Token
    for (const target of next(current)) {
      if (!members.has(target)) {
        continue
      }
      if (target === start) {
        const middle: Token[] = []
        let node: Token | undefined = current
        while (node !== undefined && node !== start) {
          middle.push(node)
          node = parent.get(node)
        }
        return [start, ...middle.reverse(), start]
      }
      if (!seen.has(target)) {
        seen.add(target)
        parent.set(target, current)
        queue.push(target)
      }
    }
  }
  return [start, start]
}
