import type { Lazy } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'
import type { Authenticator } from './authenticator.js'
import type { CurrentUser } from './current-user.js'

import { Injectable } from '@znight/core'

import { Authenticated, Public, Roles } from './access.js'

@Injectable()
export class AuthGuard implements CanActivate {
  /** Read by HttpPlugin at boot: every route needs a guard enforcing the "access" group. */
  static readonly enforces = [Public, Authenticated, Roles]

  constructor(
    private readonly authenticator: Authenticator,
    private readonly user: Lazy<CurrentUser>,
  ) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    if (Public.get(ctx)) return true
    const principal = await this.authenticator.authenticate(ctx) // 401 + WWW-Authenticate, or 503
    this.user.get().authenticate(principal)
    const roles = Roles.get(ctx)
    if (roles !== undefined) return roles.some(role => principal.roles.includes(role)) // false → 403
    return Authenticated.get(ctx) === true // no decision: denied (unreachable with a required group)
  }
}
