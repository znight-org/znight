import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

export interface Principal {
  readonly name: string
  readonly roles: readonly string[]
}

/**
 * The caller of the current request. For a WebSocket, the request scope is the connection: the
 * principal set by `AuthGuard` at the handshake is there for every message.
 */
@Injectable({ scope: 'request' })
export class RequestUser {
  #principal: Principal | undefined

  authenticate(principal: Principal): void {
    this.#principal = principal
  }

  get principal(): Principal {
    if (this.#principal === undefined) throw new UnauthorizedException('Authentication required')
    return this.#principal
  }
}
