import type { ErrorReportEvent } from '@znight/core'
import type { InboundMessage } from '../src/index.ts'

import { createTestApp, handler, type TestApp } from './helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

let current: TestApp | undefined

afterEach(async () => {
  await current?.app.stop()
  current = undefined
})

class OrderConsumer {
  handle(payload: unknown): void {
    if (payload === 'ok') return
    throw new Error(`cannot handle ${String(payload)}`)
  }
  onError(error: unknown): unknown {
    return (error as Error).message === 'cannot handle tolerated' ? 'ack' : undefined
  }
}

async function setup(options: { readonly deadLetter?: false } = {}) {
  current = await createTestApp([
    {
      class: OrderConsumer,
      queue: 'orders',
      errorHandler: 'onError',
      ...(options.deadLetter === undefined ? {} : { options: { deadLetter: options.deadLetter } }),
      handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 0 } })],
    },
  ])
  const reports: ErrorReportEvent[] = []
  current.app.hooks.on('error:report', report => {
    reports.push(report)
  })
  return { ...current, reports }
}

describe('error:report hook (messaging)', () => {
  it('reports a delivery that failed every attempt once, when it is dead-lettered', async () => {
    const { broker, driver, reports } = await setup()
    const { id } = await broker.publish('orders', 'boom', { type: 'order.created' })
    await driver.idle()
    expect(driver.settlements('orders').map(s => s.action)).toEqual(['retry', 'retry', 'dead-letter'])
    expect(reports).toHaveLength(1)
    const report = reports[0] as ErrorReportEvent
    expect((report.error as Error).message).toBe('cannot handle boom')
    expect(report.source).toBe('messaging')
    expect(report.operation).toBe('orders order.created')
    expect(report.requestId).toBeUndefined()
    expect(report.tags).toEqual({
      queue: 'orders',
      type: 'order.created',
      messageId: id,
      consumer: 'OrderConsumer',
      handler: 'handle',
      attempt: 3,
      reason: 'max-attempts',
      deadLetterQueue: 'orders.dlq',
    })
    expect((report.context as InboundMessage).id).toBe(id)
  })

  it('reports a rejected delivery (no dead-letter queue) without a type', async () => {
    const { broker, driver, reports } = await setup({ deadLetter: false })
    await broker.publish('orders', 'boom')
    await driver.idle()
    expect(reports.map(report => [report.operation, report.tags['reason'], report.tags['deadLetterQueue']])).toEqual([
      ['orders', 'max-attempts', undefined],
    ])
  })

  it('does not report successful deliveries, intermediate attempts nor failures acknowledged by @OnError', async () => {
    const { broker, driver, reports } = await setup()
    await broker.publish('orders', 'ok')
    await broker.publish('orders', 'tolerated')
    await driver.idle()
    expect(driver.settlements('orders').map(s => s.action)).toEqual(['ack', 'retry', 'retry', 'ack'])
    expect(reports).toEqual([])
  })
})
