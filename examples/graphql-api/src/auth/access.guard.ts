import type { Lazy } from '@znight/core'
import type { GraphQLGuard, ResolverContext } from '@znight/graphql'
import type { CanActivate, HttpContext, RouteMetaCarrier } from '@znight/http'
import type { CurrentUser } from './current-user.js'

import { Injectable } from '@znight/core'

import { Authenticated, Public, Roles } from './access.js'

/**
 * Enforces the access decision of every HTTP route (`canActivate`) and of every GraphQL root field
 * (`canResolve`): one class, since `ResolverContext` is a `RouteMetaCarrier` like `HttpContext`.
 *
 * - `@Public()` passes;
 * - otherwise the caller must be authenticated: `CurrentUser.principal` throws a 401, which GraphQL
 *   reports as `UNAUTHENTICATED` on that field;
 * - `@Roles([...])` needs one of the roles: `false` is a 403, or `FORBIDDEN` on that field.
 *
 * It runs once per root field (and per field resolver carrying its own decision), and once when a
 * subscription starts: no I/O, the caller was identified once per request by `AuthenticationGuard`.
 */
@Injectable()
export class AccessGuard implements CanActivate, GraphQLGuard {
  /** The group this guard enforces: `HttpPlugin` and `GraphQLPlugin` check it at boot (ZNIGHT023). */
  static readonly enforces = [Public, Authenticated, Roles]

  constructor(private readonly user: Lazy<CurrentUser>) {}

  canActivate(ctx: HttpContext): boolean {
    return this.#decide(ctx)
  }

  canResolve(ctx: ResolverContext): boolean {
    return this.#decide(ctx)
  }

  #decide(ctx: RouteMetaCarrier): boolean {
    if (Public.get(ctx) === true) return true
    const principal = this.user.get().principal // 401 / UNAUTHENTICATED when anonymous
    const roles = Roles.get(ctx)
    if (roles !== undefined) return roles.some(role => principal.roles.includes(role))
    return Authenticated.get(ctx) === true // no decision: denied (unreachable with a required group)
  }
}
