import type { Currency } from '../orders/order.schemas.js'

import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Injectable } from '@znight/core'
import { NonRetryableError } from '@znight/messaging'
import { type Logger, Metric, Traced } from '@znight/observability'

/**
 * Test payment methods of the simulated gateway (like the test cards of a real payment provider):
 * each one triggers a processing outcome of the OrderCreated consumer.
 */
export const TestPaymentMethods = {
  /** Always captured: the order is `confirmed`. */
  visa: 'pm_card_visa',
  /** Declined by the issuer (permanent): the order is `rejected`, the message acknowledged. */
  declined: 'pm_card_declined',
  /** The gateway is unavailable twice, then captures: retried with an exponential backoff, then `confirmed`. */
  flaky: 'pm_card_flaky',
  /** The gateway is always unavailable: every attempt fails, the message is dead-lettered and the order `failed`. */
  unavailable: 'pm_card_unavailable',
} as const

export interface ChargeRequest {
  /** Makes the charge idempotent: a message can be delivered more than once. */
  readonly idempotencyKey: string
  readonly amount: number
  readonly currency: Currency
  readonly paymentMethod: string
}

export interface Payment {
  readonly id: string
  readonly amount: number
  readonly currency: Currency
}

/** The payment was refused for good: retrying cannot help. A `NonRetryableError` is never retried. */
export class PaymentDeclinedError extends NonRetryableError {
  override readonly name = 'PaymentDeclinedError'
}

/** Transient failure (timeout, 503...): any other error is retried according to `@Retry`. */
export class PaymentGatewayUnavailableError extends Error {
  override readonly name = 'PaymentGatewayUnavailableError'
}

/** Failures simulated by `pm_card_flaky` before it succeeds. */
const FLAKY_FAILURES = 2

/**
 * A simulated payment provider client. A real one would call the provider's HTTP API with
 * `idempotencyKey`, so that a redelivered message never charges twice.
 */
@Injectable()
export class PaymentGateway {
  /** Captured payments by idempotency key, and failed calls of the flaky test method. */
  readonly #payments = new Map<string, Payment>()
  readonly #failures = new Map<string, number>()

  constructor(private readonly logger: Logger) {}

  /**
   * `@Traced` runs the call in a child span (here of the consumer span), `@Metric` records its
   * duration in the `payment_charge_duration_seconds` histogram (labels: class, method, outcome).
   * Both are interceptors bound by the compiler: no proxy, no runtime reflection.
   */
  @Traced({ name: 'payment.charge', kind: 'client', attributes: { 'payment.provider': 'simulated' } })
  @Metric({ name: 'payment_charge_duration_seconds', help: 'Duration of the calls to the payment gateway' })
  async charge(request: ChargeRequest): Promise<Payment> {
    const captured = this.#payments.get(request.idempotencyKey)
    if (captured !== undefined) return captured // idempotent replay

    await sleep(5) // network latency

    switch (request.paymentMethod) {
      case TestPaymentMethods.declined:
        throw new PaymentDeclinedError('Payment declined by the issuer (insufficient funds)')
      case TestPaymentMethods.unavailable:
        throw new PaymentGatewayUnavailableError('Payment gateway unavailable (503)')
      case TestPaymentMethods.flaky: {
        const failures = this.#failures.get(request.idempotencyKey) ?? 0
        if (failures < FLAKY_FAILURES) {
          this.#failures.set(request.idempotencyKey, failures + 1)
          throw new PaymentGatewayUnavailableError(`Payment gateway timeout (${failures + 1}/${FLAKY_FAILURES})`)
        }
        break
      }
      default:
    }

    const payment: Payment = { id: `pay_${randomUUID()}`, amount: request.amount, currency: request.currency }
    this.#payments.set(request.idempotencyKey, payment)
    this.#failures.delete(request.idempotencyKey)
    this.logger.debug('Payment captured', { paymentId: payment.id, amount: payment.amount })
    return payment
  }
}
