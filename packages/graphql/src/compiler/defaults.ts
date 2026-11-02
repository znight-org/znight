/**
 * Default values of arguments and input fields (RFC 0005 §6.3): an internal value (a `@default`
 * JSON value, a statically evaluated parameter default) checked against its GraphQL type and turned
 * into the external value graphql-js expects (`default: { value }`, enum values by name).
 */
import type { GraphQLTypeRef } from '../type-ref.ts'
import type { TypeModel } from './model.ts'

const GRAPHQL_INT_MAX = 2_147_483_647
const GRAPHQL_INT_MIN = -2_147_483_648

/** The external value, or why the value does not fit the type. */
export type ExternalValue = { readonly value: unknown } | { readonly error: string }

/** `value` (an internal value) as a GraphQL external value of `ref`; `types` resolves enums and inputs. */
export function externalValue(
  value: unknown,
  ref: GraphQLTypeRef,
  types: ReadonlyMap<string, TypeModel>,
): ExternalValue {
  if (value === null) return ref.nonNull ? { error: 'null for a non-null type' } : { value: null }
  if (value === undefined) return { error: 'undefined' }
  if (ref.kind === 'list') {
    if (!Array.isArray(value)) return externalValue(value, ref.of, types)
    const items: unknown[] = []
    for (const item of value) {
      const converted = externalValue(item, ref.of, types)
      if ('error' in converted) return converted
      items.push(converted.value)
    }
    return { value: items }
  }
  switch (ref.name) {
    case 'String':
      return typeof value === 'string' ? { value } : { error: 'expected a string' }
    case 'ID':
      return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
        ? { value }
        : { error: 'expected a string or an integer' }
    case 'Int':
      return typeof value === 'number' &&
        Number.isInteger(value) &&
        value <= GRAPHQL_INT_MAX &&
        value >= GRAPHQL_INT_MIN
        ? { value }
        : { error: 'expected a 32-bit integer' }
    case 'Float':
      return typeof value === 'number' && Number.isFinite(value) ? { value } : { error: 'expected a finite number' }
    case 'Boolean':
      return typeof value === 'boolean' ? { value } : { error: 'expected a boolean' }
    case 'JSON':
      return isJson(value) ? { value } : { error: 'expected a JSON value' }
  }
  const type = types.get(ref.name)
  if (type?.kind === 'enum') {
    const found =
      type.values.find(entry => entry.value === value) ??
      (typeof value === 'string' ? type.values.find(entry => entry.name === value) : undefined)
    return found === undefined
      ? { error: `expected one of ${type.values.map(entry => entry.name).join(', ')}` }
      : { value: found.name }
  }
  if (type?.kind === 'input') {
    if (typeof value !== 'object' || Array.isArray(value)) return { error: `expected an object of type ${type.name}` }
    const record = value as Readonly<Record<string, unknown>>
    for (const key of Object.keys(record)) {
      if (!type.fields.some(field => field.name === key)) return { error: `${type.name} has no field '${key}'` }
    }
    const result: Record<string, unknown> = {}
    for (const field of type.fields) {
      if (!Object.hasOwn(record, field.name) || record[field.name] === undefined) {
        if (field.ref.nonNull && field.defaultValue === undefined)
          return { error: `${type.name}.${field.name} is required` }
        continue
      }
      const converted = externalValue(record[field.name], field.ref, types)
      if ('error' in converted) return { error: `${type.name}.${field.name}: ${converted.error}` }
      result[field.name] = converted.value
    }
    return { value: result }
  }
  return { error: `defaults of the scalar ${ref.name} are not supported` }
}

/** A JSON-compatible value (the `JSON` scalar). */
function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJson)
}
