import type { NewProduct } from './product.js'

/**
 * Sample products (`CATALOG_SEED=true`, set in `.env.development`), with fixed ids so that the curl
 * examples of the README can be copied as they are.
 */
export const SAMPLE_PRODUCTS: readonly (NewProduct & { readonly id: string })[] = [
  {
    id: '0d6f2c4e-5b1a-4c3e-9f8a-2b7d1e6a9c01',
    sku: 'MUG-ZNIGHT',
    name: 'Night owl mug',
    description: 'A 350 ml stoneware mug for late compiles.',
    category: 'home',
    priceCents: 1490,
    stock: 42,
    tags: ['mug', 'gift'],
  },
  {
    id: '6a3e9b1d-2c4f-4e8a-b7d0-5f1c3a9e2b02',
    sku: 'TEE-DI-BLACK',
    name: 'Compile-time DI t-shirt',
    description: null,
    category: 'apparel',
    priceCents: 2400,
    stock: 7,
    tags: ['tshirt', 'gift'],
  },
  {
    id: '9c1b7e3a-4d2f-4a6b-8e5c-1f9d2a7b3c03',
    sku: 'BOOK-AST',
    name: 'Abstract syntax trees for humans',
    description: 'From source text to decorators, one node at a time.',
    category: 'books',
    priceCents: 3900,
    stock: 0,
    tags: ['typescript'],
  },
]
