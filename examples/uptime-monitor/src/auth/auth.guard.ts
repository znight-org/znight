import type { Logger } from '@znight/observability'
import type { AuthConfig } from '../config/auth.config.js'
import type { Role } from './auth.decorators.js'

import { createHash, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'
import { type CanActivate, type HttpContext, UnauthorizedException } from '@znight/http'

import { Public, Roles } from './auth.decorators.js'

/** Header carrying the API key. */
export const API_KEY_HEADER = 'x-api-key'

interface ApiKey {
  readonly name: string
  readonly roles: readonly Role[]
  /** SHA-256 of the key: compared in constant time, the key itself is not kept around. */
  readonly digest: Buffer
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/**
 * Enforces the access decision of every route: `@Public()` routes pass, the others need an API key
 * (`x-api-key`, `401` without a valid one) granting one of the roles of `@Roles` (`403` otherwise).
 * Registered globally in `plugins.ts` (`HttpPlugin.configure({ guards: [AuthGuard] })`).
 *
 * The admin endpoints of the scheduler (`/admin/jobs`) are plain routes: the same guard protects
 * them, and so do manual triggers.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /** The decisions this guard enforces: `HttpPlugin` checks at boot that every route has one (ZNIGHT023). */
  static readonly enforces = [Public, Roles]

  readonly #keys: readonly ApiKey[]

  constructor(
    config: AuthConfig,
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
      throw new UnauthorizedException(`Missing API key (${API_KEY_HEADER} header)`, undefined, {
        headers: { 'www-authenticate': `ApiKey header="${API_KEY_HEADER}"` },
      })
    }
    // every key is compared (no early exit): the timing does not tell which one matched
    const digest = sha256(key)
    let match: ApiKey | undefined
    for (const candidate of this.#keys) if (timingSafeEqual(candidate.digest, digest)) match = candidate
    if (match === undefined) {
      this.logger.warn('Invalid API key', { ip: ctx.ip, route: ctx.route?.path })
      throw new UnauthorizedException('Invalid API key')
    }

    const roles = Roles.get(ctx)
    return roles?.some(role => match.roles.includes(role)) ?? false // false → 403
  }
}
