import type { Principal } from './request-user.js'

import { randomBytes } from 'node:crypto'
import { Injectable } from '@znight/core'

const TTL_MS = 30_000

/** Outstanding (issued, not yet presented) tickets per user: issuing one more drops the oldest. */
export const MAX_TICKETS_PER_USER = 10

interface Ticket {
  readonly principal: Principal
  readonly expires: number
}

/**
 * Browsers cannot set headers on a WebSocket: an authenticated `POST /ws/tickets` returns a
 * single-use ticket, valid 30 s, that the browser passes in the query (`/chat?ticket=...`).
 *
 * The store stays bounded: expired tickets that were never presented are dropped on the next
 * `issue()`, and each user holds at most {@link MAX_TICKETS_PER_USER} outstanding tickets.
 */
@Injectable()
export class TicketStore {
  /** In issue order, hence in expiry order (the TTL is constant). */
  readonly #tickets = new Map<string, Ticket>()
  /** The outstanding tickets of each user, oldest first. */
  readonly #byUser = new Map<string, string[]>()

  /** Number of outstanding tickets. */
  get size(): number {
    return this.#tickets.size
  }

  issue(principal: Principal): string {
    const now = Date.now()
    this.#sweep(now)
    const ticket = randomBytes(24).toString('base64url')
    this.#tickets.set(ticket, { principal, expires: now + TTL_MS })
    const mine = this.#byUser.get(principal.name) ?? []
    mine.push(ticket)
    if (mine.length > MAX_TICKETS_PER_USER) {
      const oldest = mine.shift()
      if (oldest !== undefined) this.#tickets.delete(oldest)
    }
    this.#byUser.set(principal.name, mine)
    return ticket
  }

  /** The principal of a valid ticket, which is consumed. */
  consume(ticket: string): Principal | undefined {
    const found = this.#tickets.get(ticket)
    if (found === undefined) return undefined
    this.#remove(ticket, found.principal.name)
    return found.expires > Date.now() ? found.principal : undefined
  }

  #remove(ticket: string, name: string): void {
    this.#tickets.delete(ticket)
    const mine = this.#byUser.get(name)
    if (mine === undefined) return
    const index = mine.indexOf(ticket)
    if (index !== -1) mine.splice(index, 1)
    if (mine.length === 0) this.#byUser.delete(name)
  }

  /** Drops the expired tickets: the oldest come first, so the loop stops at the first valid one. */
  #sweep(now: number): void {
    for (const [ticket, { principal, expires }] of this.#tickets) {
      if (expires > now) break
      this.#remove(ticket, principal.name)
    }
  }
}
