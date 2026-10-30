import type { BillingLedger } from './billing-ledger.js'

import { Body, Controller, HttpCode, Post, UseGuard } from '@znight/http'

import { Public } from '../auth/access.js'
import { RateLimit } from '../security/rate-limit.js'
import { WebhookSignatureGuard } from '../security/webhook-signature.guard.js'
import { BillingEvent } from './billing-event.js'

@Controller('/webhooks')
@Public() // no user: the signature authenticates the sender
export class WebhookController {
  constructor(private readonly ledger: BillingLedger) {}

  /** POST /webhooks/billing: 204 once processed (or already processed), 401 for a bad signature. */
  @Post('/billing')
  @UseGuard(WebhookSignatureGuard)
  @RateLimit({ points: 120, duration: 60 })
  @HttpCode(204)
  billing(@Body(BillingEvent) event: BillingEvent): void {
    this.ledger.record(event)
  }
}
