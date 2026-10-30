import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { CatalogService } from '../src/catalog/catalog.service.js'
import { ProductRepository } from '../src/catalog/product.repository.js'
import { CreateProduct } from '../src/catalog/product.schemas.js'
import { SAMPLE_PRODUCTS } from '../src/catalog/seed.js'
import { NotFoundError, UnsupportedImageError } from '../src/shared/errors.js'
import { aProduct, MUG, PNG_BYTES, pngFile } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

/**
 * Unit tests: TestBed builds the real `CatalogService` with its generated factory and auto-mocks
 * `ProductRepository` and `Logger`. `CatalogConfig` is a `@Config` class: TestBed builds a real
 * instance from the `config` values (keyed by its `@Config` prefix).
 */
async function setup(seed = false) {
  const { instance, mocks } = await TestBed.create(CatalogService, { metadata, config: { catalog: { seed } } })
  return { service: instance, products: mocks.get(ProductRepository), logger: mocks.get(Logger) }
}

describe('CatalogService', () => {
  it('seeds the sample products on start, once', async () => {
    const { service, products } = await setup(true)
    products.all.mockReturnValueOnce([]).mockReturnValueOnce([aProduct()])

    service.onStart() // lifecycle hooks are not called by TestBed
    service.onStart() // a catalogue that has products is left alone

    expect(products.insert).toHaveBeenCalledTimes(SAMPLE_PRODUCTS.length)
    expect(products.insert).toHaveBeenCalledWith(expect.objectContaining({ sku: 'MUG-ZNIGHT' }), { id: MUG })
  })

  it('does not seed unless configured', async () => {
    const { service, products } = await setup(false)

    service.onStart()

    expect(products.insert).not.toHaveBeenCalled()
  })

  it('adds a product from the output of the CreateProduct schema', async () => {
    const { service, products, logger } = await setup()
    products.insert.mockImplementation(fields => aProduct({ ...fields, id: 'new' }))
    // what @Body(CreateProduct) injects: the schema output (trimmed, upper-cased SKU, price in cents)
    const input = CreateProduct.parse({ sku: ' tee-01 ', name: 'Tee', category: 'apparel', price: '19.9' })

    const product = service.create(input)

    expect(input).toMatchObject({ sku: 'TEE-01', price: 1990, stock: 0, tags: [], description: null })
    expect(products.insert).toHaveBeenCalledWith({
      sku: 'TEE-01',
      name: 'Tee',
      description: null,
      category: 'apparel',
      priceCents: 1990,
      stock: 0,
      tags: [],
    })
    expect(product.priceCents).toBe(1990)
    expect(logger.info).toHaveBeenCalledWith('Product added', { productId: 'new', sku: 'TEE-01' })
  })

  it('stores an image with the type of its content, not the declared one', async () => {
    const { service, products } = await setup()
    products.find.mockReturnValue(aProduct())
    products.setImage.mockImplementation((id, image) => aProduct({ id, image }))

    // declared as a JPEG, but the bytes are a PNG
    const product = await service.setImage(MUG, pngFile('mug.jpg', 'image/jpeg'))

    expect(product.image).toMatchObject({ contentType: 'image/png', bytes: PNG_BYTES })
  })

  it('refuses a file that is not an image, whatever its declared type (415)', async () => {
    const { service, products } = await setup()
    products.find.mockReturnValue(aProduct())

    const fake = new File(['<script>alert(1)</script>'], 'mug.png', { type: 'image/png' })

    await expect(service.setImage(MUG, fake)).rejects.toBeInstanceOf(UnsupportedImageError)
    expect(products.setImage).not.toHaveBeenCalled()
  })

  it('reports an unknown product before reading the upload (404)', async () => {
    const { service, products } = await setup()
    products.find.mockReturnValue(undefined)
    const file = pngFile()
    const bytes = file.bytes.bind(file)
    let read = false
    file.bytes = () => {
      read = true
      return bytes()
    }

    await expect(service.setImage('missing', file)).rejects.toBeInstanceOf(NotFoundError)
    expect(read).toBe(false)
  })

  it('reports a product without image (404)', async () => {
    const { service, products } = await setup()
    products.find.mockReturnValue(aProduct({ image: null }))

    expect(() => service.getImage(MUG)).toThrow(new NotFoundError('image', MUG))
  })
})
