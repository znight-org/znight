import type { CatalogService } from '../catalog/catalog.service.js'
import type { Cart, CartLine, CartResponse } from './cart.js'
import type { CartRepository } from './cart.repository.js'
import type { AddCartItem } from './cart.schemas.js'

import { randomUUID } from 'node:crypto'
import { Injectable } from '@znight/core'

import { ConflictError, NotFoundError } from '../shared/errors.js'

/** Most units of one product in a cart. */
export const MAX_QUANTITY = 99

/**
 * The carts of the customers. Every method takes the id of the customer making the request: a
 * cart of another customer is reported as missing (`404`), never as forbidden, so that cart ids
 * cannot be probed.
 */
@Injectable()
export class CartService {
  constructor(
    private readonly carts: CartRepository,
    private readonly catalog: CatalogService,
  ) {}

  create(customerId: string): Cart {
    const now = new Date()
    return this.carts.save({ id: randomUUID(), customerId, items: new Map(), createdAt: now, updatedAt: now })
  }

  get(customerId: string, id: string): Cart {
    const cart = this.carts.find(id)
    if (cart === undefined || cart.customerId !== customerId) throw new NotFoundError('cart', id)
    return cart
  }

  /** Adds units of a product: `404` for an unknown product, `409` beyond its stock. */
  addItem(customerId: string, id: string, { productId, quantity }: AddCartItem): Cart {
    const cart = this.get(customerId, id)
    const product = this.catalog.get(productId)
    const total = (cart.items.get(productId) ?? 0) + quantity
    if (total > Math.min(product.stock, MAX_QUANTITY)) {
      throw new ConflictError(`Only ${product.stock} unit(s) of ${product.sku} available`, {
        productId,
        available: product.stock,
        requested: total,
      })
    }
    const items = new Map(cart.items).set(productId, total)
    return this.carts.save({ ...cart, items, updatedAt: new Date() })
  }

  /** Removes the cart once it became an order. */
  close(cart: Cart): void {
    this.carts.delete(cart.id)
  }

  /** The cart with the current prices of the catalogue. */
  view(cart: Cart): CartResponse {
    const lines = [...cart.items].map(([productId, quantity]): CartLine => {
      const product = this.catalog.get(productId)
      return {
        productId,
        sku: product.sku,
        name: product.name,
        quantity,
        unitPriceCents: product.priceCents,
        totalCents: product.priceCents * quantity,
      }
    })
    return {
      id: cart.id,
      lines,
      totalCents: lines.reduce((sum, line) => sum + line.totalCents, 0),
      currency: 'EUR',
      updatedAt: cart.updatedAt,
    }
  }
}
