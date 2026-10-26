import type { MessageDeliveryEvent } from '@znight/core'
import type { InboundMessage } from '../src/index.ts'

import { z } from 'zod'

import {
  MessageDecodeError,
  MessageValidationError,
  MessagingHeaders,
  NoHandlerError,
  NonRetryableError,
  validateMessage,
} from '../src/index.ts'
import { causeOf, createTestApp, handler, messageOf, type TestApp } from './helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

let current: TestApp | undefined

afterEach(async () => {
  await current?.app.stop()
  current = undefined
})

async function setup(...args: Parameters<typeof createTestApp>): Promise<TestApp> {
  current = await createTestApp(...args)
  return current
}

describe('successful deliveries', () => {
  it('acknowledges the message after the handler resolved', async () => {
    const seen: unknown[] = []
    class OrderConsumer {
      async handle(payload: unknown) {
        await Promise.resolve()
        seen.push(payload)
      }
    }
    const { broker, driver } = await setup([{ class: OrderConsumer, queue: 'orders', handlers: [handler('handle')] }])
    await broker.publish('orders', { id: 1, items: ['a'] })
    await driver.idle()
    expect(seen).toEqual([{ id: 1, items: ['a'] }])
    expect(driver.settlements('orders')).toMatchObject([{ action: 'ack', attempt: 1 }])
  })

  it('exposes the delivery as an InboundMessage', async () => {
    let received: InboundMessage | undefined
    class OrderConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        received = message
      }
    }
    const { broker, driver } = await setup([{ class: OrderConsumer, queue: 'orders', handlers: [handler('handle')] }])
    const before = Date.now()
    const { id } = await broker.publish(
      'orders',
      { id: 1 },
      { type: 'order.created', headers: { 'x-tenant': 'acme' }, key: 'customer-1' },
    )
    await driver.idle()
    expect(received).toMatchObject({
      id,
      queue: 'orders',
      type: 'order.created',
      payload: { id: 1 },
      headers: { 'x-tenant': 'acme' },
      key: 'customer-1',
      attempt: 1,
      maxAttempts: 3,
      redelivered: false,
      contentType: 'application/json',
      body: '{"id":1}',
      driver: 'memory',
    })
    expect(received?.timestamp).toBeGreaterThanOrEqual(before)
    expect(received?.receivedAt).toBeGreaterThanOrEqual(before)
    expect(received?.signal.aborted).toBe(false)
  })

  it('handles synchronous handlers and handlers returning values', async () => {
    class SyncConsumer {
      handle() {
        return 42
      }
    }
    const { broker, driver } = await setup([{ class: SyncConsumer, queue: 'sync', handlers: [handler('handle')] }])
    await broker.publish('sync', 'text')
    await driver.idle()
    expect(driver.settlements('sync')).toMatchObject([{ action: 'ack' }])
  })
})

