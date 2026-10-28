import type { Lazy } from '@znight/core'
import type { CurrentUser } from '../auth/current-user.js'

import { Injectable } from '@znight/core'
import { type CanActivate, createRouteDecorator, type HttpContext, TooManyRequestsException } from '@znight/http'
import { type RateLimiterAbstract, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'

/** `points` requests per `duration` seconds. */
export interface RateLimitPolicy {
  readonly points: number
  readonly duration: number
}

/** `@RateLimit({ points: 30, duration: 60 })` on a route or a controller. */
export const RateLimit = createRouteDecorator<RateLimitPolicy>('rateLimit')

@Injectable()
export class RateLimitGuard implements CanActivate {
  /** A route with @RateLimit needs this guard in its chain (checked at boot). */
  static readonly enforces = [RateLimit]

  readonly #limiters = new Map<string, RateLimiterAbstract>()

  constructor(private readonly user: Lazy<CurrentUser>) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    const policy = RateLimit.get(ctx)
    if (policy === undefined || ctx.route === undefined) return true // no limit on this route
    const user = this.user.get()
    // the caller when known, else the client address (correct behind a proxy only with trustProxy)
    const key = user.isAuthenticated ? `user:${user.principal.id}` : `ip:${ctx.ip ?? 'unknown'}`
    try {
      await this.#limiter(`${ctx.route.method} ${ctx.route.path}`, policy).consume(key)
      return true
    } catch (rejection) {
      if (!(rejection instanceof RateLimiterRes)) throw rejection // the store failed: 500
      throw new TooManyRequestsException('Too many requests', undefined, {
        headers: { 'retry-after': String(Math.ceil(rejection.msBeforeNext / 1000)) },
      })
    }
  }

  /** One budget per route. */
  #limiter(route: string, { points, duration }: RateLimitPolicy): RateLimiterAbstract {
    let limiter = this.#limiters.get(route)
    if (limiter === undefined) {
      limiter = new RateLimiterMemory({ keyPrefix: route, points, duration })
      this.#limiters.set(route, limiter)
    }
    return limiter
  }
}
