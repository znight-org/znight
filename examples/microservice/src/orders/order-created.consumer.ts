import type { Logger } from '@znight/observability'
import type { OrderService } from './order.service.js'

import {
  Consumer,
  Ctx,
  type InboundMessage,
  Message,
  NonRetryableError,
  OnError,
  OnMessage,
  Retry,
} from '@znight/messaging'

import { PaymentDeclinedError, type PaymentGateway } from '../payments/payment.gateway.js'
import { ORDER_CREATED, ORDERS_CREATED_QUEUE } from './order.events.js'
import { OrderCreatedEvent } from './order.schemas.js'

/**
 * Charges the orders announced by OrderCreated events.
 *
 * Delivery is **at-least-once**: a message may be handled more than once (redelivery after a crash,
 * a lost acknowledgement...). The handler is idempotent: only `pending` orders are charged, and the
 * charge uses the order id as idempotency key.
 *
 * Every delivery runs in its own scope, inside a `CONSUMER` span continuing the trace of the request
 * that published the event: the logs below carry the same `traceId` as the `POST /orders` logs.
 */
@Consumer(ORDERS_CREATED_QUEUE)
export class OrderCreatedConsumer {
  constructor(
    private readonly orders: OrderService,
    private readonly payments: PaymentGateway,
    private readonly logger: Logger,
  ) {}

  /**
   * `@Message(OrderCreatedEvent)` validates the payload first: an invalid one is dead-lettered
   * immediately. A thrown error is retried with an exponential backoff (200 ms, 400 ms, 800 ms: 4
   * attempts in total), unless it is a `NonRetryableError`.
   */
  @OnMessage(ORDER_CREATED)
  @Retry({ attempts: 4, backoff: 'exponential', delay: 200, maxDelay: 5000 })
  async charge(@Message(OrderCreatedEvent) event: OrderCreatedEvent, @Ctx() message: InboundMessage): Promise<void> {
    const order = await this.orders.findById(event.orderId)
    // the event refers to an order this service does not know: retrying cannot fix it
    if (order === undefined) throw new NonRetryableError(`Order ${event.orderId} does not exist`)
    if (order.status !== 'pending') {
      this.logger.info('Order already processed: duplicate delivery ignored', {
        orderId: order.id,
        status: order.status,
      })
      return
    }

    const payment = await this.payments.charge({
      idempotencyKey: order.id,
      amount: order.amount,
      currency: order.currency,
      paymentMethod: order.paymentMethod,
    })
    await this.orders.confirm(order.id, payment.id)
    this.logger.info('Order confirmed', { orderId: order.id, paymentId: payment.id, attempt: message.attempt })
  }

  /**
   * Called once a message will not be retried anymore: a `NonRetryableError` (declined payment,
   * unknown order), an invalid payload, or the last attempt failed. Returning `'ack'` acknowledges
   * the message; returning nothing moves it to the dead-letter queue (`orders.created.dlq`), where it
   * waits for an operator (inspect, fix, redrive).
   */
  @OnError()
  async onError(error: unknown, message: InboundMessage): Promise<'ack' | undefined> {
    const orderId = orderIdOf(message.payload)
    if (error instanceof PaymentDeclinedError && orderId !== undefined) {
      // a business outcome, not an incident: nothing to redrive
      await this.orders.reject(orderId, error.message)
      this.logger.warn('Payment declined: order rejected', { orderId, reason: error.message })
      return 'ack'
    }
    const reason = error instanceof Error ? error.message : String(error)
    if (orderId !== undefined) await this.orders.fail(orderId, reason)
    this.logger.error('Order processing failed: message dead-lettered', {
      orderId,
      messageId: message.id,
      attempts: message.attempt,
      err: error,
    })
    return undefined
  }
}

/** The order id of a payload that may not have passed validation. */
function orderIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { orderId } = payload as { orderId?: unknown }
  return typeof orderId === 'string' ? orderId : undefined
}
