/**
 * Behaviour every broker driver must exhibit, run against real brokers (testcontainers).
 * Enabled with ZNIGHT_INTEGRATION=1.
 */
import type { InboundMessage, MessagingDriver } from '../../src/index.ts'

import { Application, type CoreLogger } from '@znight/core'
import { z } from 'zod'

import {
  MessageBroker,
  MessagingHeaders,
  MessagingPlugin,
  NonRetryableError,
  validateMessage,
} from '../../src/index.ts'
import { handler, memoryLogger, messagingMetadata, sleep, type TestConsumer } from '../helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

export const integration: boolean = process.env['ZNIGHT_INTEGRATION'] === '1'

/** Polls `predicate` until it holds. */
export async function waitFor(predicate: () => boolean, timeoutMs = 30_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`)
    await sleep(20)
  }
}

export interface ConformanceContext {
  /** A fresh, connected-on-bootstrap driver. */
  createDriver(overrides?: { maxInProcessDelayMs?: number }): MessagingDriver
  /** Creates the queue/topic and its dead-letter destination (drivers that do not declare topology). */
  prepareQueue(queue: string): Promise<void>
  /** Consumer options needed by the driver (e.g. Kafka group id). */
  consumerOptions?(queue: string): Record<string, unknown>
  /** Shortest delay the native retry mechanism honours precisely (SQS: whole seconds). */
  readonly nativeDelayMs: number
}

interface Received {
  readonly payload: unknown
  readonly message: InboundMessage
}

let apps: Application[] = []

export async function startApp(
  driver: MessagingDriver,
  consumers: readonly TestConsumer[],
  logger: CoreLogger = memoryLogger(),
): Promise<Application> {
  const app = await Application.create({
    metadata: messagingMetadata(consumers),
    plugins: [MessagingPlugin.configure({ driver, defaults: { requeueDelay: 50 } })],
    logger,
    shutdown: { signals: false, hookTimeoutMs: 20_000, timeoutMs: 30_000 },
  })
  apps.push(app)
  await app.start()
  return app
}

let counter = 0
function uniqueQueue(prefix: string): string {
  counter++
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

/** Registers the conformance tests of a driver. */
export function driverConformance(
  name: string,
  context: () => ConformanceContext,
  features: { readonly delayedPublish: boolean },
): void {
  afterEach(async () => {
    const running = apps
    apps = []
    for (const app of running.reverse()) await app.stop()
  })

  /** A consumer collecting the messages of the dead-letter queue of `queue`. */
  function deadLetterCollector(driver: MessagingDriver, queue: string, sink: Received[]): TestConsumer {
    class DeadLetterCollector {
      collect(payload: unknown, message: InboundMessage) {
        sink.push({ payload, message })
      }
    }
    return {
      class: DeadLetterCollector,
      queue: driver.deadLetterName(queue),
      options: { deadLetter: false, ...context().consumerOptions?.(driver.deadLetterName(queue)) },
      handlers: [handler('collect', { retry: { attempts: 1, backoff: 'fixed', delay: 0 } })],
    }
  }

  async function prepare(
    prefix: string,
  ): Promise<{ queue: string; driver: MessagingDriver; options: Record<string, unknown> }> {
    const ctx = context()
    const queue = uniqueQueue(`${name}-${prefix}`)
    const driver = ctx.createDriver()
    await ctx.prepareQueue(queue)
    return { queue, driver, options: ctx.consumerOptions?.(queue) ?? {} }
  }

  describe(`${name} driver conformance`, () => {
    it('publishes and consumes with type routing, headers and confirmations', async () => {
      const { queue, driver, options } = await prepare('basic')
      const created: Received[] = []
      const others: Received[] = []
      class OrderConsumer {
        created(payload: unknown, message: InboundMessage) {
          created.push({ payload, message })
        }
        other(payload: unknown, message: InboundMessage) {
          others.push({ payload, message })
        }
      }
      const app = await startApp(driver, [
        {
          class: OrderConsumer,
          queue,
          options,
          handlers: [handler('created', { type: 'order.created' }), handler('other')],
        },
      ])
      const broker = app.get(MessageBroker)
      const { id } = await broker.publish(
        queue,
        { id: 1, items: ['a', 'b'] },
        { type: 'order.created', headers: { 'x-tenant': 'acme' }, key: 'k1' },
      )
      await broker.publish(queue, 'plain', { type: 'order.cancelled' })
      await waitFor(() => created.length === 1 && others.length === 1, 30_000, 'both messages')
      const [first] = created
      expect(first?.payload).toEqual({ id: 1, items: ['a', 'b'] })
      expect(first?.message).toMatchObject({ id, queue, type: 'order.created', attempt: 1, driver: driver.name })
      expect(first?.message.headers['x-tenant']).toBe('acme')
      expect(first?.message.contentType).toStartWith('application/json')
      expect(others[0]?.payload).toBe('plain')
      expect(others[0]?.message.type).toBe('order.cancelled')
    })

    it('retries in-process, then natively, with increasing attempts', async () => {
      const ctx = context()
      const queue = uniqueQueue(`${name}-retry`)
      await ctx.prepareQueue(queue)
      // budget below the second delay: first retry in-process, second one native
      const driver = ctx.createDriver({ maxInProcessDelayMs: ctx.nativeDelayMs - 1 })
      const attempts: number[] = []
      class FlakyConsumer {
        handle(_payload: unknown, message: InboundMessage) {
          attempts.push(message.attempt)
          if (message.attempt < 3) throw new Error(`transient ${message.attempt}`)
        }
      }
      const app = await startApp(driver, [
        {
          class: FlakyConsumer,
          queue,
          options: ctx.consumerOptions?.(queue) ?? {},
          handlers: [
            handler('handle', { retry: { attempts: 3, backoff: 'exponential', delay: ctx.nativeDelayMs / 2 } }),
          ],
        },
      ])
      const started = Date.now()
      await app.get(MessageBroker).publish(queue, { n: 1 })
      await waitFor(() => attempts.length === 3, 60_000, 'three attempts')
      expect(attempts).toEqual([1, 2, 3])
      expect(Date.now() - started).toBeGreaterThanOrEqual(ctx.nativeDelayMs * 1.5 - 100)
    })

    it('dead-letters after the last attempt and immediately for non-retryable errors', async () => {
      const { queue, driver, options } = await prepare('dlq')
      const dead: Received[] = []
      const attempts: number[] = []
      const Payload = z.object({ id: z.number() })
      class FailingConsumer {
        handle(payload: z.output<typeof Payload>, message: InboundMessage) {
          attempts.push(message.attempt)
          if (payload.id === 1) throw new Error('always failing')
          throw new NonRetryableError('permanent')
        }
      }
      const app = await startApp(driver, [
        {
          class: FailingConsumer,
          queue,
          options,
          handlers: [
            {
              method: 'handle',
              retry: { attempts: 2, backoff: 'fixed', delay: 10 },
              invoke: async (c: FailingConsumer, m) => c.handle(await validateMessage(Payload, m.payload), m),
            },
          ],
        },
        deadLetterCollector(driver, queue, dead),
      ])
      const broker = app.get(MessageBroker)
      await broker.publish(queue, { id: 1 }, { type: 'a', headers: { keep: 'me' } })
      await waitFor(() => dead.length === 1, 60_000, 'first dead letter')
      await broker.publish(queue, { id: 2 })
      await waitFor(() => dead.length === 2, 60_000, 'second dead letter')
      await broker.publish(queue, { id: 'invalid' })
      await waitFor(() => dead.length === 3, 60_000, 'third dead letter')
      expect(attempts).toEqual([1, 2, 1])
      expect(dead.map(entry => entry.payload)).toEqual([{ id: 1 }, { id: 2 }, { id: 'invalid' }])
      expect(dead.map(entry => entry.message.headers[MessagingHeaders.DeadLetterReason])).toEqual([
        'max-attempts',
        'non-retryable',
        'validation',
      ])
      expect(dead[0]?.message.headers).toMatchObject({
        keep: 'me',
        [MessagingHeaders.Error]: 'always failing',
        [MessagingHeaders.OriginalQueue]: queue,
        [MessagingHeaders.Attempts]: '2',
      })
      expect(dead[0]?.message.type).toBe('a')
      expect(dead[0]?.message.attempt).toBe(1)
    })

    it('handles messages concurrently up to the consumer concurrency', async () => {
      const { queue, driver, options } = await prepare('concurrency')
      let active = 0
      let max = 0
      let done = 0
      class SlowConsumer {
        async handle() {
          active++
          max = Math.max(max, active)
          await sleep(150)
          active--
          done++
        }
      }
      const app = await startApp(driver, [
        { class: SlowConsumer, queue, options: { ...options, concurrency: 3 }, handlers: [handler('handle')] },
      ])
      const broker = app.get(MessageBroker)
      for (let index = 0; index < 6; index++) await broker.publish(queue, index, { key: `k${index}` })
      await waitFor(() => done === 6, 60_000, 'six messages')
      expect(max).toBeGreaterThan(1)
      expect(max).toBeLessThanOrEqual(3)
    })

    it('gives pending in-process retries back to the broker on stop', async () => {
      const { queue, driver, options } = await prepare('stop')
      const firstRun: number[] = []
      class FailingConsumer {
        handle(_payload: unknown, message: InboundMessage) {
          firstRun.push(message.attempt)
          throw new Error('fail')
        }
      }
      const app = await startApp(driver, [
        {
          class: FailingConsumer,
          queue,
          options,
          handlers: [handler('handle', { retry: { attempts: 5, backoff: 'fixed', delay: 900 } })],
        },
      ])
      await app.get(MessageBroker).publish(queue, { keep: true })
      await waitFor(() => firstRun.length === 1, 30_000, 'first attempt')
      await sleep(50)
      await app.stop()
      apps = apps.filter(other => other !== app)

      const received: Received[] = []
      class HealthyConsumer {
        handle(payload: unknown, message: InboundMessage) {
          received.push({ payload, message })
        }
      }
      await startApp(context().createDriver(), [
        { class: HealthyConsumer, queue, options, handlers: [handler('handle')] },
      ])
      await waitFor(() => received.length === 1, 60_000, 'redelivery after restart')
      expect(received[0]?.payload).toEqual({ keep: true })
    })

    it.skipIf(!features.delayedPublish)('delays publications', async () => {
      const { queue, driver, options } = await prepare('delay')
      const received: number[] = []
      class Consumer {
        handle() {
          received.push(Date.now())
        }
      }
      const app = await startApp(driver, [{ class: Consumer, queue, options, handlers: [handler('handle')] }])
      const started = Date.now()
      await app.get(MessageBroker).publish(queue, 1, { delay: 1000 })
      await waitFor(() => received.length === 1, 30_000, 'delayed message')
      expect((received[0] ?? 0) - started).toBeGreaterThanOrEqual(900)
    })

    it.skipIf(features.delayedPublish)('rejects delayed publications', async () => {
      const { queue, driver, options } = await prepare('delay')
      class Consumer {
        handle() {}
      }
      const app = await startApp(driver, [{ class: Consumer, queue, options, handlers: [handler('handle')] }])
      await expect(app.get(MessageBroker).publish(queue, 1, { delay: 1000 })).rejects.toThrow(
        'does not support delayed publishing',
      )
    })
  })
}
