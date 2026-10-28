/*
 * Carts: the domain model and what the API sends. As everywhere in this example, the comments of
 * the response types are written for the API's clients: they become the descriptions of the
 * OpenAPI components.
 */
import type { Currency } from '../catalog/product.js'

/** A cart of a customer, as the services see it. */
export interface Cart {
  readonly id: string
  readonly customerId: string
  /** Quantities by product id, in the order the products were added. */
  readonly items: ReadonlyMap<string, number>
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** A line of a cart, priced with the current catalogue. */
export interface CartLine {
  /** @format uuid */
  readonly productId: string
  /** @example "MUG-ZNIGHT" */
  readonly sku: string
  readonly name: string
  /**
   * @format int32
   * @minimum 1
   */
  readonly quantity: number
  /**
   * Current unit price, in cents.
   * @format int32
   */
  readonly unitPriceCents: number
  /**
   * `quantity × unitPriceCents`.
   * @format int32
   */
  readonly totalCents: number
}

/** The cart of a customer. Prices follow the catalogue until the order is placed. */
export interface CartResponse {
  /** @format uuid */
  readonly id: string
  readonly lines: readonly CartLine[]
  /**
   * Sum of the lines, in cents.
   * @format int32
   */
  readonly totalCents: number
  readonly currency: Currency
  readonly updatedAt: Date
}
