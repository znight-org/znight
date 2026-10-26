/**
 * Implementations of {@link AnalyzeContext} and {@link ValidateContext} handed to compiler
 * extensions.
 */
import type { DependencyRef, Scope, Token } from '@znight/core'
import type { Reporter } from '../analysis/arguments.ts'
import type { ClassAnalyzer } from '../analysis/class-analyzer.ts'
import type { ProviderBuilder } from '../analysis/providers.ts'
import type { ExtensionBinding, ExtensionEdge } from '../graph/build.ts'
import type { ApplicationGraph, ProviderNode } from '../graph/types.ts'
import type { ResolvedOptions } from '../options.ts'
import type { Diagnostic, Project, TypeInfo, ValueRef } from '../project/index.ts'
import type {
  AnalyzeContext,
  ArgInfo,
  BindingHandle,
  ClassInfo,
  ClassRef,
  ClassRefOptions,
  DependencyDetails,
  InjectionRequest,
  ProviderRegistration,
  TypeHelpers,
  ValidateContext,
} from './api.ts'

import { ErrorCode } from '@znight/core'

import { awaitedType, stripNullish } from '../binding/injection.ts'
import { displayNameOf, formatType, referenceType, serializeType, typesEqual } from '../project/index.ts'

/** Type helpers exposed to extensions. */
export const TYPE_HELPERS: TypeHelpers = Object.freeze({
  format: formatType,
  serialize: serializeType,
  equals: typesEqual,
  stripNullish,
  awaited: awaitedType,
})

const SCOPES: readonly Scope[] = ['singleton', 'request', 'transient']

/** State shared by the analysis contexts of every extension. */
export interface AnalysisState {
  readonly project: Project
  readonly analyzer: ClassAnalyzer
  readonly builder: ProviderBuilder
  readonly classes: ReadonlyMap<string, ClassInfo>
  readonly report: Reporter
  readonly edges: ExtensionEdge[]
  readonly bindings: ExtensionBinding[]
  readonly stored: Map<string, unknown[]>
  nextBindingId: number
}

/** {@link AnalyzeContext} of one extension. */
export class ExtensionAnalyzeContext implements AnalyzeContext<unknown> {
  readonly extension: string
  readonly project: Project
  readonly options: ResolvedOptions
  readonly types: TypeHelpers = TYPE_HELPERS
  readonly #state: AnalysisState

  constructor(extension: string, state: AnalysisState) {
    this.extension = extension
    this.project = state.project
    this.options = state.project.options
    this.#state = state
  }

