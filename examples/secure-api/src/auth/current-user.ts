import type { Principal } from './principal.js'

import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

/** One instance per request, disposed with it. */
@Injectable({ scope: 'request' })
export class CurrentUser {
  #principal: Principal | undefined

  /** Called by AuthGuard once the caller is authenticated. */
  authenticate(principal: Principal): void {
    this.#principal = principal
  }

  get isAuthenticated(): boolean {
    return this.#principal !== undefined
  }

  /** The caller; 401 on a public route called anonymously. */
  get principal(): Principal {
    if (this.#principal === undefined) throw new UnauthorizedException('Authentication required')
    return this.#principal
  }
}
