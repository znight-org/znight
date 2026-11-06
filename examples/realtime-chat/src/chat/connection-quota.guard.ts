import type { WsServer } from '@znight/websocket'
import type { RequestUser } from '../auth/request-user.js'

import { Injectable, type Lazy } from '@znight/core'
import { type CanActivate, TooManyRequestsException } from '@znight/http'

export const MAX_TABS = 5

/** A handshake guard (an HTTP guard): at most five chat connections per user. */
@Injectable()
export class ConnectionQuotaGuard implements CanActivate {
  constructor(
    private readonly ws: WsServer,
    private readonly user: Lazy<RequestUser>,
  ) {}

  canActivate(): boolean {
    const name = this.user.get().principal.name // set by the global AuthGuard, same scope
    if (this.ws.of('/chat').members(`user:${name}`).size >= MAX_TABS) {
      throw new TooManyRequestsException(`At most ${MAX_TABS} chat connections per user`)
    }
    return true
  }
}
