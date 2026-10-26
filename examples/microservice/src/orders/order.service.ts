import type { MessageBroker } from '@znight/messaging'
import type { Order } from './order.model.js'
import type { OrderRepository } from './order.repository.js'
import type { CreateOrder, OrderCreatedEvent } from './order.schemas.js'

import { randomUUID } from 'node:crypto'
import { Injectable } from '@znight/core'
import { type Logger, Metric } from '@znight/observability'

import { ORDER_CREATED, ORDERS_CREATED_QUEUE } from './order.events.js'
import { totalOf } from './order.model.js'

/**
 * Use cases of the orders. Every dependency is resolved at build time from the constructor types:
 * `OrderRepository` (abstract) is bound to `InMemoryOrderRepository`, `MessageBroker` and `Logger`
 * are provided at runtime by MessagingPlugin and ObservabilityPlugin.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly broker: MessageBroker,
    private readonly logger: Logger,
  ) {}

  /**
   * Stores a `pending` order and publishes its OrderCreated event. The payment happens
   * asynchronously, in `OrderCreatedConsumer`.
   *
   * The event carries the trace context of the request (`traceparent` header, added by
   * ObservabilityPlugin): the consumer span continues the trace of `POST /orders`.
   *
   * With a real database, write the order and the event in one transaction (transactional outbox)
   * so that a crash between the two can neither lose the event nor publish a ghost order.
   */
  @Metric({ type: 'counter', name: 'orders_created_total', help: 'Orders created through the API' })
  async create(input: CreateOrder): Promise<Order> {
    const now = new Date().toISOString()
    const order: Order = {
      id: randomUUID(),
      customerId: input.customerId,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
      lines: input.lines,
      amount: totalOf(input.lines),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    await this.orders.insert(order)

    const event: OrderCreatedEvent = {
      orderId: order.id,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      paymentMethod: order.paymentMethod,
      createdAt: order.createdAt,
    }
    // resolves once the broker confirmed the message; the order id is the message id, so a
    // retried publication can be deduplicated by consumers
    await this.broker.publish(ORDERS_CREATED_QUEUE, event, { type: ORDER_CREATED, id: order.id, key: order.customerId })

    this.logger.info('Order created', { orderId: order.id, amount: order.amount, currency: order.currency })
    return order
  }

  findById(id: string): Promise<Order | undefined> {
    return this.orders.findById(id)
  }

  /** `pending` → `confirmed`. */
  confirm(id: string, paymentId: string): Promise<Order | undefined> {
    return this.#transition(id, 'confirmed', { paymentId })
  }

  /** `pending` → `rejected` (payment declined). */
  reject(id: string, reason: string): Promise<Order | undefined> {
    return this.#transition(id, 'rejected', { reason })
  }

  /** `pending` → `failed` (processing failed for good). */
  fail(id: string, reason: string): Promise<Order | undefined> {
    return this.#transition(id, 'failed', { reason })
  }

  /** Only `pending` orders change: replaying a transition (a redelivered message) is a no-op. */
  #transition(
    id: string,
    status: Order['status'],
    details: Pick<Order, 'paymentId' | 'reason'>,
  ): Promise<Order | undefined> {
    return this.orders.update(id, order =>
      order.status === 'pending' ? { ...order, ...details, status, updatedAt: new Date().toISOString() } : order,
    )
  }
}
