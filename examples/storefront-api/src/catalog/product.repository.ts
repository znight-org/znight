import type { Page } from '../shared/page.js'
import type { NewProduct, Product, ProductImage, ProductQuery } from './product.js'

import { randomUUID } from 'node:crypto'
import { Injectable } from '@znight/core'

import { ConflictError, NotFoundError } from '../shared/errors.js'

/** Comparators of the product list, by `ProductSort`. */
const COMPARATORS = {
  name: (a: Product, b: Product) => a.name.localeCompare(b.name, 'en'),
  newest: (a: Product, b: Product) => b.createdAt.getTime() - a.createdAt.getTime(),
  'price-asc': (a: Product, b: Product) => a.priceCents - b.priceCents,
  'price-desc': (a: Product, b: Product) => b.priceCents - a.priceCents,
} satisfies Record<ProductQuery['sort'], (a: Product, b: Product) => number>

/**
 * The products, in memory. The data layer is the subject of `examples/rest-api` (Drizzle,
 * PostgreSQL); here a `Map` keeps the example about the API contract.
 *
 * Products are immutable values: every change stores a new object, so a product handed to a caller
 * never changes under its feet. JavaScript runs one request at a time between two `await`s, so the
 * synchronous methods below are atomic (`reserve` checks and decrements every stock at once).
 */
@Injectable()
export class ProductRepository {
  readonly #products = new Map<string, Product>()

  list(query: ProductQuery): Page<Product> {
    const search = query.search?.trim().toLowerCase()
    const matches = [...this.#products.values()]
      .filter(product => query.category === undefined || product.category === query.category)
      .filter(product => query.tags.every(tag => product.tags.includes(tag.toLowerCase())))
      .filter(product => !query.inStock || product.stock > 0)
      .filter(
        product =>
          !search ||
          product.name.toLowerCase().includes(search) ||
          (product.description?.toLowerCase().includes(search) ?? false),
      )
      .sort((a, b) => COMPARATORS[query.sort](a, b) || a.sku.localeCompare(b.sku))
    return {
      items: matches.slice(query.offset, query.offset + query.limit),
      total: matches.length,
      limit: query.limit,
      offset: query.offset,
    }
  }

  find(id: string): Product | undefined {
    return this.#products.get(id)
  }

  /** Every product (statistics). */
  all(): Product[] {
    return [...this.#products.values()]
  }

  /** Adds a product; `id` and `createdAt` are given by the seed only. */
  insert(fields: NewProduct, { id = randomUUID(), now = new Date() }: { id?: string; now?: Date } = {}): Product {
    for (const product of this.#products.values()) {
      if (product.sku === fields.sku) {
        throw new ConflictError(`A product with SKU ${fields.sku} already exists`, { sku: fields.sku, id: product.id })
      }
    }
    const product: Product = { ...fields, id, createdAt: now, updatedAt: now, image: null }
    this.#products.set(id, product)
    return product
  }

  setImage(id: string, image: ProductImage): Product {
    const product = this.#get(id)
    const updated: Product = { ...product, image, updatedAt: image.updatedAt }
    this.#products.set(id, updated)
    return updated
  }

  /**
   * Takes `quantity` units of each product, all or nothing: the first line that cannot be served
   * throws (`404` for a product that disappeared, `409` for a stock too low) and nothing changes.
   */
  reserve(lines: readonly { readonly productId: string; readonly quantity: number }[]): Product[] {
    const products = lines.map(line => {
      const product = this.#get(line.productId)
      if (product.stock < line.quantity) {
        throw new ConflictError(`Only ${product.stock} unit(s) of ${product.sku} left`, {
          productId: product.id,
          available: product.stock,
          requested: line.quantity,
        })
      }
      return product
    })
    const now = new Date()
    return products.map((product, index) => {
      const updated: Product = { ...product, stock: product.stock - (lines[index]?.quantity ?? 0), updatedAt: now }
      this.#products.set(product.id, updated)
      return updated
    })
  }

  #get(id: string): Product {
    const product = this.#products.get(id)
    if (product === undefined) throw new NotFoundError('product', id)
    return product
  }
}
