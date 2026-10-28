import type { TestApp } from '@znight/testing'

import { BillingLedger } from '../src/webhooks/billing-ledger.js'
import { createTestApp } from './support/app.js'
import { signWebhook } from './support/fixtures.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/** `WebhookSignatureGuard`: HMAC-SHA256 of `<t>.<raw body>`, 5 minutes of tolerance. */
describe('billing webhook', () => {
  let app: TestApp
  let sequence = 0

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  /** The exact bytes the billing provider sends: key order and spacing of its own. */
  function delivery(type = 'subscription.created'): { id: string; body: string } {
    const id = `evt_${++sequence}`
    return { id, body: `{"id": "${id}", "type": "${type}", "data": {"customerId": "cus_42", "plan": "pro"}}` }
  }

  function send(body: string, signature: string | undefined) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (signature !== undefined) headers['x-signature'] = signature
    return app.inject({ method: 'POST', url: '/webhooks/billing', headers, body })
  }

  it('accepts a delivery signed over its raw body, and processes it once', async () => {
    const { id, body } = delivery()

    expect((await send(body, signWebhook(body))).status).toBe(204)
    // retried by the sender (or replayed within the window): accepted, not processed again
    expect((await send(body, signWebhook(body))).status).toBe(204)
    expect(app.get(BillingLedger).events.filter(event => event.id === id)).toEqual([
      { id, type: 'subscription.created', data: { customerId: 'cus_42', plan: 'pro' } },
    ])
  })

  it('rejects a tampered body: the signature covers the exact bytes', async () => {
    const { id, body } = delivery()
    const signature = signWebhook(body)

    const tampered = await send(body.replace('"pro"', '"enterprise"'), signature)
    // the same JSON re-serialised (key order, spacing) is another text: re-serialising never works
    const reserialised = await send(JSON.stringify(JSON.parse(body)), signature)

    expect(tampered.status).toBe(401)
    expect(tampered.json()).toMatchObject({ message: 'Invalid signature' })
    expect(reserialised.status).toBe(401)
    expect(app.get(BillingLedger).events.some(event => event.id === id)).toBe(false)
  })

  it('rejects stale, missing, malformed and wrongly keyed signatures', async () => {
    const { body } = delivery()
    const sixMinutesAgo = Date.now() / 1000 - 360

    const cases = [
      [signWebhook(body, { timestamp: sixMinutesAgo }), 'Stale signature'],
      [signWebhook(body, { timestamp: Date.now() / 1000 + 360 }), 'Stale signature'],
      [undefined, 'Missing signature'],
      ['t=abc,v1=00', 'Missing signature'],
      [`t=${Math.floor(Date.now() / 1000)}`, 'Missing signature'],
      [signWebhook(body, { secret: 'another-secret' }), 'Invalid signature'],
      [`${signWebhook(body).slice(0, -2)}`, 'Invalid signature'], // truncated: lengths differ
    ] as const
    for (const [signature, message] of cases) {
      const response = await send(body, signature)
      expect({ signature, status: response.status, message: response.json<{ message: string }>().message }).toEqual({
        signature,
        status: 401,
        message,
      })
    }
  })

  it('validates the body once the signature is checked', async () => {
    const body = '{"id": "evt_bad", "type": "subscription.paused", "data": {}}'

    const response = await send(body, signWebhook(body))

    expect(response.status).toBe(400)
    expect(response.json()).toMatchObject({ message: 'Invalid body' })
  })
})
