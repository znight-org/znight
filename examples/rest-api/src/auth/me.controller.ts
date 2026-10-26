import type { Lazy } from '@znight/core'
import type { Principal, RequestUser } from './request-user.js'

import { Controller, Get } from '@znight/http'

@Controller('/me')
export class MeController {
  constructor(private readonly user: Lazy<RequestUser>) {}

  /** GET /me: the caller, as authenticated by the global guard. */
  @Get()
  whoami(): Principal {
    return this.user.get().principal
  }
}
