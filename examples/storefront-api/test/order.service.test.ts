import type { Cart } from '../src/carts/cart.js'
import type { Order } from '../src/orders/order.js'

import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { CartService } from '../src/carts/cart.service.js'
import { CatalogService } from '../src/catalog/catalog.service.js'
import { OrderRepository } from '../src/orders/order.repository.js'
import { OrderService, SHOP_IBAN } from '../src/orders/order.service.js'
import { ConflictError } from '../src/shared/errors.js'
import { aProduct, MUG, TEE } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

const CART_ID = '7f0c1d2e-3b4a-4c5d-8e6f-0a1b2c3d4e5f'

function aCart(items: [string, number][] = [[MUG, 2]]): Cart {
  const now = new Date('2026-01-01T00:00:00Z')
  return { id: CART_ID, customerId: 'alice', items: new Map(items), createdAt: now, updatedAt: now }
}

/**
 * `OrderService` with its collaborators auto-mocked, except the repository: a real (in-memory)
 * `OrderRepository` is provided, so that what `place()` stores can be read back.
 */
async function setup() {
  const orders = new OrderRepository()
  const { instance, mocks } = await TestBed.create(OrderService, { metadata, provide: [[OrderRepository, orders]] })
  const catalog = mocks.get(CatalogService)
  catalog.reserve.mockImplementation(lines =>
    lines.map(line => aProduct({ id: line.productId, sku: line.productId === MUG ? 'MUG-ZNIGHT' : 'TEE-DI-BLACK' })),
  )
  return { service: instance, orders, carts: mocks.get(CartService), catalog, logger: mocks.get(Logger) }
}

describe('OrderService', () => {
  it('places an order paid by card: stock reserved, payment captured, cart closed', async () => {
    const { service, carts, catalog } = await setup()
    const cart = aCart([
      [MUG, 2],
      [TEE, 1],
    ])
    carts.get.mockReturnValue(cart)

    const order = service.place('alice', { cartId: CART_ID, payment: { method: 'card', token: 'tok_visa_4242' } })

    expect(catalog.reserve).toHaveBeenCalledWith([
      { productId: MUG, quantity: 2 },
      { productId: TEE, quantity: 1 },
    ])
    expect(order).toMatchObject({
      customerId: 'alice',
      status: 'paid',
      totalCents: 3 * 1490,
      currency: 'EUR',
      payment: { method: 'card', last4: '4242' },
    })
    expect(order.lines).toHaveLength(2)
    // only the last four digits of the card token are kept
    expect(JSON.stringify(order)).not.toContain('tok_visa')
    expect(carts.close).toHaveBeenCalledWith(cart)
    expect(service.get('alice', order.id)).toBe(order)
  })

  it('places an order paid by transfer: a reference, the IBAN and a due date', async () => {
    const { service, carts } = await setup()
    carts.get.mockReturnValue(aCart())

    const order = service.place('alice', { cartId: CART_ID, payment: { method: 'transfer' } })

    expect(order.status).toBe('awaiting-transfer')
    if (order.payment.method !== 'transfer') throw new Error('expected a transfer')
    // the discriminated union narrows `payment`: only transfers have a reference
    expect(order.payment.reference).toMatch(/^SF-[A-HJ-NP-Z2-9]{6}$/)
    expect(order.payment.iban).toBe(SHOP_IBAN)
    expect(order.payment.dueBy.getTime() - order.createdAt.getTime()).toBe(7 * 86_400_000)
  })

  it('refuses an empty cart (409) and reserves nothing', async () => {
    const { service, carts, catalog } = await setup()
    carts.get.mockReturnValue(aCart([]))

    expect(() => service.place('alice', { cartId: CART_ID, payment: { method: 'transfer' } })).toThrow(ConflictError)
    expect(catalog.reserve).not.toHaveBeenCalled()
    expect(carts.close).not.toHaveBeenCalled()
  })

  it('hides the orders of other customers (404, not 403)', async () => {
    const { service, carts } = await setup()
    carts.get.mockReturnValue(aCart())
    const order = service.place('alice', { cartId: CART_ID, payment: { method: 'transfer' } })

    expect(() => service.get('bob', order.id)).toThrow(`No order ${order.id}`)
  })

  it('exports the orders a page at a time, oldest first', async () => {
    const { service, orders, carts } = await setup()
    carts.get.mockReturnValue(aCart())
    const placed = Array.from({ length: 5 }, () =>
      service.place('alice', { cartId: CART_ID, payment: { method: 'transfer' } }),
    )
    const pages: unknown[] = []
    const page = orders.page.bind(orders)
    orders.page = query => {
      pages.push(query)
      return page(query)
    }

    const exported: Order[] = []
    for await (const order of service.export(undefined, 2)) exported.push(order)

    expect(exported.map(order => order.id)).toEqual(placed.map(order => order.id))
    // keyset pagination: each page starts after the last order of the previous one
    expect(pages).toEqual([
      { since: undefined, after: undefined, limit: 2 },
      { since: undefined, after: placed[1]?.id, limit: 2 },
      { since: undefined, after: placed[3]?.id, limit: 2 },
    ])
  })

  it('exports the orders placed since a date', async () => {
    const { service, carts } = await setup()
    carts.get.mockReturnValue(aCart())
    service.place('alice', { cartId: CART_ID, payment: { method: 'transfer' } })

    const future = new Date(Date.now() + 60_000)
    const exported: Order[] = []
    for await (const order of service.export(future)) exported.push(order)

    expect(exported).toEqual([])
  })

  it('counts the orders and the revenue of the paid ones', async () => {
    const { service, carts } = await setup()
    carts.get.mockReturnValue(aCart())
    service.place('alice', { cartId: CART_ID, payment: { method: 'card', token: 'tok_visa_4242' } })
    service.place('alice', { cartId: CART_ID, payment: { method: 'transfer' } })

    expect(service.stats()).toEqual({
      orders: 2,
      revenueCents: 2 * 1490,
      byStatus: { paid: 1, 'awaiting-transfer': 1 },
    })
  })
})
