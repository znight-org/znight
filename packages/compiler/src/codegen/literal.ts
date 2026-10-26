/**
 * The single literal emitter of the generated module (§3.3): every value that ends up in the
 * generated code (metadata fields, decorator options, extension data) is printed here.
 *
 * - `undefined`, `null`, booleans, strings (single-quoted, escaped), numbers including `NaN`,
 *   `±Infinity` and `-0`, bigints (`10n`);
 * - arrays and plain objects, nested; object keys are always computed string keys (`['key']: v`),
 *   so data never becomes syntax and `__proto__` is an own property;
 * - `RegExp` (`/source/flags`) and `Date` (`new Date(<epoch ms>)`);
 * - {@link ValueRef}s: imported by the generated module (the caller provides the reference doc);
 * - functions, symbols, cycles and other objects (class instances, `Map`, `Set`...) are rejected
 *   with a `TypeError`.
 */
import type { StaticValue } from '../project/index.ts'
import type { Doc } from './doc.ts'

import { ValueRef } from '../project/index.ts'
import { list } from './doc.ts'
import { quote } from './syntax.ts'

/** A value the literal emitter accepts. */
export type LiteralValue =
  | StaticValue
  | RegExp
  | Date
  | readonly LiteralValue[]
  | { readonly [key: string]: LiteralValue }

/** Prints a number (`-0`, `NaN`, `Infinity`, `-Infinity` included). */
export function numberLiteral(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN'
  }
  if (value === Number.POSITIVE_INFINITY) {
    return 'Infinity'
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '-Infinity'
  }
  if (Object.is(value, -0)) {
    return '-0'
  }
  return String(value)
}

/** Prints a primitive value, `undefined` when `value` is not a primitive. */
export function primitiveLiteral(value: unknown): string | undefined {
  switch (typeof value) {
    case 'undefined':
      return 'undefined'
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return numberLiteral(value)
    case 'bigint':
      return `${value}n`
    case 'string':
      return quote(value)
    case 'object':
      return value === null ? 'null' : undefined
    default:
      return undefined
  }
}

/**
 * Prints `value` as a JavaScript expression.
 *
 * @param reference prints a {@link ValueRef} (registers the import and returns its name)
 * @throws TypeError for functions, symbols, cycles and non-plain objects
 */
export function literalDoc(value: unknown, reference: (ref: ValueRef) => Doc): Doc {
  return print(value, reference, new Set())
}

function print(value: unknown, reference: (ref: ValueRef) => Doc, stack: Set<object>): Doc {
  const primitive = primitiveLiteral(value)
  if (primitive !== undefined) {
    return primitive
  }
  if (typeof value === 'function') {
    throw new TypeError('[znight] functions cannot be emitted as literals, use a node builder')
  }
  if (typeof value === 'symbol') {
    throw new TypeError('[znight] symbols cannot be emitted as literals')
  }
  const object = value as object
  if (object instanceof ValueRef) {
    return reference(object)
  }
  if (object instanceof RegExp) {
    return `/${object.source}/${object.flags}`
  }
  if (object instanceof Date) {
    return `new Date(${numberLiteral(object.getTime())})`
  }
  if (stack.has(object)) {
    throw new TypeError('[znight] cyclic values cannot be emitted as literals')
  }
  stack.add(object)
  try {
    if (Array.isArray(object)) {
      const items: Doc[] = []
      for (let index = 0; index < object.length; index++) {
        items.push(print(object[index], reference, stack))
      }
      return list('[', ']', items)
    }
    const prototype = Object.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `[znight] only plain objects, arrays, RegExp and Date can be emitted as literals (got ${describe(object)})`,
      )
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new TypeError('[znight] objects with symbol keys cannot be emitted as literals')
    }
    const record = object as Readonly<Record<string, unknown>>
    const entries = Object.keys(record).map(key => [`[${quote(key)}]: `, print(record[key], reference, stack)])
    return list('{', '}', entries, { spaced: true })
  } finally {
    stack.delete(object)
  }
}

function describe(value: object): string {
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name
  return typeof name === 'string' && name !== '' ? `an instance of ${name}` : 'an object with a custom prototype'
}