describe('handler selection by type', () => {
  class EventConsumer {
    readonly calls: string[] = []
    created(payload: unknown) {
      this.calls.push(`created:${JSON.stringify(payload)}`)
    }
    anyOrder() {
      this.calls.push('order.*')
    }
    fallback() {
      this.calls.push('default')
    }
  }

  it('prefers exact types, then patterns, then the default handler', async () => {
    const { app, broker, driver } = await setup([
      {
        class: EventConsumer,
        queue: 'events',
        handlers: [
          handler('anyOrder', { type: 'order.*' }),
          handler('created', { type: 'order.created' }),
          handler('fallback'),
        ],
      },
    ])
    await broker.publish('events', 1, { type: 'order.created' })
    await driver.idle()
    await broker.publish('events', 2, { type: 'order.cancelled' })
    await driver.idle()
    await broker.publish('events', 3, { type: 'user.created' })
    await driver.idle()
    await broker.publish('events', 4)
    await driver.idle()
    expect(app.get(EventConsumer).calls).toEqual(['created:1', 'order.*', 'default', 'default'])
  })

  it('dead-letters messages no handler matches', async () => {
    const { app, broker, driver } = await setup([
      { class: EventConsumer, queue: 'events', handlers: [handler('created', { type: 'order.created' })] },
    ])
    await broker.publish('events', 1, { type: 'user.created' })
    await broker.publish('events', 2)
    await driver.idle()
    expect(app.get(EventConsumer).calls).toEqual([])
    const deadLetters = driver.deadLetters('events')
    expect(deadLetters.map(entry => entry.reason)).toEqual(['no-handler', 'no-handler'])
    expect(deadLetters[0]?.error).toBeInstanceOf(NoHandlerError)
    expect(messageOf(deadLetters[0]?.error)).toContain('no @OnMessage handler for message type "user.created"')
    expect(messageOf(deadLetters[1]?.error)).toContain('no default @OnMessage() handler')
    const dlq = driver.pending('events.dlq')
    expect(dlq).toHaveLength(2)
    expect(dlq[0]?.headers).toMatchObject({
      [MessagingHeaders.DeadLetterReason]: 'no-handler',
      [MessagingHeaders.OriginalQueue]: 'events',
      [MessagingHeaders.Attempts]: '1',
    })
    expect(dlq[0]?.payload).toBe(1)
    expect(dlq[0]?.type).toBe('user.created')
  })
})

