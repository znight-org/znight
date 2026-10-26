import type { Order } from '../src/orders/order.model.js'
import type { CreateOrder } from '../src/orders/order.schemas.js'

import { MessageBroker } from '@znight/messaging'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { ORDER_CREATED, ORDERS_CREATED_QUEUE } from '../src/orders/order.events.js'
import { OrderRepository } from '../src/orders/order.repository.js'
import { OrderService } from '../src/orders/order.service.js'
import { describe, expect, test as it } from 'bun:test'

const input: CreateOrder = {
  customerId: 'customer-1',
  currency: 'EUR',
  paymentMethod: 'pm_card_visa',
  lines: [
    { sku: 'BOOK-42', quantity: 2, unitPrice: 1250 },
    { sku: 'PEN-7', quantity: 3, unitPrice: 199 },
  ],
}

const pending: Order = {
  id: '6fd276a6-ece0-4519-8ac5-b566af199c00',
  customerId: 'customer-1',
  currency: 'EUR',
  paymentMethod: 'pm_card_visa',
  lines: [{ sku: 'BOOK-42', quantity: 1, unitPrice: 1000 }],
  amount: 1000,
  status: 'pending',
  createdAt: '2026-10-26T10:00:00.000Z',
  updatedAt: '2026-10-26T10:00:00.000Z',
}

// TestBed builds OrderService with its generated factory and auto-mocks its direct dependencies:
// OrderRepository (an abstract class, bound to InMemoryOrderRepository), MessageBroker and Logger
describe('OrderService', () => {
  it('create() stores a pending order, then publishes OrderCreated', async () => {
    const { instance, mocks } = await TestBed.create(OrderService, { metadata })

    const order = await instance.create(input)

    expect(order).toMatchObject({ customerId: 'customer-1', status: 'pending', amount: 2 * 1250 + 3 * 199 })
    expect(mocks.get(OrderRepository).insert).toHaveBeenCalledWith(order)
    expect(mocks.get(MessageBroker).publish).toHaveBeenCalledWith(
      ORDERS_CREATED_QUEUE,
      {
        orderId: order.id,
        customerId: 'customer-1',
        amount: 3097,
        currency: 'EUR',
        paymentMethod: 'pm_card_visa',
        createdAt: order.createdAt,
      },
      // the order id is the message id: consumers can deduplicate redeliveries
      { type: ORDER_CREATED, id: order.id, key: 'customer-1' },
    )
  })

  it('create() does not publish when the order cannot be stored', async () => {
    const { instance, mocks } = await TestBed.create(OrderService, { metadata })
    mocks.get(OrderRepository).insert.mockRejectedValue(new Error('database down'))

    await expect(instance.create(input)).rejects.toThrow('database down')
    expect(mocks.get(MessageBroker).publish).not.toHaveBeenCalled()
  })

  it('transitions only change pending orders (replays are no-ops)', async () => {
    // overrides build the real InMemoryOrderRepository (its own Logger dependency is auto-mocked)
    const { instance } = await TestBed.create(OrderService, {
      metadata,
      overrides: [[OrderRepository, metadata.providers['src/orders/order.repository.ts#InMemoryOrderRepository']]],
    })

    const created = await instance.create(input)
    expect((await instance.confirm(created.id, 'pay_1'))?.status).toBe('confirmed')
    // a redelivered message cannot change a confirmed order
    expect(await instance.reject(created.id, 'declined')).toMatchObject({ status: 'confirmed', paymentId: 'pay_1' })
    expect(await instance.fail('unknown', 'boom')).toBeUndefined()
  })

  it('findById() reads the repository', async () => {
    const { instance, mocks } = await TestBed.create(OrderService, { metadata })
    mocks.get(OrderRepository).findById.mockResolvedValue(pending)

    expect(await instance.findById(pending.id)).toEqual(pending)
  })
})
