import type { Logger } from '@znight/observability'
import type { AuthConfig } from '../config/auth.config.js'
import type { Principal, RequestUser } from './request-user.js'

import { createHash, timingSafeEqual } from 'node:crypto'
import { Injectable, type Lazy } from '@znight/core'
import { type CanActivate, type HttpContext, UnauthorizedException } from '@znight/http'

import { Authenticated, Public, Roles } from './auth.decorators.js'

/** Header carrying the API key. */
export const API_KEY_HEADER = 'x-api-key'

interface ApiKey extends Principal {
  /** SHA-256 of the key: compared in constant time, and the key itself is not kept around. */
  readonly digest: Buffer
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/**
 * Enforces the access decision of every route (`@Public`, `@Authenticated`, `@Roles`): authenticates
 * the caller with an API key (`x-api-key` header), then checks the roles the route requires.
 *
 * Registered **globally** in `main.ts` (`HttpPlugin.configure({ guards: [AuthGuard] })`), so it runs
 * before the guards of controllers and routes. Returning `false` answers `403 Forbidden`; throwing an
 * `HttpException` answers its status (`401` here).
 *
 * Deny by default: a route without decision is refused. The compiler already rejects such a route
 * (the `access` group is `required`: ZNIGHT023 at build time), so this is the last line of defence,
 * not a code path.
 *
 * A singleton: the keys are hashed once. The request-scoped `RequestUser` is reached through `Lazy`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /**
   * The decisions this guard enforces, read by `HttpPlugin` at boot: every route of the `access`
   * group must have a guard declaring them in its chain, otherwise the boot fails (ZNIGHT023). This
   * catches an entrypoint (or a test) that forgets `guards: [AuthGuard]`.
   */
  static readonly enforces = [Public, Authenticated, Roles]

  readonly #keys: readonly ApiKey[]

  constructor(
    config: AuthConfig,
    private readonly requestUser: Lazy<RequestUser>,
    private readonly logger: Logger,
  ) {
    const keys: ApiKey[] = [{ name: 'admin', roles: ['admin', 'reader'], digest: sha256(config.apiKey) }]
    if (config.readonlyApiKey) keys.push({ name: 'reader', roles: ['reader'], digest: sha256(config.readonlyApiKey) })
    this.#keys = keys
  }

  canActivate(ctx: HttpContext): boolean {
    if (Public.get(ctx) === true) return true

    const key = ctx.header(API_KEY_HEADER)
    if (key === undefined || key === '') {
      // headers given to an HttpException are sent with the error response
      throw new UnauthorizedException(`Missing API key (${API_KEY_HEADER} header)`, undefined, {
        headers: { 'www-authenticate': `ApiKey header="${API_KEY_HEADER}"` },
      })
    }
    const principal = this.#identify(key)
    if (principal === undefined) {
      // an audit trail of wrong keys (never the key itself). `ctx.ip` is the client behind the
      // trusted proxies (`TRUSTED_PROXIES`), not the load balancer
      this.logger.warn('Invalid API key', { ip: ctx.ip, route: ctx.route?.path })
      throw new UnauthorizedException('Invalid API key')
    }

    this.requestUser.get().authenticate(principal)

    // `ctx.route.meta` holds ONE decision of the "access" group: the route's, or else the
    // controller's (the nearest wins, the other ones are not merged in)
    const roles = Roles.get(ctx)
    if (roles !== undefined) return roles.some(role => principal.roles.includes(role)) // false → 403
    if (Authenticated.get(ctx) === true) return true
    return false // no decision: denied (unreachable while the group is required)
  }

  #identify(key: string): Principal | undefined {
    // digests have a fixed length: timingSafeEqual never throws and the key length does not leak;
    // every key is compared (no early exit), so the timing does not tell which one matched
    const digest = sha256(key)
    let match: ApiKey | undefined
    for (const candidate of this.#keys) if (timingSafeEqual(candidate.digest, digest)) match = candidate
    return match === undefined ? undefined : { name: match.name, roles: match.roles }
  }
}
