/*
 * Orders: the domain model is also what the API sends (no internal field to hide). The comments
 * below are the documentation of the `Order`, `CardPayment` and `TransferPayment` components.
 *
 * `Payment` is a **discriminated union**: two named interfaces with a required literal property
 * (`method`). The OpenAPI compiler documents it as `oneOf` with a `discriminator` on `method`, and
 * a `mapping` from each value to its component, which generated clients turn back into a union
 * they can narrow (`if (order.payment.method === 'card') order.payment.last4`).
 */
import type { Currency } from '../catalog/product.js'

/** `paid`: paid by card when placed. `awaiting-transfer`: waiting for the bank transfer. */
export type OrderStatus = 'paid' | 'awaiting-transfer'

/** A card payment, captured when the order was placed. */
export interface CardPayment {
  readonly method: 'card'
  /**
   * Last four digits of the card.
   * @pattern ^[0-9]{4}$
   * @example "4242"
   */
  readonly last4: string
  readonly capturedAt: Date
}

/** A bank transfer the customer still has to make. */
export interface TransferPayment {
  readonly method: 'transfer'
  /**
   * Reference to write on the transfer.
   * @example "SF-7K2M9Q"
   */
  readonly reference: string
  /** IBAN of the shop, to send the transfer to. */
  readonly iban: string
  /** The order is cancelled when the transfer has not arrived by then. */
  readonly dueBy: Date
}

/** How an order is paid. */
export type Payment = CardPayment | TransferPayment

/** A line of an order, at the price of the moment it was placed. */
export interface OrderLine {
  /** @format uuid */
  readonly productId: string
  readonly sku: string
  readonly name: string
  /**
   * @format int32
   * @minimum 1
   */
  readonly quantity: number
  /** @format int32 */
  readonly unitPriceCents: number
  /** @format int32 */
  readonly totalCents: number
}

/** An order of a customer. */
export interface Order {
  /** @format uuid */
  readonly id: string
  /** @example "alice" */
  readonly customerId: string
  readonly status: OrderStatus
  readonly lines: readonly OrderLine[]
  /**
   * Sum of the lines, in cents.
   * @format int32
   */
  readonly totalCents: number
  readonly currency: Currency
  readonly payment: Payment
  readonly createdAt: Date
}
