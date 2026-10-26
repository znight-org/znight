import type { AuthConfig } from '../config/auth.config.js'
import type { Principal, RequestUser } from './request-user.js'

import { createHash, timingSafeEqual } from 'node:crypto'
import { Injectable, type Lazy } from '@znight/core'
import { type CanActivate, type HttpContext, UnauthorizedException } from '@znight/http'

import { Public, Roles } from './auth.decorators.js'

/** Header carrying the API key. */
export const API_KEY_HEADER = 'x-api-key'

interface ApiKey extends Principal {
  /** SHA-256 of the key: compared in constant time, and the key itself is not kept around. */
  readonly digest: Buffer
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/**
 * Authenticates every request with an API key (`x-api-key` header) and enforces `@Roles`.
 *
 * Registered **globally** in `main.ts` (`HttpPlugin.configure({ guards: [AuthGuard] })`), so it runs
 * before the guards of controllers and routes; routes opt out with `@Public()`. Returning `false`
 * answers `403 Forbidden`; throwing an `HttpException` answers its status (`401` here).
 *
 * A singleton: the keys are hashed once. The request-scoped `RequestUser` is reached through `Lazy`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  readonly #keys: readonly ApiKey[]

  constructor(
    config: AuthConfig,
    private readonly requestUser: Lazy<RequestUser>,
  ) {
    const keys: ApiKey[] = [{ name: 'admin', roles: ['admin', 'reader'], digest: sha256(config.apiKey) }]
    if (config.readonlyApiKey) keys.push({ name: 'reader', roles: ['reader'], digest: sha256(config.readonlyApiKey) })
    this.#keys = keys
  }

  canActivate(ctx: HttpContext): boolean {
    if (Public.get(ctx)) return true

    const key = ctx.header(API_KEY_HEADER)
    if (key === undefined || key === '') {
      // headers given to an HttpException are sent with the error response
      throw new UnauthorizedException(`Missing API key (${API_KEY_HEADER} header)`, undefined, {
        headers: { 'www-authenticate': `ApiKey header="${API_KEY_HEADER}"` },
      })
    }
    const principal = this.#identify(key)
    if (principal === undefined) throw new UnauthorizedException('Invalid API key')

    this.requestUser.get().authenticate(principal)

    // route metadata merges the controller's and the route's values (the route wins)
    const roles = Roles.get(ctx)
    return roles === undefined || roles.some(role => principal.roles.includes(role))
  }

  #identify(key: string): Principal | undefined {
    const digest = sha256(key)
    const match = this.#keys.find(candidate => timingSafeEqual(candidate.digest, digest))
    return match === undefined ? undefined : { name: match.name, roles: match.roles }
  }
}
