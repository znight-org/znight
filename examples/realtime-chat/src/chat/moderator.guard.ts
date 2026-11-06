import type { WsGuard, WsMessageContext } from '@znight/websocket'
import type { RequestUser } from '../auth/request-user.js'

import { Injectable, type Lazy } from '@znight/core'

import { Roles } from '../auth/access.js'

/** A message guard: the handler's `@Roles`, checked against the caller authenticated at the handshake. */
@Injectable()
export class ModeratorGuard implements WsGuard {
  constructor(private readonly user: Lazy<RequestUser>) {}

  canHandle(ctx: WsMessageContext): boolean {
    const roles = Roles.get(ctx)
    return roles === undefined || roles.some(role => this.user.get().principal.roles.includes(role))
  }
}
