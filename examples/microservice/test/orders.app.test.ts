import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import type { Order } from '../src/orders/order.model.js'

import { SpanKind } from '@opentelemetry/api'
import { ConfigPlugin, inline } from '@znight/config'
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'
import { MessagingPlugin } from '@znight/messaging'
import { type MemoryDriver, memory } from '@znight/messaging/memory'
import { MetricsRegistry, ObservabilityPlugin } from '@znight/observability'
import { TestApp } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { startTracing, type Tracing } from '../src/observability/tracing.js'
import { ORDERS_CREATED_QUEUE } from '../src/orders/order.events.js'
import { TestPaymentMethods } from '../src/payments/payment.gateway.js'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

type LogEntry = Record<string, unknown> & { readonly msg: string }

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const CLIENT_SPAN_ID = '00f067aa0ba902b7'

/**
 * The whole service in memory: real plugins, real container, the in-memory broker (inspected by the
 * tests), captured logs, spans recorded by the tracer provider of `src/observability/tracing.ts`.
 * `app.inject()` sends HTTP requests without network.
 */
describe('orders service (TestApp)', () => {
  let app: TestApp
  let driver: MemoryDriver
  let tracing: Tracing
  let logs: LogEntry[]

  beforeEach(async () => {
    tracing = startTracing()
    driver = memory()
    logs = []
    app = await TestApp.create({
      metadata,
      plugins: [
        tracing.plugin,
        ObservabilityPlugin.configure({
          logging: { level: 'debug', destination: { write: line => logs.push(JSON.parse(line) as LogEntry) } },
          metrics: { defaultMetrics: false, server: false },
          tracing: { tracerProvider: tracing.provider },
        }),
        // hermetic configuration: neither .env files nor the environment of the test runner
        ConfigPlugin.configure({ loaders: [inline({})] }),
        MessagingPlugin.configure({ driver }),
        HttpPlugin.configure({ adapter: honoAdapter(), port: 0 }),
      ],
    })
  })

  afterEach(async () => {
    await app.close()
  })

  /** POST /orders, then waits until the event has been fully processed. */
  async function placeOrder(paymentMethod: string, headers: Record<string, string> = {}): Promise<Order> {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      headers,
      body: { customerId: 'customer-1', paymentMethod, lines: [{ sku: 'BOOK-42', quantity: 2, unitPrice: 1250 }] },
    })
    expect(response.status).toBe(201)
    const created = response.json<Order>()
    expect(response.headers['location']).toBe(`/orders/${created.id}`)
    await driver.idle() // nothing in flight, scheduled (retries) or deliverable
    const current = await app.inject({ url: `/orders/${created.id}` })
    expect(current.status).toBe(200)
    return current.json<Order>()
  }

  it('GET /health: ready once the consumers are subscribed', async () => {
    const response = await app.inject({ url: '/health' })

    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'ok',
      consumers: [{ queue: ORDERS_CREATED_QUEUE, state: 'running', inFlight: 0 }],
    })
  })

  it('a paid order is confirmed', async () => {
    const order = await placeOrder(TestPaymentMethods.visa)

    expect(order).toMatchObject({ status: 'confirmed', amount: 2500, currency: 'EUR' })
    expect(order.paymentId).toStartWith('pay_')
    expect(driver.settlements(ORDERS_CREATED_QUEUE).map(settlement => settlement.action)).toEqual(['ack'])
  })

  it('invalid requests answer 400 and publish nothing', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/orders',
      body: { customerId: '', paymentMethod: 'visa', lines: [{ sku: 'x', quantity: 0, unitPrice: 1 }] },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.json()).toMatchObject({
      message: 'Invalid body',
      details: expect.arrayContaining([
        expect.objectContaining({ path: 'customerId' }),
        expect.objectContaining({ path: 'paymentMethod' }),
        expect.objectContaining({ path: 'lines.0.quantity' }),
      ]),
    })
    expect((await app.inject({ url: '/orders/not-an-id' })).status).toBe(400)
    expect((await app.inject({ url: `/orders/${crypto.randomUUID()}` })).status).toBe(404)
    expect(driver.published(ORDERS_CREATED_QUEUE)).toHaveLength(0)
  })

  it('a declined payment rejects the order; the message is acknowledged (no retry, no dead letter)', async () => {
    const order = await placeOrder(TestPaymentMethods.declined)

    expect(order).toMatchObject({ status: 'rejected', reason: expect.stringContaining('declined') })
    expect(driver.settlements(ORDERS_CREATED_QUEUE).map(settlement => settlement.action)).toEqual(['ack'])
    expect(driver.deadLetters()).toHaveLength(0)
  })

  it('transient gateway failures are retried with an exponential backoff', async () => {
    const order = await placeOrder(TestPaymentMethods.flaky)

    expect(order.status).toBe('confirmed')
    const settlements = driver.settlements(ORDERS_CREATED_QUEUE)
    expect(settlements.map(settlement => [settlement.attempt, settlement.action])).toEqual([
      [1, 'retry'],
      [2, 'retry'],
      [3, 'ack'],
    ])
  })

  it('once every attempt failed, the order fails and the message is dead-lettered', async () => {
    const order = await placeOrder(TestPaymentMethods.unavailable)

    expect(order).toMatchObject({ status: 'failed', reason: 'Payment gateway unavailable (503)' })
    expect(driver.deadLetters(ORDERS_CREATED_QUEUE)).toEqual([
      expect.objectContaining({ queue: 'orders.created.dlq', reason: 'max-attempts', attempt: 4 }),
    ])
    // the copy waiting in the dead-letter queue says why, for the operator who will redrive it
    const [copy] = driver.pending('orders.created.dlq')
    expect(copy?.payload).toMatchObject({ orderId: order.id })
    expect(copy?.headers).toMatchObject({
      'x-znight-dead-letter-reason': 'max-attempts',
      'x-znight-error': 'Payment gateway unavailable (503)',
      'x-znight-original-queue': ORDERS_CREATED_QUEUE,
      'x-znight-attempts': '4',
    })
  }, 10_000)

  it('an invalid payload is dead-lettered at once, without retry', async () => {
    // as another producer could send it
    driver.send(ORDERS_CREATED_QUEUE, { type: 'order.created', payload: { orderId: 'not-a-uuid', amount: -1 } })
    await driver.idle()

    expect(driver.settlements(ORDERS_CREATED_QUEUE)).toHaveLength(1)
    expect(driver.deadLetters(ORDERS_CREATED_QUEUE)).toEqual([
      expect.objectContaining({ reason: 'validation', attempt: 1 }),
    ])
  })

  it('the trace of POST /orders continues in the consumer (W3C traceparent in the message headers)', async () => {
    const order = await placeOrder(TestPaymentMethods.visa, { traceparent: `00-${TRACE_ID}-${CLIENT_SPAN_ID}-01` })

    // the producer span wrote its context into the message headers
    const [message] = driver.published(ORDERS_CREATED_QUEUE)
    expect(message?.headers['traceparent']).toStartWith(`00-${TRACE_ID}-`)

    // one trace: client → SERVER POST /orders → PRODUCER send → CONSUMER process → payment.charge
    const spans = tracing.spans.trace(TRACE_ID)
    const span = (kind: SpanKind, name: string): ReadableSpan => {
      const found = spans.find(candidate => candidate.kind === kind && candidate.name === name)
      if (found === undefined) throw new Error(`No ${name} span in ${spans.map(each => each.name).join(', ')}`)
      return found
    }
    const server = span(SpanKind.SERVER, 'POST /orders')
    const producer = span(SpanKind.PRODUCER, 'send orders.created')
    const consumer = span(SpanKind.CONSUMER, 'process orders.created')
    const charge = span(SpanKind.CLIENT, 'payment.charge')
    expect(server.parentSpanContext?.spanId).toBe(CLIENT_SPAN_ID)
    expect(producer.parentSpanContext?.spanId).toBe(server.spanContext().spanId)
    expect(consumer.parentSpanContext?.spanId).toBe(producer.spanContext().spanId)
    expect(charge.parentSpanContext?.spanId).toBe(consumer.spanContext().spanId)
    expect(consumer.attributes['messaging.message.id']).toBe(order.id)

    // and every log line of the flow carries the trace id
    const created = logs.find(entry => entry.msg === 'Order created')
    const confirmed = logs.find(entry => entry.msg === 'Order confirmed')
    expect(created).toMatchObject({ traceId: TRACE_ID, orderId: order.id })
    expect(confirmed).toMatchObject({ traceId: TRACE_ID, spanId: consumer.spanContext().spanId })
  })

  it('messaging and business metrics are recorded', async () => {
    await placeOrder(TestPaymentMethods.flaky)
    const exposition = await app.get(MetricsRegistry).metrics()

    expect(exposition).toMatch(
      /messaging_messages_processed_total\{queue="orders\.created",consumer="OrderCreatedConsumer",type="order\.created",outcome="retry"\} 2/,
    )
    expect(exposition).toMatch(/messaging_messages_processed_total\{[^}]*outcome="ack"\} 1/)
    expect(exposition).toMatch(/orders_created_total\{[^}]*outcome="success"\} 1/)
    expect(exposition).toMatch(/payment_charge_duration_seconds_count\{[^}]*outcome="error"\} 2/)
  })

  it('graceful shutdown runs the disposal hooks', async () => {
    await placeOrder(TestPaymentMethods.visa)

    await app.close()

    expect(logs.find(entry => entry.msg === 'Order store closed')).toMatchObject({ orders: 1 })
    expect(logs.some(entry => entry.msg === 'Tracing stopped')).toBe(true)
  })
})
