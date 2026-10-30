import type { CartResponse } from '../src/carts/cart.js'
import type { ProductResponse, ProductSummary } from '../src/catalog/product.js'
import type { Order } from '../src/orders/order.js'
import type { Page } from '../src/shared/page.js'

import { createTestApp } from './support/app.js'
import { admin, alice, bob, catalog, imageForm, MUG, newProduct, PNG_BYTES, pngFile, TEE } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

/** JSON as it travels: dates are ISO strings. */
type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends object ? Wire<T[K]> : T[K] }

/**
 * HTTP-level tests: the whole application in memory (`app.inject()`), as `main.ts` wires it. Each
 * test boots its own application, so the stock and the orders of one never leak into another.
 */
describe('Storefront API', () => {
  describe('catalogue', () => {
    it('lists the products, filtered, sorted and paginated from the query string', async () => {
      await using app = await createTestApp()
      const skus = async (query: string): Promise<string[]> =>
        (await app.inject({ url: `/products${query}` })).json<Page<ProductSummary>>().items.map(product => product.sku)

      expect(await skus('')).toEqual(['BOOK-AST', 'TEE-DI-BLACK', 'MUG-ZNIGHT']) // by name
      expect(await skus('?sort=price-asc')).toEqual(['MUG-ZNIGHT', 'TEE-DI-BLACK', 'BOOK-AST'])
      // a repeated parameter is an array: every tag must match
      expect(await skus('?tag=gift&tag=MUG')).toEqual(['MUG-ZNIGHT'])
      // `inStock=true` is coerced to a boolean, `category` checked against the Category literals
      expect(await skus('?inStock=true&sort=price-desc')).toEqual(['TEE-DI-BLACK', 'MUG-ZNIGHT'])
      expect(await skus('?category=books')).toEqual(['BOOK-AST'])
      expect(await skus('?q=STONEWARE')).toEqual(['MUG-ZNIGHT'])

      const page = (await app.inject({ url: '/products?limit=1&offset=1' })).json<Page<ProductSummary>>()
      expect(page).toMatchObject({ total: 3, limit: 1, offset: 1, items: [{ sku: 'TEE-DI-BLACK' }] })
    })

    it('answers 400 for query values of the wrong type', async () => {
      await using app = await createTestApp()

      const sort = await app.inject({ url: '/products?sort=cheap' })
      expect(sort.status).toBe(400)
      expect(sort.json()).toMatchObject({ message: expect.stringContaining('Invalid query "sort"') })
      expect((await app.inject({ url: '/products?limit=ten' })).status).toBe(400)
      // TypeScript has no integer type: the range of `limit` is checked by the handler
      expect((await app.inject({ url: '/products?limit=1.5' })).status).toBe(400)
      expect((await app.inject({ url: '/products?category=food' })).status).toBe(400)
    })

    it('adds a product from the input of the Zod schema, and stores its output', async () => {
      await using app = await createTestApp()

      const created = await app.inject({
        method: 'POST',
        url: '/products',
        headers: catalog,
        body: newProduct({ sku: ' stick-01 ', price: '4.5', tags: [' Sticker ', 'GIFT'] }),
      })

      expect(created.status).toBe(201)
      const product = created.json<Wire<ProductResponse>>()
      expect(product).toMatchObject({ sku: 'STICK-01', priceCents: 450, tags: ['sticker', 'gift'], imageUrl: null })
      expect(created.headers.location).toBe(`/products/${product.id}`)
      expect((await app.inject({ url: `/products/${product.id}` })).json()).toEqual(product)
    })

    it('checks a product without adding it: the answer is the schema output', async () => {
      await using app = await createTestApp()

      const checked = await app.inject({
        method: 'POST',
        url: '/products/validate',
        headers: catalog,
        body: { sku: 'pen-1', name: ' Pen ', category: 'home', price: '2' },
      })

      expect(checked.status).toBe(200)
      // defaults applied, values normalised, the price in cents
      expect(checked.json()).toEqual({
        sku: 'PEN-1',
        name: 'Pen',
        description: null,
        category: 'home',
        price: 200,
        stock: 0,
        tags: [],
      })
      expect((await app.inject({ url: '/products' })).json<Page<ProductSummary>>().total).toBe(3)
    })

    it('lists every problem of an invalid body', async () => {
      await using app = await createTestApp()

      const invalid = await app.inject({
        method: 'POST',
        url: '/products',
        headers: catalog,
        body: { sku: '!', price: 14.9, category: 'food' },
      })

      expect(invalid.status).toBe(400)
      expect(
        invalid
          .json<{ details: { path: string }[] }>()
          .details.map(issue => issue.path)
          .sort(),
      ).toEqual(['category', 'name', 'price', 'sku'])
    })
  })

  describe('images', () => {
    it('stores an upload and serves it publicly, with caching validators and ranges', async () => {
      await using app = await createTestApp()

      // declared as a JPEG: the content decides, it is a PNG
      const upload = await app.inject({
        method: 'PUT',
        url: `/products/${MUG}/image`,
        headers: catalog,
        body: imageForm(pngFile('mug.jpg', 'image/jpeg')),
      })
      expect(upload.status).toBe(200)
      expect(upload.json()).toMatchObject({ imageUrl: `/products/${MUG}/image` })

      const image = await app.inject({ url: `/products/${MUG}/image` })
      expect(image.status).toBe(200)
      expect(image.headers['content-type']).toBe('image/png')
      expect(image.headers['content-disposition']).toBe(`inline; filename="product-${MUG}.png"`)
      // the route's cache-control wins over the API-wide `no-store`
      expect(image.headers['cache-control']).toBe('public, max-age=300')
      expect(image.bytes).toEqual(PNG_BYTES)

      const etag = String(image.headers.etag)
      expect((await app.inject({ url: `/products/${MUG}/image`, headers: { 'if-none-match': etag } })).status).toBe(304)
      const range = await app.inject({ url: `/products/${MUG}/image`, headers: { range: 'bytes=0-3' } })
      expect(range.status).toBe(206)
      expect(range.bytes).toEqual(PNG_BYTES.slice(0, 4))
    })

    it('refuses what is not an image: by declared type while it arrives, then by content', async () => {
      await using app = await createTestApp()
      const upload = (file: File) =>
        app.inject({ method: 'PUT', url: `/products/${MUG}/image`, headers: catalog, body: imageForm(file) })

      expect((await upload(new File(['hello'], 'mug.txt', { type: 'text/plain' }))).status).toBe(415)
      expect((await upload(new File(['<svg/>'], 'mug.png', { type: 'image/png' }))).status).toBe(415)
      expect((await app.inject({ url: `/products/${MUG}/image` })).status).toBe(404) // nothing was stored
    })
  })

  describe('carts and orders', () => {
    it('orders a cart paid by card: the stock goes down and the cart is closed', async () => {
      await using app = await createTestApp()

      const cart = (await app.inject({ method: 'POST', url: '/carts', headers: alice })).json<CartResponse>()
      await app.inject({ method: 'POST', url: `/carts/${cart.id}/items`, headers: alice, body: { productId: MUG } })
      const filled = await app.inject({
        method: 'POST',
        url: `/carts/${cart.id}/items`,
        headers: alice,
        body: { productId: MUG, quantity: 2 },
      })
      // one line per product; `quantity` defaults to 1 (Valibot `v.optional(..., 1)`)
      expect(filled.json()).toMatchObject({
        lines: [{ productId: MUG, quantity: 3, totalCents: 4470 }],
        totalCents: 4470,
      })

      const placed = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: alice,
        body: { cartId: cart.id, payment: { method: 'card', token: 'tok_visa_4242' } },
      })

      expect(placed.status).toBe(201)
      const order = placed.json<Wire<Order>>()
      expect(order).toMatchObject({
        customerId: 'alice',
        status: 'paid',
        totalCents: 4470,
        payment: { method: 'card', last4: '4242' },
      })
      expect(placed.headers.location).toBe(`/orders/${order.id}`)
      expect((await app.inject({ url: `/products/${MUG}` })).json()).toMatchObject({ stock: 39 })
      expect((await app.inject({ url: `/carts/${cart.id}`, headers: alice })).status).toBe(404)
      expect((await app.inject({ url: `/orders/${order.id}`, headers: alice })).json()).toEqual(order)
    })

    it('orders a cart paid by transfer: the order waits for it', async () => {
      await using app = await createTestApp()
      const cart = (await app.inject({ method: 'POST', url: '/carts', headers: bob })).json<CartResponse>()
      await app.inject({ method: 'POST', url: `/carts/${cart.id}/items`, headers: bob, body: { productId: TEE } })

      const placed = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: bob,
        body: { cartId: cart.id, payment: { method: 'transfer' } },
      })

      expect(placed.json()).toMatchObject({
        status: 'awaiting-transfer',
        payment: { method: 'transfer', reference: expect.stringMatching(/^SF-/), iban: expect.any(String) },
      })
    })

    it('rejects a payment that does not match its method (discriminated union)', async () => {
      await using app = await createTestApp()
      const cart = (await app.inject({ method: 'POST', url: '/carts', headers: alice })).json<CartResponse>()

      const order = (payment: unknown) =>
        app.inject({ method: 'POST', url: '/orders', headers: alice, body: { cartId: cart.id, payment } })

      // the `method` key selects the option: a card needs a token, an unknown method is one error
      expect((await order({ method: 'card' })).json()).toMatchObject({ details: [{ path: 'payment.token' }] })
      expect((await order({ method: 'cash' })).json()).toMatchObject({ details: [{ path: 'payment.method' }] })
    })

    it('takes nothing from the stock when a line cannot be served', async () => {
      await using app = await createTestApp()
      const fill = async (quantity: number): Promise<string> => {
        const cart = (await app.inject({ method: 'POST', url: '/carts', headers: alice })).json<CartResponse>()
        const items = [
          { productId: MUG, quantity: 1 },
          { productId: TEE, quantity },
        ]
        for (const body of items)
          await app.inject({ method: 'POST', url: `/carts/${cart.id}/items`, headers: alice, body })
        return cart.id
      }
      const first = await fill(5)
      const second = await fill(5) // only 7 TEE in stock: both carts fit, both orders do not

      const card = { method: 'card', token: 'tok_visa_4242' }
      const placed = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: alice,
        body: { cartId: first, payment: card },
      })
      expect(placed.status).toBe(201)
      const conflict = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: alice,
        body: { cartId: second, payment: card },
      })

      expect(conflict.status).toBe(409)
      expect(conflict.json()).toMatchObject({ details: { productId: TEE, available: 2, requested: 5 } })
      // all or nothing: the MUG line of the second cart was not taken either
      expect((await app.inject({ url: `/products/${MUG}` })).json()).toMatchObject({ stock: 41 })
      expect((await app.inject({ url: `/products/${TEE}` })).json()).toMatchObject({ stock: 2 })
    })

    it('keeps the carts and orders of a customer to that customer', async () => {
      await using app = await createTestApp()
      const cart = (await app.inject({ method: 'POST', url: '/carts', headers: alice })).json<CartResponse>()

      // reported as missing, not forbidden: ids cannot be probed
      expect((await app.inject({ url: `/carts/${cart.id}`, headers: bob })).status).toBe(404)
      const stolen = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: bob,
        body: { cartId: cart.id, payment: { method: 'transfer' } },
      })
      expect(stolen.status).toBe(404)
    })
  })

  describe('back office', () => {
    it('exports the orders as newline-delimited JSON, streamed', async () => {
      await using app = await createTestApp()
      const order = async (customer: typeof alice | typeof bob): Promise<string> => {
        const cart = (await app.inject({ method: 'POST', url: '/carts', headers: customer })).json<CartResponse>()
        await app.inject({
          method: 'POST',
          url: `/carts/${cart.id}/items`,
          headers: customer,
          body: { productId: MUG },
        })
        const body = { cartId: cart.id, payment: { method: 'transfer' } }
        return (await app.inject({ method: 'POST', url: '/orders', headers: customer, body })).json<Order>().id
      }
      const ids = [await order(alice), await order(bob)]

      // `injectStream()` resolves at the headers: the body is read as the server produces it
      const stream = await app.injectStream({ method: 'GET', url: '/orders/export', headers: admin })
      expect(stream.status).toBe(200)
      expect(stream.headers['content-type']).toBe('application/x-ndjson')
      expect(stream.headers['content-disposition']).toBe('attachment; filename="orders.ndjson"')
      const lines = (await new Response(stream.body).text()).split('\n')
      expect(lines.pop()).toBe('') // every line ends with \n
      expect(lines.map(line => JSON.parse(line).id)).toEqual(ids)

      const later = await app.inject({
        url: `/orders/export?since=${new Date(Date.now() + 60_000).toISOString()}`,
        headers: admin,
      })
      expect(later.body).toBe('')
    })

    it('reports the figures of the shop', async () => {
      await using app = await createTestApp()
      const cart = (await app.inject({ method: 'POST', url: '/carts', headers: alice })).json<CartResponse>()
      await app.inject({
        method: 'POST',
        url: `/carts/${cart.id}/items`,
        headers: alice,
        body: { productId: TEE, quantity: 2 },
      })
      const card = { method: 'card', token: 'tok_visa_4242' }
      await app.inject({ method: 'POST', url: '/orders', headers: alice, body: { cartId: cart.id, payment: card } })

      const stats = await app.inject({ url: '/admin/stats', headers: admin })

      expect(stats.json()).toMatchObject({
        products: 3,
        outOfStock: 1,
        orders: 1,
        ordersByStatus: { paid: 1, 'awaiting-transfer': 0 },
        revenueCents: 4800,
      })
    })
  })

  describe('authentication', () => {
    it('challenges the callers with the scheme the route expects', async () => {
      await using app = await createTestApp()

      const cart = await app.inject({ method: 'POST', url: '/carts' })
      expect(cart.status).toBe(401)
      expect(cart.headers['www-authenticate']).toBe('Bearer realm="storefront"')
      expect(cart.json()).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Missing credentials' })

      const stats = await app.inject({ url: '/admin/stats' })
      expect(stats.headers['www-authenticate']).toBe('ApiKey header="x-api-key"')
      const invalid = await app.inject({ url: '/admin/stats', headers: { authorization: 'Bearer nope' } })
      expect(invalid.headers['www-authenticate']).toBe('Bearer realm="storefront", error="invalid_token"')
    })

    it('answers 403 to valid credentials without the role', async () => {
      await using app = await createTestApp()

      expect((await app.inject({ url: '/admin/stats', headers: catalog })).status).toBe(403)
      expect((await app.inject({ url: '/orders/export', headers: alice })).status).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/carts', headers: admin })).status).toBe(403)
    })

    it('serves the health check without credentials, and undocumented', async () => {
      await using app = await createTestApp()

      const health = await app.inject({ url: '/health' })

      expect(health.status).toBe(200)
      expect(health.json()).toMatchObject({ status: 'ok' })
      expect(health.headers['cache-control']).toBe('no-store')
      expect(health.headers['x-content-type-options']).toBe('nosniff')
    })
  })
})
