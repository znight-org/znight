import { isNonRetryable } from '@znight/messaging'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import {
  type ChargeRequest,
  PaymentDeclinedError,
  PaymentGateway,
  PaymentGatewayUnavailableError,
  TestPaymentMethods,
} from '../src/payments/payment.gateway.js'
import { describe, expect, test as it } from 'bun:test'

const request = (paymentMethod: string, idempotencyKey = 'order-1'): ChargeRequest => ({
  idempotencyKey,
  amount: 2500,
  currency: 'EUR',
  paymentMethod,
})

describe('PaymentGateway (simulated)', () => {
  it('captures a payment', async () => {
    const { instance } = await TestBed.create(PaymentGateway, { metadata })

    const payment = await instance.charge(request(TestPaymentMethods.visa))

    expect(payment).toMatchObject({ amount: 2500, currency: 'EUR' })
    expect(payment.id).toStartWith('pay_')
  })

  it('is idempotent: the same key never charges twice', async () => {
    const { instance } = await TestBed.create(PaymentGateway, { metadata })

    const first = await instance.charge(request(TestPaymentMethods.visa))
    const replay = await instance.charge(request(TestPaymentMethods.visa))

    expect(replay).toEqual(first)
  })

  it('a declined payment is a NonRetryableError', async () => {
    const { instance } = await TestBed.create(PaymentGateway, { metadata })

    const error = await instance.charge(request(TestPaymentMethods.declined)).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(PaymentDeclinedError)
    expect(isNonRetryable(error)).toBe(true)
  })

  it('the flaky method fails twice (retryable), then captures', async () => {
    const { instance } = await TestBed.create(PaymentGateway, { metadata })
    const flaky = request(TestPaymentMethods.flaky)

    await expect(instance.charge(flaky)).rejects.toBeInstanceOf(PaymentGatewayUnavailableError)
    await expect(instance.charge(flaky)).rejects.toBeInstanceOf(PaymentGatewayUnavailableError)
    expect(await instance.charge(flaky)).toMatchObject({ amount: 2500 })
  })
})
