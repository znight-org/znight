/*
 * The catalogue: the domain model of a product, and the types the API sends.
 *
 * The response types are plain TypeScript interfaces. The OpenAPI compiler extension turns them into
 * JSON Schema components at build time, and their JSDoc into documentation: the first paragraph of
 * a comment becomes the `description`, tags such as `@format`, `@minimum` or `@example` become JSON
 * Schema keywords. So comments on these types are written for the API's clients.
 */
import type { ImageType } from './image.js'

/** Departments of the shop. */
export type Category = 'apparel' | 'books' | 'home' | 'toys'

/** Orders of the product list: alphabetical, newest first, cheapest or most expensive first. */
export type ProductSort = 'name' | 'newest' | 'price-asc' | 'price-desc'

/** Currency of every price: the shop sells in euros. */
export type Currency = 'EUR'

// ---- Domain model ---------------------------------------------------------------------------------

/** A product of the catalogue, as the services see it (independent of HTTP). */
export interface Product {
  readonly id: string
  readonly sku: string
  readonly name: string
  readonly description: string | null
  readonly category: Category
  readonly priceCents: number
  readonly stock: number
  readonly tags: readonly string[]
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly image: ProductImage | null
}

/** The image of a product, stored with the product. */
export interface ProductImage {
  readonly contentType: ImageType
  readonly bytes: Uint8Array
  readonly updatedAt: Date
}

/** Fields of a new product (the output of the `CreateProduct` schema). */
export interface NewProduct {
  readonly sku: string
  readonly name: string
  readonly description: string | null
  readonly category: Category
  readonly priceCents: number
  readonly stock: number
  readonly tags: readonly string[]
}

/** Criteria of the product list. */
export interface ProductQuery {
  readonly search?: string | undefined
  readonly category?: Category | undefined
  readonly tags: readonly string[]
  readonly inStock: boolean
  readonly sort: ProductSort
  readonly limit: number
  readonly offset: number
}

// ---- What the API sends ---------------------------------------------------------------------------

/** A product as listed in the catalogue. */
export interface ProductSummary {
  /** @format uuid */
  readonly id: string
  /**
   * Stock keeping unit, unique in the catalogue.
   * @example "MUG-ZNIGHT"
   */
  readonly sku: string
  /** @example "Night owl mug" */
  readonly name: string
  readonly category: Category
  /**
   * Unit price, in cents of `currency`.
   * @format int32
   * @minimum 1
   * @example 1490
   */
  readonly priceCents: number
  readonly currency: Currency
  /** Whether the product can be ordered now. */
  readonly inStock: boolean
  /** Path of the product image (`GET /products/{id}/image`), `null` when the product has none. */
  readonly imageUrl: string | null
}

/** A product, in full. */
export interface ProductResponse extends ProductSummary {
  readonly description: string | null
  /**
   * Units available.
   * @format int32
   * @minimum 0
   */
  readonly stock: number
  /** Lower-case labels, used to filter the list (`?tag=`). */
  readonly tags: readonly string[]
  readonly createdAt: Date
  /** Last change of the product or of its image. */
  readonly updatedAt: Date
}

export function toSummary(product: Product): ProductSummary {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category,
    priceCents: product.priceCents,
    currency: 'EUR',
    inStock: product.stock > 0,
    imageUrl: product.image === null ? null : `/products/${product.id}/image`,
  }
}

export function toResponse(product: Product): ProductResponse {
  return {
    ...toSummary(product),
    description: product.description,
    stock: product.stock,
    tags: product.tags,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  }
}
