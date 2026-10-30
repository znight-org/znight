import { createRouteDecorator } from '@znight/http'

/**
 * Roles of the callers:
 *
 * - `customer`: a shopper, authenticated by a bearer token (`Authorization: Bearer <token>`);
 * - `catalog`: the back office managing products, authenticated by an API key (`x-api-key`);
 * - `admin`: the back office with every right (orders export, statistics), also an API key.
 */
export type Role = 'customer' | 'catalog' | 'admin'

/*
 * The access decision of a route. Both decorators belong to the `access` group: a route is public OR
 * needs one of some roles, never both, and every route must have a decision (`required: true`, a
 * route without one fails the build with ZNIGHT023). The nearest decision wins: `@Public()` on a
 * route replaces the `@Roles(...)` of its controller. `AuthGuard` enforces them (`static enforces`).
 *
 * They also drive the OpenAPI document (src/api.ts): `@Public()` routes are documented without
 * security through a `decisions` entry; the other routes inherit the document default (bearer), and
 * back-office routes declare the API key with `@ApiSecurity(ApiKey)`.
 */

/** `@Public()`: no credentials at all (catalogue, product images, documentation). */
export const Public = createRouteDecorator('public', { group: 'access', required: true })

/** `@Roles(['customer'])`: credentials granting at least one of these roles. */
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
