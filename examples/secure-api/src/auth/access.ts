import { createRouteDecorator } from '@znight/http'

/** Every role of the API. `exporter` is the role of the export client, a machine (see `api-keys.ts`). */
export const ROLES = ['admin', 'editor', 'reader', 'exporter'] as const
export type Role = (typeof ROLES)[number]

/** No authentication. */
export const Public = createRouteDecorator('public', { group: 'access', required: true })
/** Any authenticated caller. */
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
/** An authenticated caller holding at least one of the roles. */
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
