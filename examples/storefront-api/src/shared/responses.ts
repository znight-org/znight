import type { ApiResponseOptions } from '@znight/openapi'

/*
 * Error responses shared by many routes, for `@ApiResponse(401, UNAUTHORIZED)`. Decorator arguments
 * are read by the compiler, so they must be statically evaluable: literals, or `const` references
 * like these. Without a `schema`, a documented 4XX response gets the standard error envelope
 * (`HttpErrorBody`).
 *
 * `401` and `403` are not inferred from the security requirements of an operation: the routes that
 * need credentials declare them.
 */

/** `401`: `AuthGuard` found no credentials, or credentials it does not know. */
export const UNAUTHORIZED = {
  description: 'Missing or invalid credentials (see the `www-authenticate` header)',
  headers: { 'www-authenticate': { description: 'The credentials expected (RFC 9110)', required: true } },
} as const satisfies ApiResponseOptions

/** `403`: valid credentials, without a role that the route accepts. */
export const FORBIDDEN = {
  description: 'The credentials are valid, but do not grant this operation',
} as const satisfies ApiResponseOptions
