import type { OpenApiObject } from '@znight/openapi'
import type { InjectRequest, InjectResponse, TestApp } from '@znight/testing'

import { OpenApi } from '@znight/openapi'
import { validateResponse } from '@znight/openapi/testing'

import { createTestApp } from './support/app.js'
import { validateNdjsonLines } from './support/contract.js'
import {
  admin,
  alice,
  bob,
  catalog,
  imageForm,
  MUG,
  newProduct,
  PNG_BYTES,
  pngFile,
  TEE,
  UNKNOWN_ID,
} from './support/fixtures.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/** An operation of the document: `GET /products/{id}`. */
type Operation = `${'GET' | 'POST' | 'PUT'} /${string}`

/** One documented response, and a request that gets it. */
interface ContractCase {
  readonly operation: Operation
  readonly status: number
  /** What the request does (the test name). */
  readonly when: string
  /** The request, without its method (the one of the operation). */
  readonly request: () => Omit<InjectRequest, 'method'>
  /** More checks of the response. */
  readonly check?: (response: InjectResponse, document: OpenApiObject) => void
}

/** A 400 of a schema (body, `@Param('id', Id)`) lists every problem in `details`. */
function listsEveryProblem(response: InjectResponse): void {
  expect(response.json<{ details?: unknown[] }>().details?.length).toBeGreaterThan(0)
}

/** A 400 of a coerced query parameter (`@Query('sort') sort: ProductSort`) names the parameter. */
function namesTheParameter(response: InjectResponse): void {
  expect(response.json<{ message: string }>().message).toStartWith('Invalid query')
}

/** Each line of the export is an `Order`, as documented for `application/x-ndjson`. */
function oneOrderPerLine(response: InjectResponse, document: OpenApiObject): void {
  expect(response.body.split('\n').filter(Boolean)).toHaveLength(1)
  expect(validateNdjsonLines(document, { path: '/orders/export', response })).toEqual([])
}

/** Ids created while the cases run (a cart, an order, the ETag of an image...). */
const state = { cart: '', emptyCart: '', order: '', etag: '' }

/** A JSON body over the `bodyLimit` of src/http.ts (64 KiB). */
const OVERSIZED = { padding: 'x'.repeat(70 * 1024) }

/**
 * Every response the document declares, obtained from the real application: each case sends a
 * request, then `validateResponse()` checks the answer against the documentation of its operation
 * (status, media type, required headers, JSON body against the schema). The last test checks that
 * the cases cover every documented response, so a new `@ApiResponse` needs a case here.
 *
 * The cases share one application and run in order: the cart of the first ones is ordered later.
 */
