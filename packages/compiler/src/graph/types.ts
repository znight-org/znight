/**
 * The application graph: the intermediate representation produced by analysis + binding +
 * validation and consumed by the code generator (and by extension `validate` hooks).
 *
 * Every list is sorted deterministically (tokens and names with `compareStrings`), so two compiles of
 * the same sources produce structurally identical graphs whatever the scan order. See ./README.md.
 */
import type { DependencyRef, Scope, SourceLocation, Token } from '@znight/core'
import type { CustomFactory, LifecycleHookInfo } from '../extensions/api.ts'
import type { Diagnostic, ImportRoute, Location, StaticValue, TypeInfo } from '../project/index.ts'

/** How the instance of a provider is created. */
export type FactoryNode =
  /** `new Class(d[0], ..., d[args - 1])`. */
  | { readonly kind: 'constructor'; readonly args: number }
  /** `d[0].method(d[1], ..., d[args])`: `deps[0]` is the `@Factory` class. */
  | { readonly kind: 'method'; readonly method: string; readonly args: number }
  /** Extension factory: `generate(ctx, { cls, deps: d[0..args) })`. */
  | { readonly kind: 'custom'; readonly args: number; readonly generate: CustomFactory['generate'] }

/** Why a dependency is in a provider's `deps`. */
export type DependencyRole =
  /** Constructor, `@Provides` method or custom factory parameter. */
  | 'parameter'
  /** The `@Factory` instance of a `@Provides` provider (always `deps[0]`). */
  | 'factory'
  /** An interceptor instance referenced by `interceptors[method].chain[i].dep`. */
  | 'interceptor'

/** One entry of {@link ProviderNode.deps}. */
export interface DependencyNode {
  /** The runtime dependency reference (§3.2). */
  readonly ref: DependencyRef
  readonly role: DependencyRole
  /** Injection point in messages (`parameter 'repository' of UserService`). */
  readonly label: string
  readonly location: Location | undefined
  /** Requested type (after `Lazy<T>` / `T[]` / optional unwrapping for parameters). */
  readonly type: TypeInfo | undefined
}

/** One interceptor of a method chain (first = outermost). */
export interface InterceptorLinkNode {
  /** Index in {@link ProviderNode.deps}. */
  readonly dep: number
  readonly token: Token
  /** `false` when the decorator has no options argument (`options` is then `undefined`). */
  readonly hasOptions: boolean
  /** Options value; may be (or contain) a `ValueRef` to import. */
  readonly options: StaticValue
  /** Identity of the decorator (`@znight/core#Intercept`, `@znight/observability#Logged`). */
  readonly decorator: string
  readonly location: Location
}

/** Interceptors of one method. */
export interface InterceptedMethodNode {
  readonly method: string
  /** `async` keyword or `Promise` return type. */
  readonly async: boolean
  readonly chain: readonly InterceptorLinkNode[]
}

/** Kind of provider. */
export type ProviderKind = 'class' | 'provides' | 'custom'

/** A provider of the application. */
export interface ProviderNode {
  readonly token: Token
  /** Part of the token after the last `#` (`UserService`, `DbFactory.createPool`). */
  readonly displayName: string
  readonly kind: ProviderKind
  /** `'core'` (`@Injectable`, `@Factory`, `@Provides`), `'auto'` (helper class) or the extension name. */
  readonly registeredBy: string
  /** Identity of the provider class (`class`/`custom`) or of the `@Factory` class (`provides`). */
  readonly classIdentity: string
  /** Import route of that class from `outFile` (`undefined` when not importable: ZNIGHT005 was reported). */
  readonly importRoute: ImportRoute | undefined
  /** `provides` providers: the method name. */
  readonly method: string | undefined
  /** The provided type (the class for class providers, the unwrapped return type for `@Provides`). */
  readonly providedType: TypeInfo
  readonly scope: Scope
  /** The factory returns a promise (`@Provides` returning `Promise<T>`, async custom factories). */
  readonly async: boolean
  readonly deps: readonly DependencyNode[]
  readonly factory: FactoryNode
  /** Sorted by method name. */
  readonly interceptors: readonly InterceptedMethodNode[]
  /** `@Provides({ dispose })`. */
  readonly dispose: string | undefined
  /** Qualifier (`@Named`, `{ name }`). */
  readonly name: string | undefined
  readonly primary: boolean
  /** Lifecycle hooks of the class (or of the provided class for `@Provides`). */
  readonly lifecycle: readonly LifecycleHookInfo[]
  /** `ProviderDefinition.source` (path relative to the root). */
  readonly source: SourceLocation
  readonly location: Location
}

/** A token supplied at runtime by a plugin (manifest `provides`) or declared in `options.externals`. */
export interface ExternalNode {
  readonly token: Token
  readonly displayName: string
  readonly scope: Scope
  /** Plugin expected to provide it (messages). */
  readonly providedBy: string | undefined
  readonly optional: boolean
  readonly origin: 'manifest' | 'option'
}

/** `aliases[key] = token` (§4.7): a provided type, interface or base class bound to one provider. */
export interface AliasNode {
  /** Identity of the provided type / interface / base class. */
  readonly key: string
  readonly token: Token
}

/** Kind of a graph edge (used by validation). */
export type EdgeKind = 'dependency' | 'multi' | 'optional' | 'lazy' | 'interceptor' | 'factory' | 'extension'

/** A dependency edge between a provider and a provider or external. */
export interface GraphEdge {
  readonly from: Token
  readonly to: Token
  readonly kind: EdgeKind
  readonly label: string
  readonly location: Location | undefined
}

/** Extension data and the results of `bindInjection`. */
export interface ExtensionGraphData {
  readonly name: string
  readonly stored: readonly unknown[]
}

/** Reachability from roots (computed with `reportUnused` or `prune`). */
export interface Reachability {
  /** Root providers, sorted. */
  readonly roots: readonly Token[]
  /** Providers unreachable from any root, sorted. */
  readonly unreachable: readonly Token[]
}

/** The bound and validated application. */
export interface ApplicationGraph {
  /** Sorted by token. */
  readonly providers: readonly ProviderNode[]
  /** Externals referenced by at least one binding, sorted by token. */
  readonly externals: readonly ExternalNode[]
  /** Sorted by key. */
  readonly aliases: readonly AliasNode[]
  /** Topological (dependencies first); ties broken by token. */
  readonly resolutionOrder: readonly Token[]
  /** Every edge, sorted (from, to, kind). */
  readonly edges: readonly GraphEdge[]
  /** Data stored by each extension (extension order). */
  readonly extensions: readonly ExtensionGraphData[]
  /** Results of `AnalyzeContext.bindInjection`, by handle id (`undefined` when binding failed). */
  readonly bindings: ReadonlyMap<number, DependencyRef | undefined>
  readonly reachability: Reachability | undefined
  /** Sorted diagnostics of every phase (project layer included). */
  readonly diagnostics: readonly Diagnostic[]
}
