/**
 * Values produced by the static evaluator (§4.6).
 */
import type { Location } from './location.ts'
import type { SymbolResolution } from './symbols.ts'

/** Primitive static values. */
export type StaticPrimitive = string | number | boolean | bigint | null | undefined

/** An evaluated object literal (frozen). */
export interface StaticObject {
  readonly [key: string]: StaticValue
}

/** Result of a static evaluation. Arrays and objects are frozen. */
export type StaticValue = StaticPrimitive | readonly StaticValue[] | StaticObject | ValueRef

/** A reference to a binding that cannot be evaluated but can be imported by the generated module. */
export class ValueRef {
  readonly kind = 'ref'
  /** Canonical identity of the referenced binding (`undefined` when it has none). */
  readonly identity: string | undefined
  /** Display name of the identity (`Logger`, `tokens.Holder`). */
  readonly name: string
  /** Source text of the reference (`AuthGuard`, `schemas.CreateUser`). */
  readonly text: string
  /** What the reference resolves to (pass it to `Project.importRoute`). */
  readonly symbol: SymbolResolution
  /** Location of the reference in the evaluated expression. */
  readonly location: Location

  constructor(identity: string | undefined, name: string, text: string, symbol: SymbolResolution, location: Location) {
    this.identity = identity
    this.name = name
    this.text = text
    this.symbol = symbol
    this.location = location
    Object.freeze(this)
  }
}

/** `true` when the value contains a {@link ValueRef} (possible with `refs: 'nested'`). */
export function containsRef(value: StaticValue): boolean {
  if (value instanceof ValueRef) {
    return true
  }
  if (Array.isArray(value)) {
    return value.some(containsRef)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsRef)
  }
  return false
}

/** `true` for `null`, `undefined`, strings, numbers, booleans and bigints. */
export function isStaticPrimitive(value: StaticValue): value is StaticPrimitive {
  return value === null || typeof value !== 'object'
}

/** Short description of a value for messages (`number`, `an array`, `a reference to 'Guard'`...). */
export function describeValue(value: StaticValue): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  if (value instanceof ValueRef) {
    return `a reference to '${value.text}'`
  }
  return typeof value === 'object' ? 'an object' : typeof value
}
