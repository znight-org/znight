import type { Lazy } from '@znight/core'
import type { Principal, RequestUser } from './request-user.js'

import { Controller, Get } from '@znight/http'

import { Authenticated } from './auth.decorators.js'

/**
 * `@Authenticated()`: any valid API key, whatever its roles. Without an access decision, the build
 * would fail with ZNIGHT023 (the `access` group is required): there is no implicit default.
 */
@Controller('/me')
@Authenticated()
export class MeController {
  constructor(private readonly user: Lazy<RequestUser>) {}

  /** GET /me: the caller, as authenticated by the global guard. */
  @Get()
  whoami(): Principal {
    return this.user.get().principal
  }
}
