/**
 * GraphQL errors shown to clients (RFC 0005 §5.10, §8.8): `GraphQLException` and the
 * `extensions.code` values the plugin produces (Apollo conventions, which clients already know).
 *
 * Import-free: the exception is a plain `Error` subclass, rendered by the runtime as
 * `{ message, locations, path, extensions: { code, ...extensions } }`.
 */

/** `extensions.code` values produced by `@znight/graphql`. Applications may use their own codes too. */
export const GraphQLErrorCode: {
  /** The document does not parse (syntax error, `limits.maxTokens`). */
  readonly ParseFailed: 'GRAPHQL_PARSE_FAILED'
  /** The document is not valid against the schema. */
  readonly ValidationFailed: 'GRAPHQL_VALIDATION_FAILED'
  /** Invalid variables or arguments (Standard Schema issues in `extensions.issues`), HTTP 400. */
  readonly BadUserInput: 'BAD_USER_INPUT'
  /** The document exceeds `limits.maxDepth`, `maxAliases` or `maxDirectives`. */
  readonly QueryTooComplex: 'QUERY_TOO_COMPLEX'
  /** HTTP 401. */
  readonly Unauthenticated: 'UNAUTHENTICATED'
  /** A guard returned `false`, or HTTP 403. */
  readonly Forbidden: 'FORBIDDEN'
  /** HTTP 404, or a key missing from `orderByKeys`. */
  readonly NotFound: 'NOT_FOUND'
  /** HTTP 409. */
  readonly Conflict: 'CONFLICT'
  /** HTTP 429. */
  readonly TooManyRequests: 'TOO_MANY_REQUESTS'
  /** Any other HTTP 4xx. */
  readonly BadRequest: 'BAD_REQUEST'
  /** A subscriber fell behind its buffer: its stream ends with this error. */
  readonly SubscriptionOverflow: 'SUBSCRIPTION_OVERFLOW'
  /** Too many active subscriptions (`subscriptions.maxActive`), HTTP 503. */
  readonly ServiceUnavailable: 'SERVICE_UNAVAILABLE'
  /** An unexpected error, masked (`Unexpected error.`) unless `exposeErrors`. */
  readonly InternalServerError: 'INTERNAL_SERVER_ERROR'
} = Object.freeze({
  ParseFailed: 'GRAPHQL_PARSE_FAILED',
  ValidationFailed: 'GRAPHQL_VALIDATION_FAILED',
  BadUserInput: 'BAD_USER_INPUT',
  QueryTooComplex: 'QUERY_TOO_COMPLEX',
  Unauthenticated: 'UNAUTHENTICATED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  TooManyRequests: 'TOO_MANY_REQUESTS',
  BadRequest: 'BAD_REQUEST',
  SubscriptionOverflow: 'SUBSCRIPTION_OVERFLOW',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  InternalServerError: 'INTERNAL_SERVER_ERROR',
})

/** One of the {@link GraphQLErrorCode} values. */
export type GraphQLErrorCodeValue = (typeof GraphQLErrorCode)[keyof typeof GraphQLErrorCode]

/** Options of {@link GraphQLException}. */
export interface GraphQLExceptionOptions {
  /** `extensions.code` (`'NOT_FOUND'`, `'CONFLICT'`, or an application code). */
  readonly code: GraphQLErrorCodeValue | (string & Record<never, never>)
  /** Extra `extensions` entries, sent to the client (`code` always wins). */
  readonly extensions?: Readonly<Record<string, unknown>>
  /**
   * The original error: never sent, logged once at `error` level with the request id, the schema
   * coordinate and the path when the exception is shown for a field.
   */
  readonly cause?: unknown
}

/**
 * An error whose message and extensions are sent to the client as they are (§5.10): throw it from a
 * resolver or return it from a `GraphQLErrorMapper`.
 *
 * ```ts
 * throw new GraphQLException(`No book ${id}`, { code: 'NOT_FOUND', extensions: { bookId: id } })
 * ```
 */
export class GraphQLException extends Error {
  /** `extensions.code`. */
  readonly code: string
  /** Extra `extensions` entries. */
  readonly extensions: Readonly<Record<string, unknown>> | undefined

  constructor(message: string, options: GraphQLExceptionOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GraphQLException'
    this.code = options.code
    this.extensions = options.extensions
  }
}
