/**
 * `prune` option: drops the providers unreachable from any root (`graph.reachability`), with
 * their edges, the aliases pointing to them and the externals only they use.
 */
import type { DependencyRef, Token } from '@znight/core'
import type { ApplicationGraph } from '../graph/types.ts'

/** Tokens referenced by a dependency reference. */
export function referencedTokens(ref: DependencyRef | undefined): Token[] {
  if (ref === undefined) {
    return []
  }
  if (typeof ref === 'string') {
    return [ref]
  }
  if ('multi' in ref) {
    return [...ref.multi]
  }
  if ('lazy' in ref) {
    return [ref.lazy]
  }
  return [ref.token]
}

/** The graph without its unreachable providers (unchanged when reachability was not computed). */
export function pruneGraph(graph: ApplicationGraph): ApplicationGraph {
  const unreachable = new Set(graph.reachability?.unreachable ?? [])
  if (unreachable.size === 0) {
    return graph
  }
  const providers = graph.providers.filter(provider => !unreachable.has(provider.token))
  const edges = graph.edges.filter(edge => !unreachable.has(edge.from) && !unreachable.has(edge.to))
  const used = new Set<Token>()
  for (const provider of providers) {
    for (const dep of provider.deps) {
      for (const token of referencedTokens(dep.ref)) {
        used.add(token)
      }
    }
  }
  for (const edge of edges) {
    used.add(edge.to)
  }
  for (const ref of graph.bindings.values()) {
    for (const token of referencedTokens(ref)) {
      used.add(token)
    }
  }
  return {
    ...graph,
    providers,
    edges,
    externals: graph.externals.filter(external => used.has(external.token)),
    aliases: graph.aliases.filter(alias => !unreachable.has(alias.token)),
    resolutionOrder: graph.resolutionOrder.filter(token => !unreachable.has(token)),
  }
}
