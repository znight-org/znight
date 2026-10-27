/**
 * Implementation of {@link GenerateContext} (§6.5): the pure node builders plus the operations that
 * need the module being generated (imports, constants, tokens, bindings).
 */
import type { DependencyRef, Token } from '@znight/core'
import type { ArgInfo, BindingHandle, ClassInfo, ClassRef, TypeHelpers } from '../extensions/api.ts'
import type { GenBuilders, GenerateContext, GenImport, GenInput, GenNode } from '../extensions/generate.ts'
import type { ApplicationGraph, ProviderNode } from '../graph/types.ts'
import type { ResolvedOptions } from '../options.ts'
import type { Diagnostic } from '../project/index.ts'
import type { ModuleBuilder, Owner } from './module.ts'

import { createGenBuilders, freeze, isBuiltNode } from '../extensions/generate.ts'
import { isBareSpecifier, ValueRef } from '../project/index.ts'
import { isSafeIdentifier } from './syntax.ts'

/** Graph lookups shared by the generation contexts of one module. */
export class GraphIndex {
  readonly graph: ApplicationGraph
  readonly #providers: ReadonlyMap<Token, ProviderNode>
  readonly #aliases: ReadonlyMap<string, Token>
  readonly #externals: ReadonlySet<Token>

  constructor(graph: ApplicationGraph) {
    this.graph = graph
    this.#providers = new Map(graph.providers.map(provider => [provider.token, provider]))
    this.#aliases = new Map(graph.aliases.map(alias => [alias.key, alias.token]))
    this.#externals = new Set(graph.externals.map(external => external.token))
  }

  provider(token: Token): ProviderNode | undefined {
    return this.#providers.get(token)
  }

  /** Provider (or external) token of an identity, resolving aliases. */
  tokenOf(identity: string): Token | undefined {
    if (this.#providers.has(identity) || this.#externals.has(identity)) {
      return identity
    }
    return this.#aliases.get(identity)
  }
}

/** {@link GenerateContext} of one extension (or of the core generator for custom factories). */
export class ExtensionGenerateContext implements GenerateContext<unknown> {
  readonly extension: string
  readonly options: ResolvedOptions
  readonly types: TypeHelpers
  readonly graph: ApplicationGraph
  readonly stored: readonly unknown[]
  readonly lit: GenBuilders['lit']
  readonly obj: GenBuilders['obj']
  readonly arr: GenBuilders['arr']
  readonly ref: GenBuilders['ref']
  readonly member: GenBuilders['member']
  readonly call: GenBuilders['call']
  readonly construct: GenBuilders['construct']
  readonly arrow: GenBuilders['arrow']
  readonly code: GenBuilders['code']
  readonly #module: ModuleBuilder
  readonly #index: GraphIndex
  readonly #owner: () => Owner
  readonly #report: (diagnostic: Diagnostic) => void

  constructor(input: {
    readonly extension: string
    readonly module: ModuleBuilder
    readonly index: GraphIndex
    readonly stored: readonly unknown[]
    /** Owner of the nodes built through this context (changes between factories and the section). */
    readonly owner: () => Owner
    readonly report: (diagnostic: Diagnostic) => void
    /** Type helpers of the analysis (shapes computed during validation are reused). */
    readonly types: TypeHelpers
  }) {
    const builders = createGenBuilders()
    this.lit = builders.lit
    this.obj = builders.obj
    this.arr = builders.arr
    this.ref = builders.ref
    this.member = builders.member
    this.call = builders.call
    this.construct = builders.construct
    this.arrow = builders.arrow
    this.code = builders.code
    this.extension = input.extension
    this.types = input.types
    this.options = input.module.project.options
    this.graph = input.index.graph
    this.stored = input.stored
    this.#module = input.module
    this.#index = input.index
    this.#owner = input.owner
    this.#report = input.report
  }

  binding(handle: BindingHandle): DependencyRef | undefined {
    return this.graph.bindings.get(handle.id)
  }

  provider(token: Token): ProviderNode | undefined {
    return this.#index.provider(token)
  }

  importValue(target: ValueRef | ArgInfo | ClassInfo | ClassRef | string): GenNode {
    return importNode(target, false)
  }

  importType(target: ValueRef | ArgInfo | ClassInfo | ClassRef | string): GenNode {
    return importNode(target, true)
  }

  importFrom(module: string, name: string, options: { readonly type?: boolean } = {}): GenNode {
    if (typeof module !== 'string' || !isBareSpecifier(module)) {
      throw new TypeError(`[znight] importFrom() takes a package specifier (got ${JSON.stringify(module)})`)
    }
    if (typeof name !== 'string' || name === '') {
      throw new TypeError('[znight] importFrom() takes a non-empty export name')
    }
    return freeze<GenImport>({
      kind: 'gen:import',
      target: { kind: 'module', module, name },
      typeOnly: options.type === true,
    })
  }

  tokenOf(target: ClassInfo | ClassRef | string): Token | undefined {
    if (typeof target === 'string') {
      return this.#index.tokenOf(target)
    }
    if ('token' in target && typeof target.token === 'string') {
      return this.#index.tokenOf(target.token)
    }
    return this.#index.tokenOf((target as ClassInfo).identity)
  }

  constant(name: string, value: GenInput, options: { readonly type?: GenNode } = {}): GenNode {
    if (typeof name !== 'string' || !isSafeIdentifier(name)) {
      throw new TypeError(`[znight] constant(): invalid name ${JSON.stringify(name)}`)
    }
    const node = isBuiltNode(value) ? value : this.lit(value as never)
    const type = options.type
    if (type !== undefined && !isBuiltNode(type)) {
      throw new TypeError('[znight] constant(): the type must be a node')
    }
    const owner = this.#owner()
    return freeze(
      this.#module.constant(`${this.extension}\0${name}`, name, () => ({
        value: this.#module.print(node, owner),
        type: type === undefined ? undefined : this.#module.print(type, owner),
      })),
    )
  }

  report(diagnostic: Diagnostic): void {
    this.#report(diagnostic)
  }
}

/** A {@link GenImport} node for an import target. */
export function importNode(target: ValueRef | ArgInfo | ClassInfo | ClassRef | string, typeOnly: boolean): GenNode {
  if (target instanceof ValueRef) {
    return freeze<GenImport>({ kind: 'gen:import', target: { kind: 'ref', ref: target }, typeOnly })
  }
  if (typeof target === 'string') {
    if (!target.includes('#')) {
      throw new TypeError(`[znight] '${target}' is not a canonical identity (expected '<module>#<Name>')`)
    }
    return freeze<GenImport>({ kind: 'gen:import', target: { kind: 'identity', identity: target }, typeOnly })
  }
  if (typeof target !== 'object' || target === null) {
    throw new TypeError('[znight] cannot import this value')
  }
  if ('node' in target && 'text' in target && 'kind' in target && !('identity' in target)) {
    const arg = target as ArgInfo
    if (!arg.ref) {
      throw new TypeError(`[znight] '${arg.text}' is not a reference to an exported binding`)
    }
    return freeze<GenImport>({ kind: 'gen:import', target: { kind: 'ref', ref: arg.ref }, typeOnly })
  }
  const identity = (target as { identity?: unknown }).identity
  if (typeof identity !== 'string') {
    throw new TypeError('[znight] cannot import this value')
  }
  return freeze<GenImport>({ kind: 'gen:import', target: { kind: 'identity', identity }, typeOnly })
}
