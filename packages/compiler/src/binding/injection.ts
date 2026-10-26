/**
 * Normalization of injection points (§4.7): optionality (`?`, `| undefined`, `| null`, default value,
 * `@Optional()`), `Lazy<T>`, multi (`T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>`) and value
 * types (primitives / opaque types, matched by qualifier).
 */
import type { TypeInfo } from '../project/index.ts'

import { LAZY_IDENTITY } from '../analysis/core-decorators.ts'
import { formatType, unionType } from '../project/index.ts'

/** What an injection point asks for. */
export interface InjectionSpec {
  readonly type: TypeInfo
  readonly qualifier: string | undefined
  /** Explicit optionality: `?`, default value, `@Optional()`, `InjectionRequest.optional`. */
  readonly optional: boolean
}

/** A normalized injection point. */
export interface NormalizedInjection {
  /** The type to bind (`T` of `Lazy<T>`, `T[]`, `T | undefined`). */
  readonly type: TypeInfo
  readonly qualifier: string | undefined
  readonly optional: boolean
  readonly multi: boolean
  readonly lazy: boolean
  /**
   * Primitive, literal, union, opaque... types: they have no identity and are matched by
   * `(qualifier, kind)` (§4.7.6).
   */
  readonly valueLike: boolean
}

/** Result of {@link normalizeInjection}: the normalized point or a ZNIGHT010 problem. */
export type NormalizationResult =
  | { readonly ok: true; readonly injection: NormalizedInjection }
  | { readonly ok: false; readonly message: string; readonly hints: readonly string[] }

/** Removes `undefined`, `null` and `void` from a union. */
export function stripNullish(type: TypeInfo): { readonly type: TypeInfo; readonly nullable: boolean } {
  if (isNullish(type)) {
    return { type, nullable: false }
  }
  if (type.kind !== 'union') {
    return { type, nullable: false }
  }
  const kept = type.types.filter(member => !isNullish(member))
  if (kept.length === type.types.length) {
    return { type, nullable: false }
  }
  return { type: unionType(kept), nullable: true }
}

function isNullish(type: TypeInfo): boolean {
  return type.kind === 'primitive' && (type.name === 'undefined' || type.name === 'null' || type.name === 'void')
}

/** `Promise<T>` → `T`. */
export function awaitedType(type: TypeInfo): TypeInfo {
  return type.kind === 'promise' ? type.inner : type
}

/** `true` for `Lazy<T>` references. */
export function isLazy(type: TypeInfo): boolean {
  return type.kind === 'reference' && type.identity === LAZY_IDENTITY
}

/**
 * Normalizes an injection point. `subject` names it in messages (`parameter 'repo'`).
 */
export function normalizeInjection(spec: InjectionSpec, subject: string): NormalizationResult {
  let optional = spec.optional
  let { type, nullable } = stripNullish(spec.type)
  optional ||= nullable
  let lazy = false
  if (type.kind === 'reference' && isLazy(type)) {
    const [inner] = type.typeArgs
    if (inner === undefined || type.typeArgs.length !== 1) {
      return problem(`${subject}: Lazy must have exactly one type argument (Lazy<T>)`, [
        'Write Lazy<Service> with the type to resolve lazily',
      ])
    }
    lazy = true
    const unwrapped = stripNullish(inner)
    type = unwrapped.type
    optional ||= unwrapped.nullable
    if (isLazy(type)) {
      return problem(`${subject}: Lazy<Lazy<T>> is not supported`, ['Inject Lazy<T>'])
    }
  }
  if (type.kind === 'promise') {
    return problem(`${subject}: Promise<${formatType(type.inner)}> cannot be injected`, [
      `Inject ${formatType(type.inner)}: async singletons are resolved before they are injected`,
      'Use Lazy<T> to resolve a provider at call time',
    ])
  }
  let multi = false
  if (type.kind === 'array') {
    const element = stripNullish(type.element).type
    if (element.kind === 'reference' && !isLazy(element)) {
      if (lazy) {
        return problem(`${subject}: Lazy<${formatType(type)}> is not supported`, [
          `Inject ${formatType(type)} (every provider) or Lazy<${formatType(element)}> (one provider)`,
        ])
      }
      multi = true
      type = element
    }
  }
  if (type.kind === 'opaque' && type.reason === 'unresolved') {
    return problem(`${subject}: the type '${type.text}' cannot be resolved`, [
      'Check the import of the type (module path, exported name)',
    ])
  }
  if (type.kind === 'typeParameter') {
    return problem(`${subject}: the type parameter '${type.name}' is not bound to a concrete type`, [
      'Extend the generic class with concrete type arguments',
    ])
  }
  const valueLike = type.kind !== 'reference'
  if (valueLike && spec.qualifier === undefined) {
    return valueWithoutQualifier(type, subject)
  }
  return { ok: true, injection: { type, qualifier: spec.qualifier, optional, multi, lazy, valueLike } }
}

function valueWithoutQualifier(type: TypeInfo, subject: string): NormalizationResult {
  const qualify = "Qualify it with @Inject('name') and provide it with @Provides({ name: 'name' }) or @Named('name')"
  if (type.kind === 'opaque') {
    if (type.reason === 'missing-annotation') {
      return problem(`${subject} has no type annotation`, ['Annotate it with the type to inject', qualify])
    }
    return problem(`${subject}: the type '${type.text}' cannot be injected (${describeOpaque(type.reason)})`, [
      'Declare an interface or a class and use it as the type',
      qualify,
    ])
  }
  if (type.kind === 'union' || type.kind === 'intersection') {
    return problem(`${subject}: the ${type.kind} type '${formatType(type)}' cannot be injected without a qualifier`, [
      'Inject a single class or interface type',
      qualify,
    ])
  }
  return problem(`${subject}: a value of type '${formatType(type)}' cannot be injected without a qualifier`, [qualify])
}

function describeOpaque(reason: string): string {
  switch (reason) {
    case 'object-literal':
      return 'object literal types are not analysed'
    case 'function':
    case 'constructor':
      return 'function types are not analysed'
    case 'typeof':
      return '`typeof` types are not analysed'
    case 'import-type':
      return '`import()` types are not analysed'
    case 'mapped':
    case 'conditional':
      return 'mapped and conditional types are not analysed'
    case 'recursive-alias':
      return 'recursive type aliases are not analysed'
    default:
      return 'this kind of type is not analysed'
  }
}

function problem(message: string, hints: readonly string[]): NormalizationResult {
  return { ok: false, message, hints }
}

/**
 * Kind of a value-like type for qualifier matching (§4.7.6): primitive names (literals widened),
 * unions of kinds, `kind[]`, `'opaque'` (matches anything).
 */
export function valueKind(type: TypeInfo): string {
  switch (type.kind) {
    case 'primitive':
      return type.name === 'any' || type.name === 'unknown' ? 'opaque' : type.name
    case 'literal':
      return typeof type.value
    case 'array': {
      const element = valueKind(type.element)
      return element === 'opaque' ? 'opaque' : `${element}[]`
    }
    case 'union': {
      const kinds = [...new Set(type.types.map(valueKind))].sort()
      return kinds.includes('opaque') ? 'opaque' : kinds.join(' | ')
    }
    case 'reference':
      return `ref:${type.identity}`
    default:
      return 'opaque'
  }
}

/** `true` when a provider of kind `provided` can satisfy an injection of kind `requested`. */
export function kindsCompatible(provided: string, requested: string): boolean {
  return provided === requested || provided === 'opaque' || requested === 'opaque'
}
