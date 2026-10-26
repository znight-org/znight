import type { Logger } from '@znight/observability'
import type { Order } from './order.model.js'

import { Injectable } from '@znight/core'

/**
 * Persistence port of the orders. `OrderService` depends on this abstract class: the compiler binds
 * it to its only implementation below. To move to a database, add a `PostgresOrderRepository`
 * (`@Primary()`, or remove this one): nothing else changes.
 */
export abstract class OrderRepository {
  abstract insert(order: Order): Promise<void>
  abstract findById(id: string): Promise<Order | undefined>
  /** Applies `change` atomically; resolves `undefined` when the order does not exist. */
  abstract update(id: string, change: (order: Order) => Order): Promise<Order | undefined>
}

/**
 * Orders kept in memory: the store of a demo (lost on restart, not shared between instances).
 * Copies are returned so callers can never mutate the stored state.
 */
@Injectable()
export class InMemoryOrderRepository extends OrderRepository {
  readonly #orders = new Map<string, Order>()

  constructor(private readonly logger: Logger) {
    super()
  }

  insert(order: Order): Promise<void> {
    if (this.#orders.has(order.id)) return Promise.reject(new Error(`Order ${order.id} already exists`))
    this.#orders.set(order.id, structuredClone(order))
    return Promise.resolve()
  }

  findById(id: string): Promise<Order | undefined> {
    const order = this.#orders.get(id)
    return Promise.resolve(order === undefined ? undefined : structuredClone(order))
  }

  update(id: string, change: (order: Order) => Order): Promise<Order | undefined> {
    const current = this.#orders.get(id)
    if (current === undefined) return Promise.resolve(undefined)
    const updated = change(structuredClone(current))
    this.#orders.set(id, structuredClone(updated))
    return Promise.resolve(structuredClone(updated))
  }

  /**
   * Disposal hook, called on shutdown once the HTTP server and the consumers are drained (also when
   * the application failed to start). A database repository would close its connection pool here.
   */
  [Symbol.asyncDispose](): Promise<void> {
    this.logger.info('Order store closed', { orders: this.#orders.size })
    this.#orders.clear()
    return Promise.resolve()
  }
}
