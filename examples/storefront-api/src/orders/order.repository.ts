import type { Order } from './order.js'

import { Injectable } from '@znight/core'

/** Criteria of {@link OrderRepository.page}. */
export interface OrderPageQuery {
  /** Only the orders placed at or after this date. */
  readonly since?: Date | undefined
  /** Keyset pagination: the orders placed after this one (the last order of the previous page). */
  readonly after?: string | undefined
  readonly limit: number
}

/** The orders, in memory (see `ProductRepository`). */
@Injectable()
export class OrderRepository {
  readonly #orders = new Map<string, Order>()

  find(id: string): Order | undefined {
    return this.#orders.get(id)
  }

  save(order: Order): Order {
    this.#orders.set(order.id, order)
    return order
  }

  /** Every order, oldest first (a `Map` keeps the insertion order). */
  all(): Order[] {
    return [...this.#orders.values()]
  }

  /**
   * One page of orders, oldest first. Asynchronous like the query of a real database would be: the
   * export reads the orders page by page, never all of them at once.
   */
  page({ since, after, limit }: OrderPageQuery): Promise<Order[]> {
    const orders = this.all().filter(order => since === undefined || order.createdAt >= since)
    const start = after === undefined ? 0 : orders.findIndex(order => order.id === after) + 1
    return Promise.resolve(orders.slice(start, start + limit))
  }
}
