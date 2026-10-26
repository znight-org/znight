import type { Role } from './auth.decorators.js'

import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

/** Who is calling: the API key that authenticated the request. */
export interface Principal {
  /** Name of the key (`admin`, `reader`), recorded on the books it creates. */
  readonly name: string
  readonly roles: readonly Role[]
}

/**
 * The caller of the current request.
 *
 * `scope: 'request'`: one instance per HTTP request, created on first use inside the request scope
 * opened by the HTTP plugin, and disposed when the response has been sent. `ApiKeyGuard` fills it;
 * controllers and services read it.
 *
 * Singletons cannot inject a request-scoped provider directly (the compiler reports ZNIGHT003: the
 * singleton would keep the first request's user forever). They inject `Lazy<RequestUser>` and call
 * `get()` while handling a request: it resolves the instance of the current request.
 */
@Injectable({ scope: 'request' })
export class RequestUser {
  #principal: Principal | undefined

  /** Called by the guard once the API key is verified. */
  authenticate(principal: Principal): void {
    this.#principal = principal
  }

  get isAuthenticated(): boolean {
    return this.#principal !== undefined
  }

  /** The authenticated caller; 401 on a public route called without API key. */
  get principal(): Principal {
    if (this.#principal === undefined) throw new UnauthorizedException('Authentication required')
    return this.#principal
  }

  hasRole(role: Role): boolean {
    return this.#principal?.roles.includes(role) ?? false
  }
}
