import type { Principal } from './principal.js'

import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

/**
 * The caller of the current request: one instance per HTTP request, filled by
 * `AuthenticationGuard`. For a subscription, the request lasts as long as its event stream, and so
 * does this instance.
 */
@Injectable({ scope: 'request' })
export class CurrentUser {
  #principal: Principal | undefined

  /** Called by `AuthenticationGuard` once the API key is verified. */
  authenticate(principal: Principal): void {
    this.#principal = principal
  }

  get isAuthenticated(): boolean {
    return this.#principal !== undefined
  }

  /** The caller; an `UnauthorizedException` when anonymous: HTTP 401, GraphQL `UNAUTHENTICATED`. */
  get principal(): Principal {
    if (this.#principal === undefined) throw new UnauthorizedException('Authentication required')
    return this.#principal
  }
}
