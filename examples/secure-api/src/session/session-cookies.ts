import type { HttpContext } from '@znight/http'
import type { Principal } from '../auth/principal.js'
import type { SessionConfig } from '../config/session.config.js'
import type { Accounts } from './accounts.js'

import { randomBytes } from 'node:crypto'
import { Injectable } from '@znight/core'
import { z } from 'zod'

/**
 * Who the caller is: signed with `SESSION_SECRETS`, `HttpOnly`. The `__Host-` prefix makes browsers
 * require `Secure`, `Path=/` and no `Domain`: a sibling subdomain cannot set or shadow it.
 */
export const SESSION_COOKIE = '__Host-session'
/** The CSRF token of the session, readable by the pages of this origin (not `HttpOnly`). */
export const CSRF_COOKIE = '__Host-csrf'

/** The signed value. Signing gives integrity only: no secret goes in there. */
const SessionPayload = z.object({
  sub: z.string(), // the account
  exp: z.number().int(), // expiry, Unix seconds: the signature of a cookie does not cover any expiry
  csrf: z.string(), // the CSRF token bound to this session
})
type SessionPayload = z.output<typeof SessionPayload>

export interface Session {
  readonly principal: Principal
  readonly csrfToken: string
  readonly expiresAt: Date
}

/**
 * Stateless cookie sessions on top of the signed cookies of `@znight/http` (`cookies.secrets`). There
 * is no server-side store, so signing out clears the cookies but a copied cookie stays valid until it
 * expires: keep sessions short, and rotate `SESSION_SECRETS` to end them all.
 */
@Injectable()
export class SessionCookies {
  constructor(
    private readonly config: SessionConfig,
    private readonly accounts: Accounts,
  ) {}

  /** Opens a session for `principal`: sets both cookies on the response. */
  open(ctx: HttpContext, principal: Principal): Session {
    const exp = Math.floor(Date.now() / 1000) + this.config.maxAge
    const payload: SessionPayload = { sub: principal.id, exp, csrf: randomBytes(32).toString('base64url') }
    // Strict: never sent with a request started by another site, links included (an API has no landing page)
    const options = { maxAge: this.config.maxAge, sameSite: 'strict' } as const
    ctx.setCookie(SESSION_COOKIE, Buffer.from(JSON.stringify(payload)).toString('base64url'), {
      ...options,
      signed: true,
    })
    ctx.setCookie(CSRF_COOKIE, payload.csrf, { ...options, httpOnly: false })
    return { principal, csrfToken: payload.csrf, expiresAt: new Date(exp * 1000) }
  }

  /** The session of the request: signed with a current secret, not expired, of an existing account. */
  read(ctx: HttpContext): Session | undefined {
    const value = ctx.signedCookie(SESSION_COOKIE) // undefined when absent, tampered or signed with a retired secret
    const payload = value === undefined ? undefined : decode(value)
    if (payload === undefined || payload.exp * 1000 <= Date.now()) return undefined
    const principal = this.accounts.principal(payload.sub) // current roles; a removed account ends its sessions
    if (principal === undefined) return undefined
    return { principal, csrfToken: payload.csrf, expiresAt: new Date(payload.exp * 1000) }
  }

  /** Whether the request carries a session cookie, valid or not. */
  isPresent(ctx: HttpContext): boolean {
    return ctx.cookies[SESSION_COOKIE] !== undefined
  }

  /** Ends the session in the browser. */
  close(ctx: HttpContext): void {
    ctx.clearCookie(SESSION_COOKIE)
    ctx.clearCookie(CSRF_COOKIE)
  }
}

function decode(value: string): SessionPayload | undefined {
  try {
    return SessionPayload.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  } catch {
    return undefined
  }
}
