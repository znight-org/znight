import type { Currency, OrderLine } from './order.schemas.js'

/**
 * Lifecycle of an order:
 *
 * ```
 * pending ──► confirmed   payment captured
 *    │
 *    ├──────► rejected    payment declined (a business outcome: the message is acknowledged)
 *    └──────► failed      processing failed for good (the message is dead-lettered for inspection)
 * ```
 */
export type OrderStatus = 'pending' | 'confirmed' | 'rejected' | 'failed'

export interface Order {
  readonly id: string
  readonly customerId: string
  readonly currency: Currency
  readonly paymentMethod: string
  readonly lines: readonly OrderLine[]
  /** Total in minor units (cents). */
  readonly amount: number
  readonly status: OrderStatus
  /** Payment reference, once `confirmed`. */
  readonly paymentId?: string
  /** Why the order was `rejected` or `failed`. */
  readonly reason?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Total of the order lines, in minor units. */
export function totalOf(lines: readonly OrderLine[]): number {
  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0)
}
