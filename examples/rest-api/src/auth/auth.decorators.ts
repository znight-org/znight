import { createRouteDecorator } from '@znight/http'

/** Roles granted by the API keys (see `ApiKeyGuard`). */
export type Role = 'admin' | 'reader'

/**
 * `@Roles(['admin'])` on a controller or a route: the API key must grant one of these roles.
 *
 * Route decorators are compile-time metadata: the compiler stores the argument in the route table
 * (`route.meta.roles`), and guards read it back with `Roles.get(ctx)`.
 */
export const Roles = createRouteDecorator<readonly Role[]>('roles')

/** `@Public()`: the route is served without API key (the guard lets the request through). */
export const Public = createRouteDecorator('public')