describe('retries', () => {
  function flaky(failures: number, attempts: number[]) {
    return class FlakyConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        if (attempts.length <= failures) throw new Error(`failure ${attempts.length}`)
      }
    }
  }

  it('retries with a fixed in-process delay, then acknowledges', async () => {
    const attempts: number[] = []
    const { broker, driver } = await setup([
      {
        class: flaky(2, attempts),
        queue: 'jobs',
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 5 } })],
      },
    ])
    const started = performance.now()
    await broker.publish('jobs', {})
    await driver.idle()
    expect(attempts).toEqual([1, 2, 3])
    expect(performance.now() - started).toBeGreaterThanOrEqual(9)
    // in-process delays: the redelivery is requested without native delay once the wait is over
    expect(driver.settlements('jobs')).toMatchObject([
      { action: 'retry', attempt: 1, delayMs: 0 },
      { action: 'retry', attempt: 2, delayMs: 0 },
      { action: 'ack', attempt: 3 },
    ])
  })

  it('delegates delays beyond the in-process budget to the driver (exponential backoff)', async () => {
    const attempts: number[] = []
    const { broker, driver } = await setup(
      [
        {
          class: flaky(3, attempts),
          queue: 'jobs',
          handlers: [handler('handle', { retry: { attempts: 4, backoff: 'exponential', delay: 4, maxDelay: 10 } })],
        },
      ],
      { driverOptions: { maxInProcessDelayMs: 0 } },
    )
    await broker.publish('jobs', {})
    await driver.idle()
    expect(attempts).toEqual([1, 2, 3, 4])
    expect(driver.settlements('jobs').map(s => [s.action, s.delayMs])).toEqual([
      ['retry', 4],
      ['retry', 8],
      ['retry', 10],
      ['ack', undefined],
    ])
  })

  it('dead-letters after the last attempt', async () => {
    const attempts: number[] = []
    const { broker, driver, logs } = await setup([
      {
        class: flaky(10, attempts),
        queue: 'jobs',
        handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 1 } })],
      },
    ])
    await broker.publish('jobs', { n: 1 }, { type: 'job' })
    await driver.idle()
    expect(attempts).toEqual([1, 2])
    const [entry] = driver.deadLetters('jobs')
    expect(entry).toMatchObject({ queue: 'jobs.dlq', reason: 'max-attempts', attempt: 2 })
    expect(messageOf(entry?.error)).toBe('failure 2')
    const [dead] = driver.pending('jobs.dlq')
    expect(dead?.payload).toEqual({ n: 1 })
    expect(dead?.headers[MessagingHeaders.Error]).toBe('failure 2')
    expect(dead?.headers[MessagingHeaders.Attempt]).toBeUndefined()
    expect(logs.some(log => log.level === 'warn' && log.message.includes('attempt 1/2'))).toBe(true)
    expect(
      logs.some(log => log.level === 'error' && log.message.includes('dead-lettered to jobs.dlq (max-attempts)')),
    ).toBe(true)
  })

  it('logs the failure with its stack once when a messaging:message wrapper logs the deliveries', async () => {
    const failures = (logs: readonly { message: string; context?: Record<string, unknown> | undefined }[]) =>
      logs
        .filter(log => log.message.includes('attempt 1/2') || log.message.includes('dead-lettered to'))
        .map(log => ({ err: log.context?.['err'], error: log.context?.['error'] }))
    const consumer = (attempts: number[]) => ({
      class: flaky(10, attempts),
      queue: 'jobs',
      handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 1 } })],
    })

    // without wrapper, the runtime entries carry the error (stack included)
    const plain = await setup([consumer([])])
    await plain.broker.publish('jobs', { n: 1 })
    await plain.driver.idle()
    expect(failures(plain.logs).map(entry => messageOf(entry.err))).toEqual(['failure 1', 'failure 2'])
    await plain.app.stop()

    // with a wrapper (the ObservabilityPlugin delivery log writes the error), only its message
    const wrapped = await setup([consumer([])], { start: false })
    const events: MessageDeliveryEvent[] = []
    wrapped.app.hooks.wrap('messaging:message', async (event, next) => {
      await next()
      events.push(event)
    })
    await wrapped.app.start()
    await wrapped.broker.publish('jobs', { n: 1 })
    await wrapped.driver.idle()
    expect(failures(wrapped.logs)).toEqual([
      { err: undefined, error: 'failure 1' },
      { err: undefined, error: 'failure 2' },
    ])
    expect(events.map(event => [event.outcome, messageOf(event.error)])).toEqual([
      ['retry', 'failure 1'],
      ['dead-letter', 'failure 2'],
    ])
  })

  it('applies the plugin default policy to handlers without @Retry', async () => {
    const attempts: number[] = []
    const { broker, driver } = await setup(
      [{ class: flaky(10, attempts), queue: 'jobs', handlers: [handler('handle')] }],
      {
        plugin: { defaults: { retry: { attempts: 4, backoff: 'fixed', delay: 0 }, requeueDelay: 0 } },
      },
    )
    await broker.publish('jobs', {})
    await driver.idle()
    expect(attempts).toEqual([1, 2, 3, 4])
    expect(driver.deadLetters('jobs')).toHaveLength(1)
  })

  it('does not retry when defaults.retry is false', async () => {
    const attempts: number[] = []
    const { broker, driver } = await setup(
      [{ class: flaky(10, attempts), queue: 'jobs', handlers: [handler('handle')] }],
      {
        plugin: { defaults: { retry: false } },
      },
    )
    await broker.publish('jobs', {})
    await driver.idle()
    expect(attempts).toEqual([1])
    expect(driver.deadLetters('jobs')[0]?.reason).toBe('max-attempts')
  })

  it('dead-letters a NonRetryableError immediately', async () => {
    let calls = 0
    class StrictConsumer {
      handle() {
        calls++
        throw new NonRetryableError('bad order')
      }
    }
    const { broker, driver } = await setup([
      {
        class: StrictConsumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 5, backoff: 'fixed', delay: 1 } })],
      },
    ])
    await broker.publish('orders', {})
    await driver.idle()
    expect(calls).toBe(1)
    expect(driver.deadLetters('orders')).toMatchObject([{ reason: 'non-retryable', attempt: 1 }])
  })

  it('recognises non-retryable errors from another copy of the package', async () => {
    class ForeignError extends Error {}
    Object.defineProperty(ForeignError.prototype, Symbol.for('znight.messaging.nonRetryable'), { value: true })
    class StrictConsumer {
      handle() {
        throw new ForeignError('foreign')
      }
    }
    const { broker, driver } = await setup([{ class: StrictConsumer, queue: 'orders', handlers: [handler('handle')] }])
    await broker.publish('orders', {})
    await driver.idle()
    expect(driver.deadLetters('orders')).toMatchObject([{ reason: 'non-retryable', attempt: 1 }])
  })

  it('dead-letters redeliveries beyond the last attempt without calling the handler', async () => {
    let calls = 0
    class Consumer {
      handle() {
        calls++
      }
    }
    const { driver } = await setup([
      {
        class: Consumer,
        queue: 'jobs',
        handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 1 } })],
      },
    ])
    driver.send('jobs', { payload: {}, deliveries: 2 })
    await driver.idle()
    expect(calls).toBe(0)
    expect(driver.deadLetters('jobs')).toMatchObject([{ reason: 'max-attempts', attempt: 3 }])
  })
})

