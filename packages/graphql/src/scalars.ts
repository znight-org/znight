/**
 * Scalars of `@znight/graphql` (RFC 0005 §5.7): the built-in `DateTime`, `BigInt` and `JSON`, and
 * the graphql-js 17 scalar built from a user `ScalarDefinition` (`scalar<T>(name, definition)`).
 *
 * Built-in scalars have no description and no `valueToLiteral`, with the `specifiedByURL` of
 * `BUILTIN_SCALARS`, so that graphql-js `printSchema()` prints what `printSdl()` prints (§7.3).
 */
import type { ConstValueNode } from 'graphql'
import type { ScalarDefinition } from './types.ts'

import { GraphQLScalarType, Kind, valueFromASTUntyped } from 'graphql'

import { BUILTIN_SCALARS } from './names.ts'

/** RFC 3339 date-time with a mandatory offset (`2026-11-02T10:00:00Z`, `...+01:00`). */
const DATE_TIME =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/

/** An integer in decimal notation (`BigInt` on the wire). */
const DECIMAL_INTEGER = /^-?\d+$/

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (value === null || typeof value !== 'object') return String(value)
  return Array.isArray(value) ? 'a list' : 'an object'
}

function parseDateTime(value: unknown): Date {
  if (typeof value === 'string' && DATE_TIME.test(value)) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
  }
  throw new TypeError(`DateTime cannot represent ${describe(value)}: expected an RFC 3339 date-time with an offset`)
}

function serializeDateTime(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('DateTime cannot represent an invalid Date')
    return value.toISOString()
  }
  if (typeof value === 'string' && DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))) return value
  throw new TypeError(`DateTime cannot represent ${describe(value)}: expected a Date`)
}

function parseBigInt(value: unknown): bigint {
  if (typeof value === 'string' && DECIMAL_INTEGER.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  throw new TypeError(`BigInt cannot represent ${describe(value)}: expected an integer as a decimal string`)
}

function serializeBigInt(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && DECIMAL_INTEGER.test(value)) return value
  throw new TypeError(`BigInt cannot represent ${describe(value)}: expected a bigint`)
}

function identity(value: unknown): unknown {
  return value
}

function specifiedBy(name: string): { specifiedByURL?: string } {
  const url = BUILTIN_SCALARS.get(name)?.specifiedByURL
  return url === undefined ? {} : { specifiedByURL: url }
}

function createBuiltin(name: string): GraphQLScalarType | undefined {
  switch (name) {
    case 'DateTime':
      return new GraphQLScalarType<Date, string>({
        name,
        ...specifiedBy(name),
        coerceOutputValue: serializeDateTime,
        coerceInputValue: parseDateTime,
        coerceInputLiteral: (node: ConstValueNode) => parseDateTime(node.kind === Kind.STRING ? node.value : node),
      })
    case 'BigInt':
      return new GraphQLScalarType<bigint, string>({
        name,
        ...specifiedBy(name),
        coerceOutputValue: serializeBigInt,
        coerceInputValue: parseBigInt,
        coerceInputLiteral: (node: ConstValueNode) =>
          parseBigInt(node.kind === Kind.STRING || node.kind === Kind.INT ? node.value : node),
      })
    case 'JSON':
      return new GraphQLScalarType<unknown, unknown>({
        name,
        ...specifiedBy(name),
        coerceOutputValue: identity,
        coerceInputValue: identity,
        coerceInputLiteral: (node: ConstValueNode) => valueFromASTUntyped(node),
      })
    default:
      return undefined
  }
}

/** Built-in scalars, created on first use and shared by every schema (they hold no state). */
const builtins = new Map<string, GraphQLScalarType>()

/** The built-in scalar `name` (`DateTime`, `BigInt`, `JSON`), `undefined` for another name. */
export function builtinScalar(name: string): GraphQLScalarType | undefined {
  let scalar = builtins.get(name)
  if (scalar === undefined) {
    scalar = createBuiltin(name)
    if (scalar !== undefined) builtins.set(name, scalar)
  }
  return scalar
}

/**
 * The graphql-js scalar of a {@link ScalarDefinition}: `serialize` → `coerceOutputValue`,
 * `parseValue` → `coerceInputValue`, `parseLiteral` → `coerceInputLiteral` (default: `parseValue`
 * of the literal's JSON value). The definition's methods are called on the definition.
 */
export function definitionScalar(
  name: string,
  definition: ScalarDefinition<unknown>,
  overrides: { readonly description?: string; readonly specifiedByURL?: string } = {},
): GraphQLScalarType {
  const parseLiteral = definition.parseLiteral
  const description = overrides.description ?? definition.description
  const specifiedByURL = overrides.specifiedByURL ?? definition.specifiedByURL
  return new GraphQLScalarType({
    name,
    ...(description === undefined ? {} : { description }),
    ...(specifiedByURL === undefined ? {} : { specifiedByURL }),
    coerceOutputValue: (value: unknown) => definition.serialize(value),
    coerceInputValue: (value: unknown) => definition.parseValue(value),
    coerceInputLiteral:
      parseLiteral === undefined
        ? (node: ConstValueNode) => definition.parseValue(valueFromASTUntyped(node))
        : (node: ConstValueNode) => parseLiteral.call(definition, node),
  })
}
