import type { Lazy } from '@znight/core'
import type { Logger } from '@znight/observability'
import type { Credentials, Principal } from './credentials.js'
import type { CurrentCustomer } from './current-customer.js'

import { Injectable } from '@znight/core'
import { type CanActivate, type HttpContext, UnauthorizedException } from '@znight/http'

import { Public, Roles } from './auth.decorators.js'

/** Header carrying the API key of the back office. */
export const API_KEY_HEADER = 'x-api-key'

/** Challenges sent with a 401, by expected credentials (RFC 9110 `WWW-Authenticate`). */
const BEARER_CHALLENGE = 'Bearer realm="storefront"'
const API_KEY_CHALLENGE = `ApiKey header="${API_KEY_HEADER}"`

/**
 * Enforces the access decision of every route (`@Public()`, `@Roles(...)`).
 *
 * Two kinds of credentials, matching the two security schemes of the OpenAPI document (src/api.ts):
 *
 * - `Authorization: Bearer <token>`: a customer (role `customer`);
 * - `x-api-key: <key>`: the back office (roles `catalog` and/or `admin`).
 *
 * Registered **globally** in src/http.ts, so it runs before the guards of controllers and routes.
 * Returning `false` answers `403 Forbidden`; throwing an `HttpException` answers its status (401).
 * A singleton: the secrets are hashed once; the request-scoped `CurrentCustomer` is reached through
 * `Lazy`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /**
   * The decisions this guard enforces, read by `HttpPlugin` at boot: every route of the `access`
   * group must have a guard declaring them in its chain, otherwise the boot fails (ZNIGHT023).
   */
  static readonly enforces = [Public, Roles]

  constructor(
    private readonly credentials: Credentials,
    private readonly customer: Lazy<CurrentCustomer>,
    private readonly logger: Logger,
  ) {}

  canActivate(ctx: HttpContext): boolean {
    if (Public.get(ctx) === true) return true
    // `ctx.route.meta` holds ONE decision of the "access" group: the route's, or else the controller's
    const roles = Roles.get(ctx) ?? []

    const principal = this.#authenticate(ctx, roles.includes('customer') ? BEARER_CHALLENGE : API_KEY_CHALLENGE)
    if (principal.roles.includes('customer')) this.customer.get().authenticate(principal.id)
    return roles.some(role => principal.roles.includes(role)) // false → 403
  }

  #authenticate(ctx: HttpContext, challenge: string): Principal {
    const key = ctx.header(API_KEY_HEADER)
    if (key !== undefined && key !== '') {
      const principal = this.credentials.verifyApiKey(key)
      if (principal !== undefined) return principal
      // an audit trail of wrong keys (never the key itself)
      this.logger.warn('Invalid API key', { ip: ctx.ip, route: ctx.route?.path })
      throw new UnauthorizedException('Invalid API key', undefined, { headers: { 'www-authenticate': challenge } })
    }

    const authorization = ctx.header('authorization')
    if (authorization !== undefined && authorization !== '') {
      const [scheme, token] = authorization.split(' ', 2)
      const principal =
        scheme?.toLowerCase() === 'bearer' && token ? this.credentials.verifyToken(token.trim()) : undefined
      if (principal !== undefined) return principal
      this.logger.warn('Invalid bearer token', { ip: ctx.ip, route: ctx.route?.path })
      throw new UnauthorizedException('Invalid bearer token', undefined, {
        headers: { 'www-authenticate': `${BEARER_CHALLENGE}, error="invalid_token"` },
      })
    }

    // headers given to an HttpException are sent with the error response
    throw new UnauthorizedException('Missing credentials', undefined, { headers: { 'www-authenticate': challenge } })
  }
}
