import type { DriverDelivery, MessagingDriver } from '@znight/messaging'
import type { ConformanceTestApi, DriverConformanceOptions } from '@znight/messaging/testing'

import { AssertionError } from 'node:assert'
import { memory } from '@znight/messaging/memory'
import { describeDriverConformance } from '@znight/messaging/testing'

import { caught } from '../helpers.ts'
import { LocalBroker, localDriver } from './local-driver.ts'
import { describe, expect, it } from 'bun:test'

/** The scenarios a conformance run registers, by full name, without running them. */
function scenarios(options: Omit<DriverConformanceOptions, 'test'>): Map<string, () => Promise<void>> {
  const registered = new Map<string, () => Promise<void>>()
  const path: string[] = []
  const test: ConformanceTestApi = {
    describe(name, body) {
      path.push(name)
      body()
      path.pop()
    },
    it(name, body) {
      registered.set([...path, name].join(' > '), body)
    },
  }
  describeDriverConformance({ ...options, test })
  return registered
}

/** A driver delegating to `inner` that confirms publications without storing them. */
function droppingPublications(inner: MessagingDriver): MessagingDriver {
  return {
    name: 'mute',
    capabilities: inner.capabilities,
    connect: context => inner.connect(context),
    subscribe: (queue, handler, options) => inner.subscribe(queue, handler, options),
    publish: () => Promise.resolve(),
    close: () => inner.close(),
    deadLetterName: queue => inner.deadLetterName(queue),
  }
}

/** A driver delegating to `inner` that loses the headers of published messages. */
function droppingHeaders(inner: MessagingDriver): MessagingDriver {
  return {
    name: 'leaky',
    capabilities: inner.capabilities,
    connect: context => inner.connect(context),
    subscribe: (queue, handler, options) => inner.subscribe(queue, handler, options),
    publish: (queue, message) => inner.publish(queue, { ...message, headers: {} }),
    close: () => inner.close(),
    deadLetterName: queue => inner.deadLetterName(queue),
  }
}

/**
 * A driver delegating to `inner` whose deliveries settle through `settle` (the original delivery
 * for whatever it does not replace).
 */
function rewritingDeliveries(
  inner: MessagingDriver,
  settle: (delivery: DriverDelivery) => Partial<Pick<DriverDelivery, 'release' | 'retry'>>,
): MessagingDriver {
  return {
    name: 'rewriting',
    capabilities: inner.capabilities,
    connect: context => inner.connect(context),
    subscribe: (queue, handler, options) =>
      inner.subscribe(
        queue,
        delivery => {
          const replaced = settle(delivery)
          return handler({
            id: delivery.id,
            body: delivery.body,
            contentType: delivery.contentType,
            headers: delivery.headers,
            type: delivery.type,
            key: delivery.key,
            attempt: delivery.attempt,
            redelivered: delivery.redelivered,
            timestamp: delivery.timestamp,
            raw: delivery.raw,
            ack: () => delivery.ack(),
            retry: replaced.retry ?? (request => delivery.retry(request)),
            deadLetter: request => delivery.deadLetter(request),
            release: replaced.release ?? (() => delivery.release()),
          })
        },
        options,
      ),
    publish: (queue, message) => inner.publish(queue, message),
    close: () => inner.close(),
    deadLetterName: queue => inner.deadLetterName(queue),
  }
}

/** Runs the scenario whose name contains `fragment`, returning what it threw. */
function runScenario(options: Omit<DriverConformanceOptions, 'test'>, fragment: string): Promise<unknown> {
  const body = [...scenarios(options).entries()].find(([name]) => name.includes(fragment))?.[1]
  if (!body) return Promise.reject(new Error(`no scenario matching ${fragment}`))
  return caught(body)
}