describe('payload validation and decoding', () => {
  const OrderCreated = z.object({
    id: z.number(),
    currency: z.string().default('EUR'),
    placedAt: z.string().transform(value => new Date(value)),
  })

  it('passes the schema output to the handler', async () => {
    const received: unknown[] = []
    class OrderConsumer {
      handle(order: z.output<typeof OrderCreated>) {
        received.push(order)
      }
    }
    const { broker, driver } = await setup([
      {
        class: OrderConsumer,
        queue: 'orders',
        handlers: [
          {
            method: 'handle',
            invoke: async (c: OrderConsumer, m) => c.handle(await validateMessage(OrderCreated, m.payload)),
          },
        ],
      },
    ])
    await broker.publish('orders', { id: 1, placedAt: '2026-01-01T00:00:00.000Z' })
    await driver.idle()
    expect(received).toEqual([{ id: 1, currency: 'EUR', placedAt: new Date('2026-01-01T00:00:00.000Z') }])
  })

  it('dead-letters invalid payloads without retrying', async () => {
    let calls = 0
    class OrderConsumer {
      handle() {
        calls++
      }
    }
    const { broker, driver } = await setup([
      {
        class: OrderConsumer,
        queue: 'orders',
        handlers: [
          {
            method: 'handle',
            retry: { attempts: 5, backoff: 'fixed', delay: 1 },
            invoke: async (c: OrderConsumer, m) => {
              await validateMessage(OrderCreated, m.payload)
              return c.handle()
            },
          },
        ],
      },
    ])
    await broker.publish('orders', { id: 'nope' })
    await driver.idle()
    expect(calls).toBe(0)
    const [entry] = driver.deadLetters('orders')
    expect(entry?.reason).toBe('validation')
    expect(entry?.attempt).toBe(1)
    const error = entry?.error as MessageValidationError
    expect(error).toBeInstanceOf(MessageValidationError)
    expect(error.issues.map(issue => issue.path).sort()).toEqual(['id', 'placedAt'])
    expect(driver.pending('orders.dlq')[0]?.headers[MessagingHeaders.Error]).toContain('Invalid message payload')
  })

  it('dead-letters malformed bodies (reason decode)', async () => {
    let calls = 0
    class Consumer {
      handle() {
        calls++
      }
    }
    const { driver } = await setup([{ class: Consumer, queue: 'raw', handlers: [handler('handle')] }])
    driver.send('raw', { body: '{not json', contentType: 'application/json' })
    await driver.idle()
    expect(calls).toBe(0)
    const [entry] = driver.deadLetters('raw')
    expect(entry?.reason).toBe('decode')
    expect(entry?.error).toBeInstanceOf(MessageDecodeError)
  })

  it('wraps codec failures in MessageDecodeError', async () => {
    class Consumer {
      handle() {}
    }
    const { driver } = await setup([{ class: Consumer, queue: 'raw', handlers: [handler('handle')] }], {
      plugin: {
        codec: {
          encode: payload => ({ body: String(payload), contentType: 'text/plain' }),
          decode: () => {
            throw new RangeError('boom')
          },
        },
      },
    })
    driver.send('raw', { body: 'x', contentType: 'text/plain' })
    await driver.idle()
    const [entry] = driver.deadLetters('raw')
    expect(entry?.reason).toBe('decode')
    expect(messageOf(entry?.error)).toBe('Cannot decode the message body: boom')
    expect(causeOf(entry?.error)).toBeInstanceOf(RangeError)
  })
})

