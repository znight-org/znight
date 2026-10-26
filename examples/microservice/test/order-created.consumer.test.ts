import type { InboundMessage } from '@znight/messaging'
import type { Order } from '../src/orders/order.model.js'
import type { OrderCreatedEvent } from '../src/orders/order.schemas.js'

import { isNonRetryable } from '@znight/messaging'
import { createMock, TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { OrderService } from '../src/orders/order.service.js'
import { OrderCreatedConsumer } from '../src/orders/order-created.consumer.js'
import {
  PaymentDeclinedError,
  PaymentGateway,
  PaymentGatewayUnavailableError,
} from '../src/payments/payment.gateway.js'
import { describe, expect, test as it } from 'bun:test'

const order: Order = {
  id: '6fd276a6-ece0-4519-8ac5-b566af199c00',
  customerId: 'customer-1',
  currency: 'EUR',
  paymentMethod: 'pm_card_visa',
  lines: [{ sku: 'BOOK-42', quantity: 2, unitPrice: 1250 }],
  amount: 2500,
  status: 'pending',
  createdAt: '2026-10-26T10:00:00.000Z',
  updatedAt: '2026-10-26T10:00:00.000Z',
}

const event: OrderCreatedEvent = {
  orderId: order.id,
  customerId: order.customerId,
  amount: order.amount,
  currency: order.currency,
  paymentMethod: order.paymentMethod,
  createdAt: order.createdAt,
}

/** The delivery of `payload` (only the members the consumer reads matter). */
function delivery(payload: unknown, attempt = 1): InboundMessage {
  return createMock<InboundMessage>({ id: order.id, payload, attempt })
}

// Handlers are plain methods: unit tests call them directly. The validation of the payload, the
// retries and the dead-lettering are the job of the runtime (see orders.app.test.ts).
describe('OrderCreatedConsumer', () => {
  it('charges a pending order and confirms it', async () => {
    const { instance, mocks } = await TestBed.create(OrderCreatedConsumer, { metadata })
    mocks.get(OrderService).findById.mockResolvedValue(order)
    mocks.get(PaymentGateway).charge.mockResolvedValue({ id: 'pay_1', amount: 2500, currency: 'EUR' })

    await instance.charge(event, delivery(event))

    expect(mocks.get(PaymentGateway).charge).toHaveBeenCalledWith({
      idempotencyKey: order.id,
      amount: 2500,
      currency: 'EUR',
      paymentMethod: 'pm_card_visa',
    })
    expect(mocks.get(OrderService).confirm).toHaveBeenCalledWith(order.id, 'pay_1')
  })

  it('ignores a duplicate delivery of an order already processed (idempotency)', async () => {
    const { instance, mocks } = await TestBed.create(OrderCreatedConsumer, { metadata })
    mocks.get(OrderService).findById.mockResolvedValue({ ...order, status: 'confirmed' })

    await instance.charge(event, delivery(event, 2))

    expect(mocks.get(PaymentGateway).charge).not.toHaveBeenCalled()
  })

  it('an unknown order is a non-retryable failure', async () => {
    const { instance, mocks } = await TestBed.create(OrderCreatedConsumer, { metadata })
    mocks.get(OrderService).findById.mockResolvedValue(undefined)

    const error = await instance.charge(event, delivery(event)).catch((thrown: unknown) => thrown)

    expect(isNonRetryable(error)).toBe(true)
  })

  it('gateway errors propagate: the runtime retries them', async () => {
    const { instance, mocks } = await TestBed.create(OrderCreatedConsumer, { metadata })
    mocks.get(OrderService).findById.mockResolvedValue(order)
    mocks.get(PaymentGateway).charge.mockRejectedValue(new PaymentGatewayUnavailableError('503'))

    const error = await instance.charge(event, delivery(event)).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(PaymentGatewayUnavailableError)
    expect(isNonRetryable(error)).toBe(false)
    expect(mocks.get(OrderService).confirm).not.toHaveBeenCalled()
  })

  describe('onError()', () => {
    it('a declined payment rejects the order and acknowledges the message', async () => {
      const { instance, mocks } = await TestBed.create(OrderCreatedConsumer, { metadata })

      const result = await instance.onError(new PaymentDeclinedError('insufficient funds'), delivery(event))

      expect(result).toBe('ack')
      expect(mocks.get(OrderService).reject).toHaveBeenCalledWith(order.id, 'insufficient funds')
    })

    it('any other terminal failure fails the order and dead-letters the message', async () => {
      const { instance, mocks } = await TestBed.create(OrderCreatedConsumer, { metadata })

      const result = await instance.onError(new PaymentGatewayUnavailableError('503'), delivery(event, 4))

      expect(result).toBeUndefined()
      expect(mocks.get(OrderService).fail).toHaveBeenCalledWith(order.id, '503')
    })

    it('an invalid payload without order id is dead-lettered as is', async () => {
      const { instance, mocks } = await TestBed.create(OrderCreatedConsumer, { metadata })

      const result = await instance.onError(new Error('Invalid message'), delivery({ unexpected: true }))

      expect(result).toBeUndefined()
      expect(mocks.get(OrderService).fail).not.toHaveBeenCalled()
    })
  })
})
