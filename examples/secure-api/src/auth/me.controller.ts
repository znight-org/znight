import type { Lazy } from '@znight/core'
import type { CurrentUser } from './current-user.js'
import type { Principal } from './principal.js'

import { Controller, Ctx, Get, type HttpContext } from '@znight/http'

import { Authenticated } from './access.js'

/** The caller as the API sees it. */
export interface Me extends Principal {
  /** The client address: behind the trusted proxies (`TRUSTED_PROXIES`), read from `x-forwarded-for`. */
  readonly ip: string | undefined
}

/**
 * Without `@Authenticated()` (or another decision of the "access" group), the build fails with
 * ZNIGHT023: there is no implicit default. `test/build-check.test.ts` keeps that promise.
 */
@Controller('/me')
@Authenticated()
export class MeController {
  // a singleton: the request-scoped CurrentUser is read through Lazy (injecting it directly is ZNIGHT003)
  constructor(private readonly user: Lazy<CurrentUser>) {}

  /** GET /me: whoever authenticated, with a token, an API key or a session cookie. */
  @Get()
  whoami(@Ctx() ctx: HttpContext): Me {
    return { ...this.user.get().principal, ip: ctx.ip }
  }
}
