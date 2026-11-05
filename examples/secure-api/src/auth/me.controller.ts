import type { Principal } from './principal.js'

import { Controller, Ctx, Get, type HttpContext } from '@znight/http'

import { Authenticated } from './access.js'
import { CurrentUser } from './current-user.js'

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
  /** GET /me: whoever authenticated, with a token, an API key or a session cookie. */
  @Get()
  whoami(@CurrentUser() user: Principal, @Ctx() ctx: HttpContext): Me {
    return { ...user, ip: ctx.ip }
  }
}
