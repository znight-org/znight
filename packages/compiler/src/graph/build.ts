/**
 * Graph assembly: binds every provider's injection points (§4.7), wires interceptors and factory
 * dependencies, and computes edges, externals, aliases and the resolution order.
 */
import type { DependencyRef, Token } from '@znight/core'
import type { ExternalInfo, ManifestIndex } from '../analysis/manifests.ts'
import type { ProviderDraft, ProviderRegistry } from '../analysis/registry.ts'
import type { Binder, BindSite } from '../binding/binder.ts'
import type { Location, Project } from '../project/index.ts'
import type {
  AliasNode,
  BindingRequestNode,
  DependencyNode,
  EdgeKind,
  ExternalNode,
  FactoryNode,
  GraphEdge,
  InterceptedMethodNode,
  ProviderNode,
} from './types.ts'

import { LAZY_IDENTITY } from '../analysis/core-decorators.ts'
import { compareStrings } from '../project/compare.ts'
import { displayNameOf, GLOBAL_IDENTITY_PREFIX, relativePath, serializeType } from '../project/index.ts'
import { topologicalOrder } from './order.ts'

/** An extension dependency (`addDependency`, `resolveClassRef({ from })`). */
export interface ExtensionEdge {
  readonly from: Token
  readonly to: Token
  readonly location: Location | undefined
  readonly reason: string
}

/** An extension injection request (`bindInjection`). */
export interface ExtensionBinding {
  readonly id: number
  readonly site: BindSite
  readonly from: Token | undefined
}

/** Output of {@link buildGraph}. */
export interface BoundGraph {
  readonly providers: readonly ProviderNode[]
  readonly edges: readonly GraphEdge[]
  readonly externals: readonly ExternalNode[]
  readonly aliases: readonly AliasNode[]
  readonly resolutionOrder: readonly Token[]
  readonly bindings: ReadonlyMap<number, DependencyRef | undefined>
  readonly bindingRequests: ReadonlyMap<number, BindingRequestNode>
}

/** Binds the registered providers and assembles the graph. */
export function buildGraph(input: {
  readonly project: Project
  readonly registry: ProviderRegistry
  readonly manifests: ManifestIndex
  readonly binder: Binder
  readonly extensionEdges: readonly ExtensionEdge[]
  readonly extensionBindings: readonly ExtensionBinding[]
}): BoundGraph {
  const { project, registry, manifests, binder } = input
  const edges: GraphEdge[] = []
  const externals = new Map<Token, ExternalInfo>()
  const providers: ProviderNode[] = []

  const addEdge = (from: Token, to: Token, kind: EdgeKind, label: string, location: Location | undefined): void => {
    edges.push({ from, to, kind, label, location })
  }

  for (const draft of registry.all()) {
    const deps: DependencyNode[] = []
    if (draft.kind === 'provides' && draft.factoryToken !== undefined) {
      const label = `factory ${displayNameOf(draft.factoryToken)} of ${draft.displayName}`
      deps.push({
        ref: draft.factoryToken,
        role: 'factory',
        label,
        location: draft.registration,
        type: undefined,
        request: undefined,
      })
      addEdge(draft.token, draft.factoryToken, 'factory', label, draft.registration)
    }
    for (const site of draft.params) {
      const outcome = draft.skipBinding
        ? undefined
        : binder.bind({
            owner: draft.displayName,
            label: site.label,
            subject: site.subject,
            location: site.location,
            spec: site.spec,
            rest: site.rest,
          })
      const request = { type: site.spec.type, qualifier: site.spec.qualifier, optional: site.spec.optional }
      if (!outcome) {
        deps.push({
          ref: { token: serializeType(site.spec.type), optional: true },
          role: 'parameter',
          label: site.label,
          location: site.location,
          type: site.spec.type,
          request,
        })
        continue
      }
      deps.push({
        ref: outcome.ref,
        role: 'parameter',
        label: site.label,
        location: site.location,
        type: outcome.type,
        request,
      })
      for (const target of outcome.targets) {
        if (target.external) {
          externals.set(target.external.token, target.external)
        }
        addEdge(draft.token, target.token, target.kind, site.label, site.location)
      }
    }
    const factory = factoryOf(draft)
    const interceptors = wireInterceptors(draft, deps, registry, manifests, externals, addEdge)
    providers.push({
      token: draft.token,
      displayName: draft.displayName,
      kind: draft.kind,
      registeredBy: draft.registeredBy,
      classIdentity: draft.cls.identity,
      importRoute: draft.cls.importRoute,
      method: draft.method?.name,
      providedType: draft.providedType,
      heritage: draft.heritage,
      scope: draft.scope,
      async: draft.async,
      deps,
      factory,
      interceptors,
      dispose: draft.dispose,
      name: draft.name,
      primary: draft.primary,
      lifecycle: draft.lifecycle,
      source: {
        file: relativePath(project.root, draft.location.file),
        line: draft.location.line,
        column: draft.location.column,
      },
      location: draft.location,
    })
  }

  for (const edge of input.extensionEdges) {
    if (!registry.has(edge.from)) {
      continue
    }
    const external = registry.has(edge.to) ? undefined : manifests.external(edge.to)
    if (external) {
      externals.set(external.token, external)
    }
    if (registry.has(edge.to) || external) {
      addEdge(edge.from, edge.to, 'extension', edge.reason, edge.location ?? registry.get(edge.from)?.registration)
    }
  }

  const bindings = new Map<number, DependencyRef | undefined>()
  const bindingRequests = new Map<number, BindingRequestNode>()
  for (const request of input.extensionBindings) {
    const outcome = binder.bind(request.site)
    bindings.set(request.id, outcome?.ref)
    const spec = request.site.spec
    bindingRequests.set(request.id, {
      request: { type: spec.type, qualifier: spec.qualifier, optional: spec.optional },
      from: request.from,
      label: request.site.label,
    })
    if (!outcome) {
      continue
    }
    for (const target of outcome.targets) {
      if (target.external) {
        externals.set(target.external.token, target.external)
      }
      const from = request.from === undefined ? undefined : registry.get(request.from)
      if (from) {
        addEdge(from.token, target.token, 'extension', request.site.label, request.site.location ?? from.registration)
      }
    }
  }
  for (const external of binder.usedExternals()) {
    externals.set(external.token, external)
  }

  edges.sort(
    (a, b) =>
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.label, b.label),
  )
  const tokens = providers.map(provider => provider.token)
  const orderEdges = new Map<Token, Token[]>()
  for (const edge of edges) {
    if (edge.kind === 'lazy' || edge.kind === 'extension' || !registry.has(edge.to)) {
      continue
    }
    const list = orderEdges.get(edge.from)
    if (list) {
      list.push(edge.to)
    } else {
      orderEdges.set(edge.from, [edge.to])
    }
  }
  return {
    providers,
    edges,
    externals: [...externals.values()]
      .sort((a, b) => compareStrings(a.token, b.token))
      .map(external => ({
        token: external.token,
        displayName: displayNameOf(external.token),
        scope: external.scope,
        providedBy: external.providedBy,
        optional: external.optional,
        origin: external.origin,
      })),
    aliases: computeAliases(registry),
    resolutionOrder: topologicalOrder(tokens, token => orderEdges.get(token) ?? []),
    bindings,
    bindingRequests,
  }
}

