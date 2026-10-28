import type { OnStart } from '@znight/core'
import type { Logger } from '@znight/observability'
import type { CatalogConfig } from '../config/catalog.config.js'
import type { Page } from '../shared/page.js'
import type { Product, ProductImage, ProductQuery } from './product.js'
import type { ProductRepository } from './product.repository.js'
import type { CreateProduct } from './product.schemas.js'

import { Injectable } from '@znight/core'

import { NotFoundError, UnsupportedImageError } from '../shared/errors.js'
import { detectImageType } from './image.js'
import { SAMPLE_PRODUCTS } from './seed.js'

/**
 * The use cases of the catalogue. It knows nothing about HTTP: it throws domain errors
 * (`NotFoundError`, `ConflictError`, `UnsupportedImageError`) that `DomainErrorMapper` turns into
 * `404`, `409` and `415`.
 *
 * `onStart` is a lifecycle hook (duck-typed: no registration), called once every provider exists
 * and before the HTTP server listens: the sample products are there before the first request.
 */
@Injectable()
export class CatalogService implements OnStart {
  constructor(
    private readonly products: ProductRepository,
    private readonly config: CatalogConfig,
    private readonly logger: Logger,
  ) {}

  onStart(): void {
    if (!this.config.seed || this.products.all().length > 0) return
    for (const { id, ...product } of SAMPLE_PRODUCTS) this.products.insert(product, { id })
    this.logger.info('Catalogue seeded', { products: SAMPLE_PRODUCTS.length })
  }

  list(query: ProductQuery): Page<Product> {
    return this.products.list(query)
  }

  get(id: string): Product {
    const product = this.products.find(id)
    if (product === undefined) throw new NotFoundError('product', id)
    return product
  }

  /** Adds a product from the validated body (`price` is already in cents: see the schema). */
  create({ price, ...fields }: CreateProduct): Product {
    const product = this.products.insert({ ...fields, priceCents: price })
    this.logger.info('Product added', { productId: product.id, sku: product.sku })
    return product
  }

  /**
   * Stores the image of a product. The media type declared by the client was checked by
   * `@UploadedFile({ mimeTypes })`; the content decides: a file that is not really an image is a
   * `415`, whatever its declared type.
   */
  async setImage(id: string, file: File): Promise<Product> {
    this.get(id) // 404 before reading the bytes
    const bytes = await file.bytes()
    const contentType = detectImageType(bytes)
    if (contentType === undefined) throw new UnsupportedImageError()
    return this.products.setImage(id, { contentType, bytes, updatedAt: new Date() })
  }

  getImage(id: string): ProductImage {
    const image = this.get(id).image
    if (image === null) throw new NotFoundError('image', id)
    return image
  }

  /** Takes units out of the stock, all lines or none (`404`, `409`): see `ProductRepository.reserve`. */
  reserve(lines: readonly { readonly productId: string; readonly quantity: number }[]): Product[] {
    return this.products.reserve(lines)
  }

  /** Figures of the back office. */
  stats(): { readonly products: number; readonly outOfStock: number } {
    const all = this.products.all()
    return { products: all.length, outOfStock: all.filter(product => product.stock === 0).length }
  }
}
