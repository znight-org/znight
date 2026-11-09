import type { Lazy } from '@znight/core'
import type { RequestUser } from '../auth/request-user.js'

import { isIPv6 } from 'node:net'
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

  constructor(private readonly user: Lazy<RequestUser>) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    const policy = RateLimit.get(ctx)
    if (policy === undefined || ctx.route === undefined) return true // no limit on this route
    const user = this.user.get()
    // the caller when known, else the client address (correct behind a proxy only with trustProxy)
    const key = user.isAuthenticated ? `user:${user.principal.id}` : addressKey(ctx.ip)
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

/**
 * The budget key of a client address. An IPv6 client usually holds a whole /64 (2^64 addresses):
 * keyed by address, it would get a fresh budget per request. IPv6 addresses are keyed by /64 prefix.
 */
export function addressKey(ip: string | undefined): string {
  if (ip === undefined || !isIPv6(ip)) return `ip:${ip ?? 'unknown'}`
  const [head = '', tail] = ip.split('::')
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'))
  // an embedded IPv4 address (`::ffff:192.0.2.1`) counts as two groups
  const size = (parts: string[]): number => parts.reduce((total, part) => total + (part.includes('.') ? 2 : 1), 0)
  const first = groups(head)
  const last = tail === undefined ? [] : groups(tail)
  const all = [...first, ...Array<string>(8 - size(first) - size(last)).fill('0'), ...last].map(group =>
    group.includes('.') ? group : Number.parseInt(group, 16).toString(16),
  )
  if (all.slice(0, 6).join(':') === '0:0:0:0:0:ffff') return `ip:${all[6]}` // IPv4-mapped: an IPv4 client
  return `ip:${all.slice(0, 4).join(':')}::/64`
}
