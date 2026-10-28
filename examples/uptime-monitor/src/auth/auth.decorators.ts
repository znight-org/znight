import { createRouteDecorator } from '@znight/http'

/** Roles granted by the API keys (see `AuthGuard`). */
export type Role = 'admin' | 'reader'

/*
 * The access decision of a route (the pattern of examples/rest-api and of the Security guide). Both
 * decorators belong to the `access` group: a route is public OR needs one of some roles, the nearest
 * decision wins, and `required: true` makes a route without decision a build error (ZNIGHT023).
 * `AuthGuard` declares them in `static enforces`, so a boot without the guard fails too.
 */

/** `@Public()`: no API key (the status page, its event stream, the health check). */
export const Public = createRouteDecorator('public', { group: 'access', required: true })

/** `@Roles(['admin'])`: a valid API key granting at least one of these roles. */
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
