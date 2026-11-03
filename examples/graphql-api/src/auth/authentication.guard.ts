import type { Lazy } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'
import type { CurrentUser } from './current-user.js'

import { Injectable } from '@znight/core'

import { API_KEY_HEADER, type ApiKeys } from './api-keys.js'

/**
 * Identifies the caller, on every HTTP request (`/graphql` included): a request with an API key gets
 * its principal in `CurrentUser`, a request with a wrong key is answered 401 at once. It decides
 * nothing else: anonymous requests go on, and `AccessGuard` decides per route and per field.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly keys: ApiKeys,
    // a singleton: the request-scoped CurrentUser is read through Lazy (injecting it directly is ZNIGHT003)
    private readonly user: Lazy<CurrentUser>,
  ) {}

  canActivate(ctx: HttpContext): boolean {
    const key = ctx.header(API_KEY_HEADER)
    if (key !== undefined) this.user.get().authenticate(this.keys.verify(key))
    return true
  }
}
