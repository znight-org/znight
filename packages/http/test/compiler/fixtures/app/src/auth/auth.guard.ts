// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import type { CanActivate, HttpContext } from '@znight/http'

import { UnauthorizedException } from '@znight/http'

import { Public, Roles } from './roles.ts'

/** Not decorated: auto-registered as a singleton provider by the compiler. */
export class AuthGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    if (Public.get(ctx)) return true
    const token = ctx.header('authorization')
    if (token === undefined) throw new UnauthorizedException('Missing token')
    const roles = Roles.get(ctx) ?? []
    return roles.includes(token.replace('Bearer ', ''))
  }
}
