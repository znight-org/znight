/**
 * Constants of the compiler extension modules: diagnostic codes, shape options, ordering. This
 * module must stay free of runtime imports (the compiler loads the extension entry, which must
 * never load the GraphQL runtime, graphql-js nor dataloader).
 */
import type { ErrorCode } from '@znight/core'

import { GraphQLIds } from './ids.ts'

/** Diagnostic codes the extension reports (RFC 0005 §6.6 and the reused framework codes). */
export const Codes: {
  /** ZNIGHT005: decorator target, arguments, method shape, look-alikes, `@Resolver` + `@Controller`. */
  readonly InvalidDecorator: ErrorCode
  /** ZNIGHT023: a root field without a decision of a required route decorator group (RFC 0001). */
  readonly MissingRouteDecision: ErrorCode
  /** ZNIGHT060: a TypeScript type with no GraphQL mapping, a missing annotation. */
  readonly InvalidType: ErrorCode
  /** ZNIGHT061: name conflicts, invalid or reserved names, field resolver type mismatches. */
  readonly NameConflict: ErrorCode
  /** ZNIGHT062: resolver structure (parent, subscriptions, no query, inheritance, libraries). */
  readonly InvalidResolver: ErrorCode
  /** ZNIGHT063: input position problems (dual use, getters, unions, cycles, defaults). */
  readonly InvalidInput: ErrorCode
  /** ZNIGHT064: union members that cannot be told apart at runtime. */
  readonly UnresolvableAbstractType: ErrorCode
  /** ZNIGHT065: `@Loader()` parameters and loader providers. */
  readonly InvalidLoader: ErrorCode
  /** ZNIGHT067: schema-first SDL files (RFC 0007): reading, syntax, validation, unsupported constructs. */
  readonly InvalidSdl: ErrorCode
  /** ZNIGHT068: schema-first resolvers against the SDL (RFC 0007): coverage and type conformance. */
  readonly SchemaMismatch: ErrorCode
} = Object.freeze({
  InvalidDecorator: 'ZNIGHT005',
  MissingRouteDecision: 'ZNIGHT023',
  InvalidType: 'ZNIGHT060',
  NameConflict: 'ZNIGHT061',
  InvalidResolver: 'ZNIGHT062',
  InvalidInput: 'ZNIGHT063',
  UnresolvableAbstractType: 'ZNIGHT064',
  InvalidLoader: 'ZNIGHT065',
  InvalidSdl: 'ZNIGHT067',
  SchemaMismatch: 'ZNIGHT068',
})

/** Root reason given to `AnalyzeContext.addRoot()`. */
export const ROOT_REASON = 'GraphQL resolver'

/** Async iterables: the return type of `@Subscription` methods (§6.2). */
export const ASYNC_ITERABLES: ReadonlySet<string> = new Set([
  'globalThis#AsyncIterable',
  'globalThis#AsyncIterableIterator',
  'globalThis#AsyncGenerator',
])

/** Iterables mapped to lists in output position (§6.2). */
export const OUTPUT_ITERABLES: ReadonlySet<string> = new Set([
  'globalThis#Set',
  'globalThis#ReadonlySet',
  'globalThis#Iterable',
])

/**
 * Identities the shapes keep as references (`ShapeOptions.keep`), before the identities of the
 * `scalar<T>()` declarations of the application.
 */
export const BASE_KEEP: readonly string[] = Object.freeze([
  ...ASYNC_ITERABLES,
  ...OUTPUT_ITERABLES,
  GraphQLIds.ID,
  GraphQLIds.Int,
  GraphQLIds.Float,
  GraphQLIds.JSONValue,
  GraphQLIds.Loader,
])

/** Deterministic string comparison (code-unit order, never `localeCompare`). */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
