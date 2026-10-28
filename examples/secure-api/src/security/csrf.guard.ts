import type { Lazy } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'
import type { CurrentUser } from '../auth/current-user.js'
import type { CorsConfig } from '../config/cors.config.js'
import type { SessionCookies } from '../session/session-cookies.js'

import { timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'

/** The header carrying the CSRF token of the session (double submit). */
export const CSRF_HEADER = 'x-csrf-token'

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Registered globally, after AuthGuard: it needs to know how the caller authenticated. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly cors: CorsConfig,
    private readonly user: Lazy<CurrentUser>,
    private readonly sessions: SessionCookies,
  ) {}

  canActivate(ctx: HttpContext): boolean {
    if (SAFE_METHODS.has(ctx.method)) return true // safe methods must not change state
    const user = this.user.get()
    // a bearer token or an API key is never attached by the browser itself: nothing to forge
    if (user.isAuthenticated && user.principal.via !== 'session') return true
    // 1. Fetch metadata: no unsafe request from another site (the anonymous sign-in included: login CSRF)
    if (!this.#fromTrustedSite(ctx)) return false // → 403
    if (!user.isAuthenticated) return true
    // 2. Double submit: a cookie-authenticated request echoes the CSRF token bound to its session
    const expected = this.sessions.read(ctx)?.csrfToken
    const sent = ctx.header(CSRF_HEADER)
    return expected !== undefined && sent !== undefined && safeEqual(sent, expected)
  }

  #fromTrustedSite(ctx: HttpContext): boolean {
    const origin = ctx.header('origin')
    if (origin !== undefined && this.cors.origins.includes(origin)) return true // one of our front-ends
    const site = ctx.header('sec-fetch-site') // sent by every current browser
    if (site !== undefined) return site !== 'cross-site'
    // older browsers: an origin that is not ours is another site; no origin at all is not a browser
    return origin === undefined
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