const CASES: readonly ContractCase[] = [
  // ---- catalogue: public reads -------------------------------------------------------------------
  {
    operation: 'GET /products',
    status: 200,
    when: 'filtered, sorted and paginated',
    request: () => ({ url: '/products?tag=gift&sort=price-desc&limit=1&offset=1' }),
  },
  {
    operation: 'GET /products',
    status: 400,
    when: 'unknown sort',
    request: () => ({ url: '/products?sort=cheap' }),
    check: namesTheParameter,
  },
  { operation: 'GET /products/{id}', status: 200, when: 'a product', request: () => ({ url: `/products/${MUG}` }) },
  {
    operation: 'GET /products/{id}',
    status: 400,
    when: 'an id that is not a UUID',
    request: () => ({ url: '/products/42' }),
    check: listsEveryProblem,
  },
  {
    operation: 'GET /products/{id}',
    status: 404,
    when: 'an unknown id',
    request: () => ({ url: `/products/${UNKNOWN_ID}` }),
  },

  // ---- catalogue: back office ---------------------------------------------------------------------
  {
    operation: 'POST /products',
    status: 201,
    when: 'a new product',
    request: () => ({ url: '/products', headers: catalog, body: newProduct() }),
  },
  {
    operation: 'POST /products',
    status: 400,
    when: 'an invalid body',
    request: () => ({ url: '/products', headers: catalog, body: newProduct({ price: 14.9, category: 'food' }) }),
    check: listsEveryProblem,
  },
  {
    operation: 'POST /products',
    status: 401,
    when: 'no credentials',
    request: () => ({ url: '/products', body: newProduct() }),
  },
  {
    operation: 'POST /products',
    status: 403,
    when: 'a customer token',
    request: () => ({ url: '/products', headers: alice, body: newProduct() }),
  },
  {
    operation: 'POST /products',
    status: 409,
    when: 'a SKU that exists once normalised',
    request: () => ({ url: '/products', headers: catalog, body: newProduct({ sku: ' mug-znight ' }) }),
  },
  {
    operation: 'POST /products',
    status: 413,
    when: 'a body over the limit',
    request: () => ({ url: '/products', headers: catalog, body: newProduct(OVERSIZED) }),
  },
  {
    operation: 'POST /products/validate',
    status: 200,
    when: 'a valid product',
    request: () => ({ url: '/products/validate', headers: catalog, body: newProduct() }),
  },
  {
    operation: 'POST /products/validate',
    status: 400,
    when: 'an invalid product',
    request: () => ({ url: '/products/validate', headers: catalog, body: { sku: '!' } }),
    check: listsEveryProblem,
  },
  {
    operation: 'POST /products/validate',
    status: 401,
    when: 'no credentials',
    request: () => ({ url: '/products/validate', body: newProduct() }),
  },
  {
    operation: 'POST /products/validate',
    status: 403,
    when: 'a customer token',
    request: () => ({ url: '/products/validate', headers: alice, body: newProduct() }),
  },
  {
    operation: 'POST /products/validate',
    status: 413,
    when: 'a body over the limit',
    request: () => ({ url: '/products/validate', headers: catalog, body: newProduct(OVERSIZED) }),
  },
  {
    operation: 'PUT /products/{id}/image',
    status: 200,
    when: 'a PNG image',
    request: () => ({ url: `/products/${MUG}/image`, headers: catalog, body: imageForm() }),
  },
  {
    operation: 'PUT /products/{id}/image',
    status: 400,
    when: 'an invalid id',
    request: () => ({ url: '/products/mug/image', headers: catalog, body: imageForm() }),
    check: listsEveryProblem,
  },
  {
    operation: 'PUT /products/{id}/image',
    status: 401,
    when: 'no credentials',
    request: () => ({ url: `/products/${MUG}/image`, body: imageForm() }),
  },
  {
    operation: 'PUT /products/{id}/image',
    status: 403,
    when: 'a customer token',
    request: () => ({ url: `/products/${MUG}/image`, headers: alice, body: imageForm() }),
  },
  {
    operation: 'PUT /products/{id}/image',
    status: 404,
    when: 'an unknown product',
    request: () => ({ url: `/products/${UNKNOWN_ID}/image`, headers: catalog, body: imageForm() }),
  },
  {
    operation: 'PUT /products/{id}/image',
    status: 413,
    when: 'an image over 1 MiB',
    request: () => {
      const big = new Uint8Array(1024 * 1024 + 1)
      big.set(PNG_BYTES)
      return { url: `/products/${MUG}/image`, headers: catalog, body: imageForm(pngFile('big.png', 'image/png', big)) }
    },
  },
  {
    operation: 'PUT /products/{id}/image',
    status: 415,
    when: 'a file that is not an image',
    request: () => ({
      url: `/products/${MUG}/image`,
      headers: catalog,
      body: imageForm(new File(['%PDF-1.7'], 'mug.pdf', { type: 'application/pdf' })),
    }),
  },
  {
    operation: 'GET /products/{id}/image',
    status: 200,
    when: 'the image',
    request: () => ({ url: `/products/${MUG}/image` }),
  },
  {
    operation: 'GET /products/{id}/image',
    status: 206,
    when: 'a range of the image',
    request: () => ({ url: `/products/${MUG}/image`, headers: { range: 'bytes=0-3' } }),
  },
  {
    operation: 'GET /products/{id}/image',
    status: 304,
    when: 'an image that did not change',
    request: () => ({ url: `/products/${MUG}/image`, headers: { 'if-none-match': state.etag } }),
  },
  {
    operation: 'GET /products/{id}/image',
    status: 400,
    when: 'an invalid id',
    request: () => ({ url: '/products/mug/image' }),
    check: listsEveryProblem,
  },
  {
    operation: 'GET /products/{id}/image',
    status: 404,
    when: 'a product without image',
    request: () => ({ url: `/products/${TEE}/image` }),
  },

  // ---- carts ---------------------------------------------------------------------------------------
  { operation: 'POST /carts', status: 201, when: 'a customer', request: () => ({ url: '/carts', headers: alice }) },
  { operation: 'POST /carts', status: 401, when: 'no credentials', request: () => ({ url: '/carts' }) },
  {
    operation: 'POST /carts',
    status: 403,
    when: 'a back-office key',
    request: () => ({ url: '/carts', headers: admin }),
  },
  {
    operation: 'POST /carts/{id}/items',
    status: 200,
    when: 'a product in stock',
    request: () => ({ url: `/carts/${state.cart}/items`, headers: alice, body: { productId: TEE, quantity: 2 } }),
  },
  {
    operation: 'POST /carts/{id}/items',
    status: 400,
    when: 'an invalid item',
    request: () => ({ url: `/carts/${state.cart}/items`, headers: alice, body: { productId: 'tee', quantity: 0 } }),
    check: listsEveryProblem,
  },
  {
    operation: 'POST /carts/{id}/items',
    status: 401,
    when: 'no credentials',
    request: () => ({ url: `/carts/${state.cart}/items`, body: { productId: TEE } }),
  },
  {
    operation: 'POST /carts/{id}/items',
    status: 403,
    when: 'a back-office key',
    request: () => ({ url: `/carts/${state.cart}/items`, headers: admin, body: { productId: TEE } }),
  },
  {
    operation: 'POST /carts/{id}/items',
    status: 404,
    when: 'the cart of another customer',
    request: () => ({ url: `/carts/${state.cart}/items`, headers: bob, body: { productId: TEE } }),
  },
  {
    operation: 'POST /carts/{id}/items',
    status: 409,
    when: 'more units than in stock',
    request: () => ({ url: `/carts/${state.cart}/items`, headers: alice, body: { productId: TEE, quantity: 50 } }),
  },
  {
    operation: 'POST /carts/{id}/items',
    status: 413,
    when: 'a body over the limit',
    request: () => ({ url: `/carts/${state.cart}/items`, headers: alice, body: { productId: TEE, ...OVERSIZED } }),
  },
  {
    operation: 'GET /carts/{id}',
    status: 200,
    when: 'the cart',
    request: () => ({ url: `/carts/${state.cart}`, headers: alice }),
  },
  {
    operation: 'GET /carts/{id}',
    status: 400,
    when: 'an invalid id',
    request: () => ({ url: '/carts/1', headers: alice }),
    check: listsEveryProblem,
  },
  {
    operation: 'GET /carts/{id}',
    status: 401,
    when: 'no credentials',
    request: () => ({ url: `/carts/${state.cart}` }),
  },
  {
    operation: 'GET /carts/{id}',
    status: 403,
    when: 'a back-office key',
    request: () => ({ url: `/carts/${state.cart}`, headers: admin }),
  },
  {
    operation: 'GET /carts/{id}',
    status: 404,
    when: 'the cart of another customer',
    request: () => ({ url: `/carts/${state.cart}`, headers: bob }),
  },

  // ---- orders --------------------------------------------------------------------------------------
  {
    operation: 'POST /orders',
    status: 201,
    when: 'a cart paid by card',
    request: () => ({
      url: '/orders',
      headers: alice,
      body: { cartId: state.cart, payment: { method: 'card', token: 'tok_visa_4242' } },
    }),
  },
  {
    operation: 'POST /orders',
    status: 400,
    when: 'an unknown payment method',
    request: () => ({ url: '/orders', headers: alice, body: { cartId: state.emptyCart, payment: { method: 'cash' } } }),
    check: listsEveryProblem,
  },
  {
    operation: 'POST /orders',
    status: 401,
    when: 'no credentials',
    request: () => ({ url: '/orders', body: { cartId: state.emptyCart, payment: { method: 'transfer' } } }),
  },
  {
    operation: 'POST /orders',
    status: 403,
    when: 'a back-office key',
    request: () => ({
      url: '/orders',
      headers: admin,
      body: { cartId: state.emptyCart, payment: { method: 'transfer' } },
    }),
  },
  {
    operation: 'POST /orders',
    status: 404,
    when: 'a cart that is closed once ordered',
    request: () => ({ url: '/orders', headers: alice, body: { cartId: state.cart, payment: { method: 'transfer' } } }),
  },
  {
    operation: 'POST /orders',
    status: 409,
    when: 'an empty cart',
    request: () => ({
      url: '/orders',
      headers: alice,
      body: { cartId: state.emptyCart, payment: { method: 'transfer' } },
    }),
  },
  {
    operation: 'POST /orders',
    status: 413,
    when: 'a body over the limit',
    request: () => ({
      url: '/orders',
      headers: alice,
      body: { cartId: state.emptyCart, payment: { method: 'transfer' }, ...OVERSIZED },
    }),
  },
  {
    operation: 'GET /orders/{id}',
    status: 200,
    when: 'an order',
    request: () => ({ url: `/orders/${state.order}`, headers: alice }),
  },
  {
    operation: 'GET /orders/{id}',
    status: 400,
    when: 'an invalid id',
    request: () => ({ url: '/orders/latest', headers: alice }),
    check: listsEveryProblem,
  },
  {
    operation: 'GET /orders/{id}',
    status: 401,
    when: 'no credentials',
    request: () => ({ url: `/orders/${state.order}` }),
  },
  {
    operation: 'GET /orders/{id}',
    status: 403,
    when: 'a back-office key',
    request: () => ({ url: `/orders/${state.order}`, headers: admin }),
  },
  {
    operation: 'GET /orders/{id}',
    status: 404,
    when: 'the order of another customer',
    request: () => ({ url: `/orders/${state.order}`, headers: bob }),
  },
  {
    operation: 'GET /orders/export',
    status: 200,
    when: 'every order, as NDJSON',
    request: () => ({ url: '/orders/export', headers: admin }),
    check: oneOrderPerLine,
  },
  {
    operation: 'GET /orders/export',
    status: 400,
    when: 'a date that is not one',
    request: () => ({ url: '/orders/export?since=yesterday', headers: admin }),
    check: namesTheParameter,
  },
  { operation: 'GET /orders/export', status: 401, when: 'no credentials', request: () => ({ url: '/orders/export' }) },
  {
    operation: 'GET /orders/export',
    status: 403,
    when: 'a customer token',
    request: () => ({ url: '/orders/export', headers: alice }),
  },

  // ---- back office -------------------------------------------------------------------------------
  {
    operation: 'GET /admin/stats',
    status: 200,
    when: 'the admin key',
    request: () => ({ url: '/admin/stats', headers: admin }),
  },
  { operation: 'GET /admin/stats', status: 401, when: 'no credentials', request: () => ({ url: '/admin/stats' }) },
  {
    operation: 'GET /admin/stats',
    status: 403,
    when: 'the catalogue key',
    request: () => ({ url: '/admin/stats', headers: catalog }),
  },
]

