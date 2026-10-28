import type { Logger } from '@znight/observability'
import type { CartService } from '../carts/cart.service.js'
import type { CatalogService } from '../catalog/catalog.service.js'
import type { Order, OrderLine, OrderStatus, Payment } from './order.js'
import type { OrderRepository } from './order.repository.js'
import type { PlaceOrder } from './order.schemas.js'

import { randomInt, randomUUID } from 'node:crypto'
import { Injectable } from '@znight/core'

import { ConflictError, NotFoundError } from '../shared/errors.js'

/** IBAN of the shop, given to the customers paying by transfer (an example IBAN). */
export const SHOP_IBAN = 'FR76 3000 6000 0112 3456 7890 189'

/** Orders read at once by the export. */
export const EXPORT_PAGE_SIZE = 100

/** Days a customer has to make the transfer. */
const TRANSFER_DAYS = 7

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I

/**
 * Orders: placing one turns a cart into an order, takes the units out of the stock and records the
 * payment. Like the other services, it throws domain errors only.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly carts: CartService,
    private readonly catalog: CatalogService,
    private readonly logger: Logger,
  ) {}

  /**
   * Places the order of a cart: `404` for a cart of someone else, `409` for an empty cart or a stock
   * that changed since the products were added (nothing is taken from the stock then).
   */
  place(customerId: string, { cartId, payment }: PlaceOrder): Order {
    const cart = this.carts.get(customerId, cartId)
    if (cart.items.size === 0) throw new ConflictError('The cart is empty', { cartId })
    const products = this.catalog.reserve([...cart.items].map(([productId, quantity]) => ({ productId, quantity })))
    const lines = products.map((product): OrderLine => {
      const quantity = cart.items.get(product.id) ?? 0
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        quantity,
        unitPriceCents: product.priceCents,
        totalCents: product.priceCents * quantity,
      }
    })
    const now = new Date()
    // the discriminated union narrows `payment`: only the card option has a token
    const recorded: Payment =
      payment.method === 'card'
        ? { method: 'card', last4: payment.token.slice(-4), capturedAt: now }
        : {
            method: 'transfer',
            reference: transferReference(),
            iban: SHOP_IBAN,
            dueBy: new Date(now.getTime() + TRANSFER_DAYS * 86_400_000),
          }
    const order = this.orders.save({
      id: randomUUID(),
      customerId,
      status: recorded.method === 'card' ? 'paid' : 'awaiting-transfer',
      lines,
      totalCents: lines.reduce((sum, line) => sum + line.totalCents, 0),
      currency: 'EUR',
      payment: recorded,
      createdAt: now,
    })
    this.carts.close(cart)
    this.logger.info('Order placed', { orderId: order.id, customerId, totalCents: order.totalCents })
    return order
  }

  /** An order of the customer (`404` for the orders of other customers). */
  get(customerId: string, id: string): Order {
    const order = this.orders.find(id)
    if (order === undefined || order.customerId !== customerId) throw new NotFoundError('order', id)
    return order
  }

  /**
   * The orders placed since a date, oldest first, one at a time. They are read a page at a time
   * (keyset pagination), so an export never holds every order in memory; the next page is only
   * read once the client received the previous one, and nothing more is read when it disconnects
   * (the HTTP plugin stops the generator).
   */
  async *export(since?: Date, pageSize = EXPORT_PAGE_SIZE): AsyncGenerator<Order> {
    let after: string | undefined
    for (;;) {
      const page = await this.orders.page({ since, after, limit: pageSize })
      yield* page
      if (page.length < pageSize) return
      after = page.at(-1)?.id
    }
  }

  /** Figures of the back office. */
  stats(): { readonly orders: number; readonly revenueCents: number; readonly byStatus: Record<OrderStatus, number> } {
    const byStatus: Record<OrderStatus, number> = { paid: 0, 'awaiting-transfer': 0 }
    let revenueCents = 0
    for (const order of this.orders.all()) {
      byStatus[order.status]++
      if (order.status === 'paid') revenueCents += order.totalCents
    }
    return { orders: byStatus.paid + byStatus['awaiting-transfer'], revenueCents, byStatus }
  }
}

/** `SF-` and six characters that cannot be mistaken for one another. */
function transferReference(): string {
  let reference = 'SF-'
  for (let index = 0; index < 6; index++) reference += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]
  return reference
}