  registerProvider(cls: ClassInfo, registration: ProviderRegistration = {}): Token {
    const scope = registration.scope ?? 'singleton'
    const decorator = ownedDecorators(cls, this.extension)[0]
    const location = decorator?.location ?? cls.location
    if (!SCOPES.includes(scope)) {
      this.report({
        code: ErrorCode.InvalidDecorator,
        severity: 'error',
        message: `Invalid scope ${JSON.stringify(scope)} for ${cls.displayName} (extension '${this.extension}')`,
        location,
      })
    }
    if (registration.factory && typeof registration.factory.generate !== 'function') {
      throw new TypeError(
        `[znight] extension '${this.extension}': registerProvider factory.generate must be a function`,
      )
    }
    return this.#state.builder.registerClass(cls, {
      registeredBy: this.extension,
      registeredWith: decorator ? `@${decorator.name}` : `extension '${this.extension}'`,
      registration: location,
      scope: SCOPES.includes(scope) ? scope : 'singleton',
      name: registration.name,
      primary: registration.primary,
      custom: registration.factory,
    })
  }

  resolveClassRef(arg: ArgInfo | ValueRef, options: ClassRefOptions = {}): ClassRef | undefined {
    const role = options.role ?? 'class'
    const ref = this.#state.builder.classRef(arg, role, undefined)
    if (ref && options.from !== undefined) {
      this.#state.edges.push({ from: tokenOf(options.from), to: ref.token, location: ref.location, reason: role })
    }
    return ref
  }

  bindInjection(request: InjectionRequest, options: { readonly from?: ClassInfo | Token } = {}): BindingHandle {
    const id = this.#state.nextBindingId++
    const from = options.from === undefined ? undefined : tokenOf(options.from)
    const type: TypeInfo =
      typeof request.type === 'string' ? referenceType(request.type, displayNameOf(request.type), []) : request.type
    const label = request.label ?? `injection of '${formatType(type)}' (extension '${this.extension}')`
    this.#state.bindings.push({
      id,
      from,
      site: {
        owner: from === undefined ? `extension '${this.extension}'` : displayNameOf(from),
        label,
        subject: label.charAt(0).toUpperCase() + label.slice(1),
        location: request.location,
        spec: { type, qualifier: request.qualifier, optional: request.optional === true },
        rest: false,
      },
    })
    return Object.freeze({ id })
  }

  addDependency(from: ClassInfo | Token, to: Token | ClassRef, details: DependencyDetails = {}): void {
    this.#state.edges.push({
      from: tokenOf(from),
      to: typeof to === 'string' ? to : to.token,
      location: details.location ?? (typeof to === 'string' ? undefined : to.location),
      reason: details.reason ?? `dependency (extension '${this.extension}')`,
    })
  }

  classInfo(identity: string): ClassInfo | undefined {
    return this.#state.classes.get(identity) ?? this.#state.analyzer.infoOfIdentity(identity)
  }

  report(diagnostic: Diagnostic): void {
    this.#state.report(diagnostic)
  }

  store(data: unknown): void {
    let list = this.#state.stored.get(this.extension)
    if (!list) {
      list = []
      this.#state.stored.set(this.extension, list)
    }
    list.push(data)
  }
}

/** {@link ValidateContext} of one extension. */
export class ExtensionValidateContext implements ValidateContext<unknown> {
  readonly extension: string
  readonly project: Project
  readonly options: ResolvedOptions
  readonly types: TypeHelpers = TYPE_HELPERS
  readonly graph: ApplicationGraph
  readonly stored: readonly unknown[]
  readonly #providers: ReadonlyMap<Token, ProviderNode>
  readonly #state: AnalysisState

  constructor(extension: string, state: AnalysisState, graph: ApplicationGraph) {
    this.extension = extension
    this.project = state.project
    this.options = state.project.options
    this.graph = graph
    this.stored = state.stored.get(extension) ?? []
    this.#providers = new Map(graph.providers.map(provider => [provider.token, provider]))
    this.#state = state
  }

  provider(token: Token): ProviderNode | undefined {
    return this.#providers.get(token)
  }

  classInfo(identity: string): ClassInfo | undefined {
    return this.#state.classes.get(identity) ?? this.#state.analyzer.infoOfIdentity(identity)
  }

  binding(handle: BindingHandle): DependencyRef | undefined {
    return this.graph.bindings.get(handle.id)
  }

  report(diagnostic: Diagnostic): void {
    this.#state.report(diagnostic)
  }
}

/** Decorators of a class (class, members, parameters) owned by an extension, in source order. */
export function ownedDecorators(cls: ClassInfo, owner: string): ClassInfo['decorators'][number][] {
  const found = cls.decorators.filter(decorator => decorator.owner === owner)
  if (cls.ctor.declaredBy === cls.identity) {
    for (const param of cls.ctor.params) {
      found.push(...param.decorators.filter(decorator => decorator.owner === owner))
    }
  }
  for (const method of cls.methods) {
    found.push(...method.decorators.filter(decorator => decorator.owner === owner))
    for (const param of method.params) {
      found.push(...param.decorators.filter(decorator => decorator.owner === owner))
    }
  }
  for (const property of cls.properties) {
    found.push(...property.decorators.filter(decorator => decorator.owner === owner))
  }
  return found
}

function tokenOf(target: ClassInfo | Token): Token {
  return typeof target === 'string' ? target : target.identity
}
