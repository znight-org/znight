import type { Logger } from '@znight/observability'
import type { BillingEvent } from './billing-event.js'

import { Injectable } from '@znight/core'

/**
 * The billing events processed so far, by id. Senders retry deliveries, and a captured delivery can
 * be replayed within the 5 minutes its signature is accepted: processing is idempotent.
 */
@Injectable()
export class BillingLedger {
  readonly #events = new Map<string, BillingEvent>()

  constructor(private readonly logger: Logger) {}

  /** Processes the event once; `false` when it was already processed. */
  record(event: BillingEvent): boolean {
    if (this.#events.has(event.id)) {
      this.logger.info('Billing event already processed', { eventId: event.id })
      return false
    }
    this.#events.set(event.id, event)
    this.logger.info('Billing event processed', { eventId: event.id, type: event.type })
    return true
  }

  get events(): readonly BillingEvent[] {
    return [...this.#events.values()]
  }
}