describe('@OnError', () => {
  function errorConsumer(result: () => unknown, calls: unknown[][]) {
    return class ErrorConsumer {
      handle(payload: unknown) {
        if (payload === 'bad') throw new NonRetryableError('bad payload')
        throw new Error('transient')
      }
      onError(error: unknown, message: InboundMessage) {
        calls.push([(error as Error).message, message.attempt])
        return result()
      }
    }
  }

  it('acknowledges the message when it returns "ack"', async () => {
    const calls: unknown[][] = []
    const events: MessageDeliveryEvent[] = []
    const { app, broker, driver } = await setup([
      {
        class: errorConsumer(() => 'ack', calls),
        queue: 'q',
        errorHandler: 'onError',
        handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 1 } })],
      },
    ])
    app.hooks.wrap('messaging:message', async (event, next) => {
      await next()
      events.push(event)
    })
    await broker.publish('q', 'transient')
    await driver.idle()
    // not called for the intermediate attempt
    expect(calls).toEqual([['transient', 2]])
    expect(driver.settlements('q').map(s => s.action)).toEqual(['retry', 'ack'])
    expect(driver.deadLetters('q')).toEqual([])
    expect(events.map(event => event.outcome)).toEqual(['retry', 'ack'])
    expect(messageOf(events[1]?.error)).toBe('transient')
  })

  it('dead-letters when it returns anything else', async () => {
    const calls: unknown[][] = []
    const { broker, driver } = await setup([
      {
        class: errorConsumer(() => undefined, calls),
        queue: 'q',
        errorHandler: 'onError',
        handlers: [handler('handle')],
      },
    ])
    await broker.publish('q', 'bad')
    await driver.idle()
    expect(calls).toEqual([['bad payload', 1]])
    expect(driver.deadLetters('q')).toMatchObject([{ reason: 'non-retryable' }])
  })

  it('dead-letters (and logs) when it throws', async () => {
    const calls: unknown[][] = []
    const { broker, driver, logs } = await setup([
      {
        class: errorConsumer(() => {
          throw new Error('handler of handlers failed')
        }, calls),
        queue: 'q',
        errorHandler: 'onError',
        handlers: [handler('handle')],
      },
    ])
    await broker.publish('q', 'bad')
    await driver.idle()
    expect(driver.deadLetters('q')).toMatchObject([{ reason: 'non-retryable' }])
    expect(messageOf(driver.deadLetters('q')[0]?.error)).toBe('bad payload')
    expect(logs.some(log => log.message.includes('@OnError onError() failed'))).toBe(true)
  })

  it('supports async error handlers and runs for messages without handler', async () => {
    const seen: unknown[] = []
    class Consumer {
      handle() {}
      async onError(error: unknown) {
        await Promise.resolve()
        seen.push(error)
        return 'ack'
      }
    }
    const { broker, driver } = await setup([
      { class: Consumer, queue: 'q', errorHandler: 'onError', handlers: [handler('handle', { type: 'known' })] },
    ])
    await broker.publish('q', 1, { type: 'unknown' })
    await driver.idle()
    expect(seen[0]).toBeInstanceOf(NoHandlerError)
    expect(driver.settlements('q').map(s => s.action)).toEqual(['ack'])
  })
})

