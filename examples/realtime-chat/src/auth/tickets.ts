import type { Principal } from './request-user.js'

import { randomBytes } from 'node:crypto'
import { Injectable } from '@znight/core'

const TTL_MS = 30_000

/**
 * Browsers cannot set headers on a WebSocket: an authenticated `POST /ws/tickets` returns a
 * single-use ticket, valid 30 s, that the browser passes in the query (`/chat?ticket=...`).
 */
@Injectable()
export class TicketStore {
  readonly #tickets = new Map<string, { readonly principal: Principal; readonly expires: number }>()

  issue(principal: Principal): string {
    const ticket = randomBytes(24).toString('base64url')
    this.#tickets.set(ticket, { principal, expires: Date.now() + TTL_MS })
    return ticket
  }

  /** The principal of a valid ticket, which is consumed. */
  consume(ticket: string): Principal | undefined {
    const found = this.#tickets.get(ticket)
    this.#tickets.delete(ticket)
    return found !== undefined && found.expires > Date.now() ? found.principal : undefined
  }
}
