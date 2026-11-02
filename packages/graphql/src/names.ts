/**
 * GraphQL naming rules and built-in types (RFC 0005 §5.7, §6.4).
 *
 * Import-free: shared by the compiler extension (naming diagnostics, ZNIGHT061) and the runtime
 * (structural validation of `metadata.extensions.graphql` and the built-in scalars, ZNIGHT066).
 */

/** Grammar of a GraphQL name (types, fields, arguments, enum values). */
export const GRAPHQL_NAME: RegExp = /^[_A-Za-z][_0-9A-Za-z]*$/

/** `true` when `name` is a GraphQL name that user types may take (not reserved with `__`). */
export function isGraphQLName(name: string): boolean {
  return GRAPHQL_NAME.test(name) && !name.startsWith('__')
}

/** Names an enum value may not take (GraphQL spec §3.9). */
export const RESERVED_ENUM_VALUES: ReadonlySet<string> = new Set(['true', 'false', 'null'])

/** Names of the root operation types; user types may not take them (ZNIGHT061). */
export const ROOT_TYPE_NAMES: {
  readonly query: 'Query'
  readonly mutation: 'Mutation'
  readonly subscription: 'Subscription'
} = Object.freeze({ query: 'Query', mutation: 'Mutation', subscription: 'Subscription' })

/** Scalars of the GraphQL specification: always present, never declared in the metadata nor printed. */
export const SPECIFIED_SCALARS: ReadonlySet<string> = new Set(['String', 'Int', 'Float', 'Boolean', 'ID'])

/** A scalar `@znight/graphql` implements itself (`kind: 'scalar', builtin: true` in the metadata). */
export interface BuiltinScalarInfo {
  /** `@specifiedBy(url:)`. Absent: none. */
  readonly specifiedByURL?: string
}

/**
 * The scalars `@znight/graphql` implements (§5.7): `DateTime` (`Date`), `BigInt` (`bigint`) and
 * `JSON` (`JSONValue`). They have no description. The runtime builds them with exactly these
 * properties and without `valueToLiteral`, so that graphql-js `printSchema` and `printSdl()` agree.
 */
export const BUILTIN_SCALARS: ReadonlyMap<string, BuiltinScalarInfo> = new Map<string, BuiltinScalarInfo>([
  ['BigInt', {}],
  ['DateTime', { specifiedByURL: 'https://datatracker.ietf.org/doc/html/rfc3339' }],
  ['JSON', {}],
])

/** The default `@deprecated` reason of graphql-js: printed as a bare `@deprecated`. */
export const DEFAULT_DEPRECATION_REASON = 'No longer supported'