describe('the API answers what its documentation says', () => {
  let app: TestApp
  let document: OpenApiObject
  const covered = new Set<string>()

  beforeAll(async () => {
    app = await createTestApp()
    document = await app.get(OpenApi).document()
    const cart = await app.inject({ method: 'POST', url: '/carts', headers: alice })
    const emptyCart = await app.inject({ method: 'POST', url: '/carts', headers: alice })
    state.cart = cart.json<{ id: string }>().id
    state.emptyCart = emptyCart.json<{ id: string }>().id
  })

  afterAll(async () => {
    await app.close()
  })

  /** Remembers what a response gives the next cases. */
  function record(operation: Operation, response: InjectResponse): void {
    if (operation === 'POST /orders' && response.status === 201) state.order = response.json<{ id: string }>().id
    if (operation === 'GET /products/{id}/image' && response.status === 200) state.etag = String(response.headers.etag)
  }

  for (const { operation, status, when, request, check } of CASES) {
    it(`${operation} → ${status}: ${when}`, async () => {
      const [method, path] = operation.split(' ') as [string, string]
      const response = await app.inject({ method, ...request() })

      expect(`${response.status} ${response.body.slice(0, 300)}`).toStartWith(String(status))
      expect(validateResponse(document, { method, path, response })).toEqual([])
      check?.(response, document)
      record(operation, response)
      covered.add(`${operation} → ${status}`)
    })
  }

  it('covers every documented response', () => {
    const documented = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      (['get', 'put', 'post', 'delete', 'patch'] as const).flatMap(method =>
        Object.keys(item[method]?.responses ?? {}).map(status => `${method.toUpperCase()} ${path} → ${status}`),
      ),
    )

    expect([...covered].sort()).toEqual(documented.sort())
  })
})
