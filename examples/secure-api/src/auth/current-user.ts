import type { ParamResolver } from '@znight/core'
import type { HttpContext } from '@znight/http'
import type { Principal } from './principal.js'
import type { RequestUser } from './request-user.js'

import { createParamDecorator, Injectable } from '@znight/core'

/**
 * Resolves `@CurrentUser()`: a request-scoped provider reading the `RequestUser` that `AuthGuard`
 * filled, so the handler receives the caller in its signature (no `Lazy<RequestUser>` to call).
 */
@Injectable({ scope: 'request' })
export class CurrentUserResolver implements ParamResolver<HttpContext, Principal> {
  constructor(private readonly user: RequestUser) {}

  /** The caller; 401 on a public route called anonymously. */
  resolve(): Principal {
    return this.user.principal
  }
}

/**
 * The authenticated caller of the request, as a handler parameter: `me(@CurrentUser() user: Principal)`.
 * The compiler checks every use (an HTTP route, a parameter accepting `Principal`).
 */
export const CurrentUser = createParamDecorator<Principal>({ http: CurrentUserResolver })