describe('dead-letter settings', () => {
  class FailingConsumer {
    handle() {
      throw new NonRetryableError('nope')
    }
  }

  it('releases the message when the dead-letter publication fails', async () => {
    const { broker, driver, logs } = await setup([
      { class: FailingConsumer, queue: 'q', handlers: [handler('handle')] },
    ])
    driver.fail('publish', { queue: 'q.dlq', times: 1 })
    await broker.publish('q', {})
    await driver.idle()
    expect(driver.settlements('q').map(s => s.action)).toEqual(['release', 'dead-letter'])
    expect(driver.settlements('q').map(s => s.attempt)).toEqual([1, 2])
    expect(driver.pending('q.dlq')).toHaveLength(1)
    expect(logs.some(log => log.message.includes('failed to dead-letter message'))).toBe(true)
  })

  it('rejects messages when dead-lettering is disabled for the consumer', async () => {
    const { broker, driver } = await setup([
      { class: FailingConsumer, queue: 'q', options: { deadLetter: false }, handlers: [handler('handle')] },
    ])
    await broker.publish('q', {})
    await driver.idle()
    expect(driver.settlements('q').map(s => s.action)).toEqual(['reject'])
    expect(driver.deadLetters('q')).toMatchObject([{ queue: undefined, reason: 'non-retryable' }])
    expect(driver.pending('q.dlq')).toEqual([])
  })

  it('uses the consumer dead-letter queue, then the plugin naming', async () => {
    class OtherConsumer extends FailingConsumer {}
    const { broker, driver } = await setup(
      [
        { class: FailingConsumer, queue: 'a', options: { deadLetter: 'graveyard' }, handlers: [handler('handle')] },
        { class: OtherConsumer, queue: 'b', handlers: [handler('handle')] },
      ],
      { plugin: { defaults: { deadLetter: queue => `dead-${queue}` } } },
    )
    await broker.publish('a', 1)
    await broker.publish('b', 2)
    await driver.idle()
    expect(driver.pending('graveyard').map(m => m.payload)).toEqual([1])
    expect(driver.pending('dead-b').map(m => m.payload)).toEqual([2])
    expect(current?.plugin.consumers().map(c => c.deadLetterQueue)).toEqual(['graveyard', 'dead-b'])
  })

  it('disables dead-lettering globally with defaults.deadLetter = false', async () => {
    const { broker, driver } = await setup([{ class: FailingConsumer, queue: 'q', handlers: [handler('handle')] }], {
      plugin: { defaults: { deadLetter: false } },
    })
    await broker.publish('q', {})
    await driver.idle()
    expect(driver.settlements('q').map(s => s.action)).toEqual(['reject'])
  })

  it('releases the message when scheduling a native retry fails', async () => {
    let calls = 0
    class Consumer {
      handle() {
        calls++
        if (calls === 1) throw new Error('transient')
      }
    }
    const { broker, driver } = await setup(
      [
        {
          class: Consumer,
          queue: 'q',
          handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 5 } })],
        },
      ],
      { driverOptions: { maxInProcessDelayMs: 0 } },
    )
    driver.fail('retry', { times: 1 })
    await broker.publish('q', {})
    await driver.idle()
    expect(driver.settlements('q').map(s => s.action)).toEqual(['release', 'ack'])
    expect(calls).toBe(2)
  })

  it('logs acknowledgement failures (the broker redelivers)', async () => {
    let calls = 0
    class Consumer {
      handle() {
        calls++
      }
    }
    const { broker, driver, logs } = await setup([{ class: Consumer, queue: 'q', handlers: [handler('handle')] }])
    driver.fail('ack', { times: 1 })
    await broker.publish('q', {})
    await driver.idle()
    // the memory broker gives unsettled messages back, like a real broker on connection loss
    expect(calls).toBe(2)
    expect(driver.settlements('q').map(s => s.action)).toEqual(['release', 'ack'])
    expect(logs.some(log => log.level === 'warn' && log.message.includes('failed to acknowledge'))).toBe(true)
  })
})
