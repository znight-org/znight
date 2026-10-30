import { createRouteDecorator } from '@znight/http'

/** Roles granted by the API keys (see `AuthGuard`). */
export type Role = 'admin' | 'reader'

/*
 * The access decision of a route. The three decorators belong to the same `access` group, so they
 * are alternatives: a route is public, OR needs any valid API key, OR needs one of some roles.
 *
 * - One decision per target: `@Public() @Roles(['admin'])` on the same class or method is ZNIGHT005.
 * - The nearest decision wins: a decision on a route replaces the controller's decision of the same
 *   group (`@Public()` on a controller and `@Roles(['admin'])` on one of its routes: that route is
 *   NOT public).
 * - `required: true`: a route without decision, neither on itself nor on its controller, fails the
 *   build (`znight build`, `znight generate`, `bun test`) with ZNIGHT023.
 * - `AuthGuard` declares these three decorators in `static enforces`: at boot, every route must have
 *   a guard enforcing the group in its chain (ZNIGHT023 otherwise).
 *
 * The compiler reads the options: keep them literal. The value of a decorator lands in the route
 * table (`route.meta[key]`), and guards read it back with `Roles.get(ctx)`.
 */

/** `@Public()`: no API key required. */
export const Public = createRouteDecorator('public', { group: 'access', required: true })

/** `@Authenticated()`: any valid API key, whatever its roles. */
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })

/** `@Roles(['admin'])`: a valid API key granting at least one of these roles. */
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
