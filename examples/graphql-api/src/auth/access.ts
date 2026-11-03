import { createRouteDecorator } from '@znight/http'

// A named union of string literals: the `Role` enum of the schema (`Viewer.roles`).
/** Roles granted by the API keys. */
export type Role = 'reader' | 'editor'

/*
 * The access decision of a root field or of a route: one vocabulary for GraphQL and HTTP. The three
 * decorators belong to the `access` group: a field is public OR needs a caller OR needs one of some
 * roles, the method's decision replaces the class's, and `required: true` makes a root field (or a
 * route) without decision a build error (ZNIGHT023). `AccessGuard` declares them in
 * `static enforces`, so a boot without the guard fails too.
 */

/** `@Public()`: anyone, no API key. */
export const Public = createRouteDecorator('public', { group: 'access', required: true })

/** `@Authenticated()`: any valid API key. */
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })

/** `@Roles(['editor'])`: a valid API key granting at least one of these roles. */
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
