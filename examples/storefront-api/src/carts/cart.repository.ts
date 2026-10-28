import type { Cart } from './cart.js'

import { Injectable } from '@znight/core'

/** The carts, in memory (see `ProductRepository`). */
@Injectable()
export class CartRepository {
  readonly #carts = new Map<string, Cart>()

  find(id: string): Cart | undefined {
    return this.#carts.get(id)
  }

  save(cart: Cart): Cart {
    this.#carts.set(cart.id, cart)
    return cart
  }

  delete(id: string): void {
    this.#carts.delete(id)
  }
}