function factoryOf(draft: ProviderDraft): FactoryNode {
  switch (draft.kind) {
    case 'provides':
      return { kind: 'method', method: draft.method?.name ?? '', args: draft.params.length }
    case 'custom':
      return {
        kind: 'custom',
        args: draft.params.length,
        generate: (draft.custom as NonNullable<ProviderDraft['custom']>).generate,
      }
    default:
      return { kind: 'constructor', args: draft.params.length }
  }
}

/** Appends one dependency per distinct interceptor token and builds the method chains. */
function wireInterceptors(
  draft: ProviderDraft,
  deps: DependencyNode[],
  registry: ProviderRegistry,
  manifests: ManifestIndex,
  externals: Map<Token, ExternalInfo>,
  addEdge: (from: Token, to: Token, kind: EdgeKind, label: string, location: Location | undefined) => void,
): InterceptedMethodNode[] {
  const indexes = new Map<Token, number>()
  return draft.interceptors.map(intercepted => ({
    method: intercepted.method.name,
    async: intercepted.method.async,
    chain: intercepted.chain.map(link => {
      let dep = indexes.get(link.token)
      if (dep === undefined) {
        dep = deps.length
        indexes.set(link.token, dep)
        const label = `interceptor ${displayNameOf(link.token)} of ${draft.displayName}.${intercepted.method.name}`
        deps.push({
          ref: link.token,
          role: 'interceptor',
          label,
          location: link.decorator.location,
          type: undefined,
          request: undefined,
        })
        const external = registry.has(link.token) ? undefined : manifests.external(link.token)
        if (external) {
          externals.set(external.token, external)
        }
        if (registry.has(link.token) || external) {
          addEdge(draft.token, link.token, 'interceptor', label, link.decorator.location)
        }
      }
      return {
        dep,
        token: link.token,
        hasOptions: link.hasOptions,
        options: link.options,
        decorator: link.decorator.identity ?? link.decorator.name,
        location: link.decorator.location,
      }
    }),
  }))
}

/** Core marker types implemented by many providers: never useful as lookup keys. */
const NOT_ALIASED: ReadonlySet<string> = new Set([
  LAZY_IDENTITY,
  '@znight/core#OnStart',
  '@znight/core#OnReady',
  '@znight/core#OnStop',
  '@znight/core#MethodInterceptor',
])

/**
 * Aliases (§4.7): every provided-type / heritage identity that resolves to exactly one provider (or
 * one `@Primary` among several). Provider tokens, globals and the core marker interfaces (`Lazy`,
 * `OnStart`, `OnReady`, `OnStop`, `MethodInterceptor`) are never aliased.
 */
function computeAliases(registry: ProviderRegistry): AliasNode[] {
  const byKey = new Map<string, Map<Token, ProviderDraft>>()
  const add = (key: string, draft: ProviderDraft): void => {
    let entry = byKey.get(key)
    if (!entry) {
      entry = new Map()
      byKey.set(key, entry)
    }
    entry.set(draft.token, draft)
  }
  for (const draft of registry.all()) {
    if (draft.providedType.kind === 'reference') {
      add(draft.providedType.identity, draft)
    }
    for (const heritage of draft.heritage) {
      add(heritage.identity, draft)
    }
  }
  const aliases: AliasNode[] = []
  for (const [key, drafts] of byKey) {
    if (registry.has(key) || NOT_ALIASED.has(key) || key.startsWith(GLOBAL_IDENTITY_PREFIX)) {
      continue
    }
    const candidates = [...drafts.values()]
    const primaries = candidates.filter(draft => draft.primary)
    let target = candidates.length === 1 ? candidates[0] : undefined
    if (!target && primaries.length === 1) {
      target = primaries[0]
    }
    if (target) {
      aliases.push({ key, token: target.token })
    }
  }
  return aliases.sort((a, b) => compareStrings(a.key, b.key))
}
