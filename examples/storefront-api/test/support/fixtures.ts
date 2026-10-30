import type { Product } from '../../src/catalog/product.js'

/** Credentials of the tests (`inline()` configuration, see `app.ts`). */
export const ADMIN_KEY = 'test-admin-key'
export const CATALOG_KEY = 'test-catalog-key'
export const ALICE_TOKEN = 'test-alice-token'
export const BOB_TOKEN = 'test-bob-token'

/** Request headers of each kind of caller. */
export const admin = { 'x-api-key': ADMIN_KEY } as const
export const catalog = { 'x-api-key': CATALOG_KEY } as const
export const alice = { authorization: `Bearer ${ALICE_TOKEN}` } as const
export const bob = { authorization: `Bearer ${BOB_TOKEN}` } as const

/** The configuration of the tests: what `.env.development` gives `bun run dev`. */
export const TEST_ENV: Readonly<Record<string, string>> = {
  ADMIN_API_KEY: ADMIN_KEY,
  CATALOG_API_KEY: CATALOG_KEY,
  CUSTOMER_TOKENS: JSON.stringify({ alice: ALICE_TOKEN, bob: BOB_TOKEN }),
}

/** Ids of the sample products (`CATALOG_SEED=true`, src/catalog/seed.ts). */
export const MUG = '0d6f2c4e-5b1a-4c3e-9f8a-2b7d1e6a9c01' // 42 in stock, 14.90 €
export const TEE = '6a3e9b1d-2c4f-4e8a-b7d0-5f1c3a9e2b02' // 7 in stock, 24.00 € (the third one is out of stock)

/** A well-formed id that nothing has. */
export const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

/** The 8-byte PNG signature followed by a few bytes: enough for the content sniffing of images. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])

export function pngFile(name = 'mug.png', type = 'image/png', bytes: Uint8Array = PNG_BYTES): File {
  return new File([bytes.slice()], name, { type })
}

/** A multipart body with one `image` file field. */
export function imageForm(file: File = pngFile()): FormData {
  const form = new FormData()
  form.append('image', file)
  return form
}

/** A valid body of `POST /products` (the schema **input**: the price in euros, as a string). */
export function newProduct(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sku: `sku-${crypto.randomUUID().slice(0, 8)}`,
    name: 'Compiler stickers',
    category: 'home',
    price: '4.50',
    stock: 10,
    tags: ['Sticker', ' Gift '],
    ...fields,
  }
}

/** A domain product, for unit tests. */
export function aProduct(fields: Partial<Product> = {}): Product {
  return {
    id: MUG,
    sku: 'MUG-ZNIGHT',
    name: 'Night owl mug',
    description: null,
    category: 'home',
    priceCents: 1490,
    stock: 42,
    tags: ['mug'],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    image: null,
    ...fields,
  }
}
