import { createRouteDecorator } from '@znight/http'

/**
 * The access decision of every route and gateway (RFC 0001): one of these per route, checked at
 * build time (ZNIGHT023) and enforced by `AuthGuard`. A gateway decides for its handshake.
 */
export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })

/** Message-level roles, read by `ModeratorGuard` (not part of the access group). */
export const Roles = createRouteDecorator<readonly string[]>('roles')

/**
 * The gateways whose handshake accepts a single-use ticket (`?ticket=...`): `AuthGuard` accepts
 * tickets nowhere else, whatever the request headers say (not part of the access group).
 */
export const TicketAuth = createRouteDecorator('ticket-auth')
