import type { Role } from '../auth/access.js'
import type { Accounts } from './accounts.js'
import type { Session, SessionCookies } from './session-cookies.js'

import {
  Body,
  Controller,
  Ctx,
  Delete,
  Get,
  HttpCode,
  type HttpContext,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@znight/http'
import { z } from 'zod'

import { Authenticated, Public } from '../auth/access.js'
import { RateLimit } from '../security/rate-limit.js'

export const SignIn = z.object({
  username: z.string().min(1).max(64),
  // bounded: every attempt hashes the password (128 MiB, a few hundred milliseconds)
  password: z.string().min(1).max(1024),
})
export type SignIn = z.output<typeof SignIn>

/** What a front-end needs: the CSRF token to echo in `x-csrf-token` on every unsafe request. */
export interface SessionResponse {
  readonly id: string
  readonly roles: readonly Role[]
  readonly csrfToken: string
  readonly expiresAt: Date
}

/**
 * Password sign-in for the web front-end (machines use tokens or API keys). The controller's
 * decision is `@Authenticated()`; the sign-in route replaces it with `@Public()`.
 */
@Controller('/session')
@Authenticated()
export class SessionController {
  constructor(
    private readonly accounts: Accounts,
    private readonly sessions: SessionCookies,
  ) {}

  /** POST /session: sets the session and CSRF cookies; 401 for any wrong username or password. */
  @Post()
  @Public()
  @RateLimit({ points: 5, duration: 60 }) // per client address: slows down password guessing
  @HttpCode(200)
  async signIn(@Body(SignIn) input: SignIn, @Ctx() ctx: HttpContext): Promise<SessionResponse> {
    const principal = await this.accounts.signIn(input.username, input.password)
    if (principal === undefined) throw new UnauthorizedException('Invalid username or password')
    return toResponse(this.sessions.open(ctx, principal))
  }

  /** GET /session: the CSRF token again, for a front-end on another host (it cannot read the cookie). */
  @Get()
  current(@Ctx() ctx: HttpContext): SessionResponse {
    const session = this.sessions.read(ctx)
    if (session === undefined) throw new NotFoundException('No session: the caller authenticated otherwise')
    return toResponse(session)
  }

  /** DELETE /session: clears the cookies (an unsafe method: the CSRF token is required). */
  @Delete()
  signOut(@Ctx() ctx: HttpContext): void {
    this.sessions.close(ctx)
  }
}

function toResponse({ principal, csrfToken, expiresAt }: Session): SessionResponse {
  return { id: principal.id, roles: principal.roles, csrfToken, expiresAt }
}
