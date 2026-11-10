import type { MessagingDriver } from '@znight/messaging'
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

  it('refuses invalid options', () => {
    expect(() => describeDriverConformance({} as DriverConformanceOptions)).toThrow(TypeError)
    expect(() =>
      describeDriverConformance({ name: 'x', driver: () => memory(), test: {} as ConformanceTestApi }),
    ).toThrow('describeDriverConformance() expects { name, driver, test: { describe, it } }')
  })
})

// the conformance scenarios themselves, against the memory driver (the brokers run them under
// ZNIGHT_INTEGRATION=1, see test/integration) and against the sample driver of the README
const sharedMemory = memory()
describeDriverConformance({
  name: 'memory',
  // the memory broker is the driver instance: the restart scenario reconnects the same one
  driver: overrides => (overrides.maxInProcessDelayMs === undefined ? sharedMemory : memory(overrides)),
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