describe('describeDriverConformance()', () => {
  it('registers the scenarios with the test functions it is given', () => {
    expect([...scenarios({ name: 'memory', driver: () => memory() }).keys()]).toEqual([
      'memory driver conformance > publishes and consumes with type routing, headers and confirmations',
      'memory driver conformance > retries in-process, then natively, with increasing attempts',
      'memory driver conformance > dead-letters after the last attempt and immediately for non-retryable errors',
      'memory driver conformance > handles messages concurrently up to the consumer concurrency',
      'memory driver conformance > gives pending in-process retries back to the broker on stop',
      'memory driver conformance > honours delayed publications as its capabilities declare',
    ])
  })

  it('passes the scenario timeout to it()', () => {
    const timeouts: (number | undefined)[] = []
    describeDriverConformance({
      name: 'memory',
      driver: () => memory(),
      timeoutMs: 1234,
      test: { describe: (_name, body) => body(), it: (_name, _body, timeoutMs) => timeouts.push(timeoutMs) },
    })
    expect(new Set(timeouts)).toEqual(new Set([1234]))
  })

  it('fails a driver that loses headers', async () => {
    const run = scenarios({ name: 'leaky', driver: () => droppingHeaders(memory()) })
    const basic = [...run.entries()].find(([name]) => name.includes('publishes and consumes'))?.[1]
    expect(await caught(() => basic?.())).toBeInstanceOf(AssertionError)
  })

  it('fails a driver whose release() loses the message', async () => {
    // no in-process budget by default (like Kafka): the restart scenario raises it through the
    // overrides, so the retry is pending in-process when the application stops
    const drivers = new Map<number | undefined, MessagingDriver>()
    const driver = (overrides: { maxInProcessDelayMs?: number }): MessagingDriver => {
      const key = overrides.maxInProcessDelayMs
      const lossy =
        drivers.get(key) ??
        rewritingDeliveries(memory({ maxInProcessDelayMs: key ?? 0 }), delivery => ({
          release: () => delivery.ack(),
        }))
      drivers.set(key, lossy)
      return lossy
    }
    const error = await runScenario({ name: 'lossy', driver, timeoutMs: 4000 }, 'on stop')
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Timed out waiting for redelivery after restart')
  })

  it('fails a driver that keeps an in-process budget below the restart retry delay', async () => {
    const driver = memory({ maxInProcessDelayMs: 0 })
    const error = await runScenario({ name: 'budget', driver: () => driver, timeoutMs: 4000 }, 'on stop')
    expect(error).toBeInstanceOf(AssertionError)
    expect((error as Error).message).toContain('honour overrides.maxInProcessDelayMs')
  })

  it('forces a native retry when the driver ignores the budget override', async () => {
    // budget fixed at 1000 ms and native retries redelivered at once: the second retry is native and
    // arrives too early
    const driver = () =>
      rewritingDeliveries(memory({ maxInProcessDelayMs: 1000 }), delivery => ({
        retry: request => delivery.retry({ ...request, delayMs: 0 }),
      }))
    const error = await runScenario({ name: 'eager', driver, nativeDelayMs: 200, timeoutMs: 8000 }, 'natively')
    expect(error).toBeInstanceOf(AssertionError)
    expect((error as Error).message).toContain('the retries waited')
  })

  it('fails a driver whose budget leaves no room for a native retry', async () => {
    const error = await runScenario(
      { name: 'unbounded', driver: () => memory({ maxInProcessDelayMs: 10_000_000 }), timeoutMs: 4000 },
      'natively',
    )
    expect(error).toBeInstanceOf(AssertionError)
    expect((error as Error).message).toContain('honour overrides.maxInProcessDelayMs')
  })

  it('reports what a failed wait waited for before the scenario timeout', async () => {
    const started = Date.now()
    const error = await runScenario(
      { name: 'mute', driver: () => droppingPublications(memory()), timeoutMs: 2000 },
      'publishes and consumes',
    )
    expect((error as Error).message).toContain('Timed out waiting for both messages')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('refuses invalid options', () => {
    expect(() => describeDriverConformance({} as DriverConformanceOptions)).toThrow(TypeError)
    expect(() =>
      describeDriverConformance({ name: 'x', driver: () => memory(), test: {} as ConformanceTestApi }),
    ).toThrow('describeDriverConformance() expects { name, driver, test: { describe, it } }')
    const test: ConformanceTestApi = { describe: () => undefined, it: () => undefined }
    for (const invalid of [
      { timeoutMs: 0 },
      { timeoutMs: Number.NaN },
      { nativeDelayMs: -1 },
      { nativeDelayMs: '1' },
    ]) {
      expect(() =>
        describeDriverConformance({ name: 'x', driver: () => memory(), test, ...(invalid as object) }),
      ).toThrow('must be a positive number of milliseconds')
    }
  })
})

// the conformance scenarios themselves, against the memory driver (the brokers run them under
// ZNIGHT_INTEGRATION=1, see test/integration) and against the sample driver of the README
const memoryDrivers = new Map<number | undefined, MessagingDriver>()
describeDriverConformance({
  name: 'memory',
  // the memory broker is the driver instance: the restart scenario reconnects the same one, so a
  // driver is shared by every application asking for the same overrides
  driver: overrides => {
    const key = overrides.maxInProcessDelayMs
    const driver = memoryDrivers.get(key) ?? memory(overrides)
    memoryDrivers.set(key, driver)
    return driver
  },
  test: { describe, it },
  nativeDelayMs: 200,
  timeoutMs: 15_000,
})

const broker = new LocalBroker()
describeDriverConformance({
  name: 'local (README sample)',
  driver: overrides => localDriver(broker, overrides),
  test: { describe, it },
  nativeDelayMs: 200,
  timeoutMs: 15_000,
})
