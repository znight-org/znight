import type { ApiKeys } from './api-keys.js'
import type { RequestUser } from './request-user.js'
import type { TicketStore } from './tickets.js'

import { Injectable, type Lazy } from '@znight/core'
import { type CanActivate, type HttpContext, UnauthorizedException } from '@znight/http'

import { Authenticated, Public, TicketAuth } from './access.js'

/**
 * The global guard of `HttpPlugin`: it protects routes **and** WebSocket handshakes, which are HTTP
 * requests. An API key (`x-api-key`), or a ticket on the handshakes of `@TicketAuth()` gateways only.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  static readonly enforces = [Public, Authenticated]

  constructor(
    private readonly keys: ApiKeys,
    private readonly tickets: TicketStore,
    private readonly user: Lazy<RequestUser>,
  ) {}

  canActivate(ctx: HttpContext): boolean {
    if (Public.get(ctx) === true) return true
    const principal = this.#identify(ctx)
    if (principal === undefined) throw new UnauthorizedException('Missing or invalid credentials')
    this.user.get().authenticate(principal)
    return Authenticated.get(ctx) === true
  }

  #identify(ctx: HttpContext) {
    const key = ctx.header('x-api-key')
    if (key !== undefined) return this.keys.identify(key)
    // tickets end up in URLs: accept them on the handshakes of @TicketAuth() gateways only, decided by
    // the matched route (an `upgrade` header is client-controlled and also reaches ordinary routes)
    const ticket = ctx.query['ticket']
    return TicketAuth.get(ctx) === true && typeof ticket === 'string' ? this.tickets.consume(ticket) : undefined
  }
}
