import { Injectable } from '@znight/core'

/** Why an address does not receive emails anymore. */
export interface Suppression {
  readonly reason: string
  readonly since: Date
}

/**
 * Addresses that hard-bounced: they are never emailed again (mailbox providers penalise senders that
 * keep mailing invalid addresses). In memory for the example; a database table in a real service.
 */
@Injectable()
export class SuppressionList {
  readonly #entries = new Map<string, Suppression>()

  add(address: string, reason: string): void {
    const key = address.toLowerCase()
    if (!this.#entries.has(key)) this.#entries.set(key, { reason, since: new Date() })
  }

  has(address: string): boolean {
    return this.#entries.has(address.toLowerCase())
  }

  get(address: string): Suppression | undefined {
    return this.#entries.get(address.toLowerCase())
  }
}
