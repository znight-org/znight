/**
 * `@znight/messaging/testing`: the conformance scenarios every messaging driver passes (RFC 0014).
 * The first-party drivers run them (the memory driver in the regular test run, the brokers against
 * Testcontainers); third-party drivers run them the same way.
 *
 * Framework-neutral: the caller passes its `describe` / `it` (`bun:test`, Vitest, Jest), and the
 * assertions are `node:assert`'s. Each scenario boots real applications (hand-written metadata, what
 * the compiler generates) with `MessagingPlugin` and the driver under test, and stops them at the end,
 * whatever the outcome.
 */
// biome-ignore-all lint/suspicious/useExpect: a framework-neutral suite, asserting with node:assert
import type { CoreLogger, ProviderClass, ProviderDefinition, Token, ZnightMetadata } from '@znight/core'
import type { MessagingDriver } from './driver.ts'
import type { InboundMessage } from './message.ts'
import type { ConsumerDefinition, ConsumerRuntimeOptions, MessageHandlerDefinition } from './metadata.ts'
import type { RetryPolicy } from './retry.ts'
import type { StandardSchemaV1 } from './standard-schema.ts'

import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict'
import { Application } from '@znight/core'

import { MessageBroker } from './broker.ts'
import { NonRetryableError } from './errors.ts'
import { MessagingHeaders } from './headers.ts'
import { MessagingPlugin } from './plugin.ts'
import { MessagingTokens } from './tokens.ts'
import { validateMessage } from './validation.ts'

/** The test functions of the framework running the suite. */
export interface ConformanceTestApi {
  describe(name: string, body: () => void): unknown
  /** Registers a scenario; `timeoutMs` is its timeout (`it(name, body, timeout)` of `bun:test`, Vitest, Jest). */
  it(name: string, body: () => Promise<void>, timeoutMs?: number): unknown
}

/** What a scenario may ask of the driver factory. */
export interface ConformanceDriverOverrides {
  /**
   * Longest retry delay waited in-process. Required: pass it to the driver options. The retry scenario
   * sets it below the second retry delay to force a native retry, and the restart scenario sets it
   * above its retry delay so that a retry is pending in-process when the application stops; a driver
   * keeping another budget fails them with an explanation.
   */
  readonly maxInProcessDelayMs?: number
}

/** Options of {@link describeDriverConformance}. */
export interface DriverConformanceOptions {
  /** Name of the driver in the scenario names (`'acme driver conformance'`). */
  readonly name: string
  /**
   * A driver for one application. Called for each application a scenario boots, including a second
   * application after the first one stopped (the restart scenario): every driver must reach the same
   * broker. For an in-process broker held by the driver instance, return the same instance (it is
   * connected again after `close()`).
   */
  readonly driver: (overrides: ConformanceDriverOverrides) => MessagingDriver
  /** `describe` and `it` of the test framework. */
  readonly test: ConformanceTestApi
  /**
   * Creates a queue and its dead-letter destination before a scenario uses them, for drivers that
   * never create resources (SQS, Pub/Sub without `provision`). Default: nothing.
   */
  readonly prepareQueue?: (queue: string, deadLetterQueue: string) => Promise<void>
  /** Driver options of `@Consumer({ queue, ...options })` for a queue (a Kafka group...). Default: none. */
  readonly consumerOptions?: (queue: string) => Readonly<Record<string, unknown>>
  /** Shortest native retry delay the broker honours precisely, in ms (whole seconds for SQS). Default: 1000. */
  readonly nativeDelayMs?: number
  /**
   * Timeout of each scenario, in ms. Default: 120 000. The scenario's own waits end a quarter of it
   * (at most 10 s) earlier, so that a failure reports what it waited for and stops its applications
   * before the test framework times the scenario out.
   */
  readonly timeoutMs?: number
}

const DEFAULT_NATIVE_DELAY_MS = 1000
const DEFAULT_TIMEOUT_MS = 120_000
/** Longest share of the scenario timeout kept for stopping the applications after a failed wait. */
const MAX_STOP_MARGIN_MS = 10_000
/** Retry delay of the restart scenario, held in-process when the application stops. */
const RESTART_RETRY_DELAY_MS = 1000

/**
 * Describes the conformance scenarios of a messaging driver: publishing and consuming with type
 * routing, headers (trace context included) and confirmations; retries in-process then native with
 * increasing attempts; dead letters (last attempt, non-retryable error, validation) with their
 * headers; concurrency; pending retries given back on stop and redelivered after a restart; delayed
 * publishing honoured, or refused when the driver declares `maxPublishDelayMs: 0`.
 *
 * ```ts
 * import { describeDriverConformance } from '@znight/messaging/testing'
 * import { describe, it } from 'bun:test'
 *
 * describeDriverConformance({ name: 'acme', driver: overrides => acme({ url, ...overrides }), test: { describe, it } })
 * ```
 */
export function describeDriverConformance(options: DriverConformanceOptions): void {
  if (
    options === null ||
    typeof options !== 'object' ||
    typeof options.name !== 'string' ||
    typeof options.driver !== 'function' ||
    typeof options.test?.describe !== 'function' ||
    typeof options.test.it !== 'function'
  ) {
    throw new TypeError('[znight] describeDriverConformance() expects { name, driver, test: { describe, it } }')
  }
  for (const key of ['nativeDelayMs', 'timeoutMs'] as const) {
    const value = options[key]
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      throw new TypeError(
        `[znight] describeDriverConformance(): "${key}" must be a positive number of milliseconds, got ${String(value)}`,
      )
    }
  }
  const suite = new Suite(options)
  const { test } = options
  const scenario = (name: string, body: (run: Run) => Promise<void>): void => {
    test.it(name, () => suite.run(body), suite.timeoutMs)
  }
  test.describe(`${options.name} driver conformance`, () => {
    scenario('publishes and consumes with type routing, headers and confirmations', run => basic(suite, run))
    scenario('retries in-process, then natively, with increasing attempts', run => retries(suite, run))
    scenario('dead-letters after the last attempt and immediately for non-retryable errors', run =>
      deadLetters(suite, run),
    )
    scenario('handles messages concurrently up to the consumer concurrency', run => concurrency(suite, run))
    scenario('gives pending in-process retries back to the broker on stop', run => restart(suite, run))
    scenario('honours delayed publications as its capabilities declare', run => delayedPublish(suite, run))
  })
}

// ------------------------------------------------------------------------------------------------
// scenarios

interface Received {
  readonly payload: unknown
  readonly message: InboundMessage
}

async function basic(suite: Suite, run: Run): Promise<void> {
  const { queue, driver, options } = await suite.prepare('basic')
  const created: Received[] = []
  const others: Received[] = []
  class OrderConsumer {
    created(payload: unknown, message: InboundMessage): void {
      created.push({ payload, message })
    }
    other(payload: unknown, message: InboundMessage): void {
      others.push({ payload, message })
    }
  }
  const app = await run.start(driver, [
    {
      class: OrderConsumer,
      queue,
      options,
      handlers: [handler('created', { type: 'order.created' }), handler('other')],
    },
  ])
  const broker = app.get(MessageBroker)
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  const { id } = await broker.publish(
    queue,
    { id: 1, items: ['a', 'b'] },
    { type: 'order.created', headers: { 'x-tenant': 'acme', traceparent }, key: 'k1' },
  )
  await broker.publish(queue, 'plain', { type: 'order.cancelled' })
  await run.waitFor(() => created.length === 1 && others.length === 1, 'both messages')
  const [first] = created
  ok(first, 'the typed message reached its handler')
  deepStrictEqual(first.payload, { id: 1, items: ['a', 'b'] })
  const message = first.message
  strictEqual(message.id, id, 'the message id survives the round trip')
  strictEqual(message.queue, queue)
  strictEqual(message.type, 'order.created')
  strictEqual(message.attempt, 1)
  strictEqual(message.driver, driver.name)
  strictEqual(message.headers['x-tenant'], 'acme', 'application headers are carried verbatim')
  strictEqual(message.headers['traceparent'], traceparent, 'the trace context is carried verbatim')
  ok(message.contentType?.startsWith('application/json'), `content type ${String(message.contentType)}`)
  strictEqual(others[0]?.payload, 'plain')
  strictEqual(others[0]?.message.type, 'order.cancelled')
}

async function retries(suite: Suite, run: Run): Promise<void> {
  const { nativeDelayMs } = suite
  const queue = suite.uniqueQueue('retry')
  // budget below the second delay: first retry in-process, second one native
  const driver = suite.options.driver({ maxInProcessDelayMs: nativeDelayMs - 1 })
  await suite.prepareQueue(queue, driver)
  const capabilities = driver.capabilities
  // with native delay, the second retry (twice the first one) is above the actual budget, whatever
  // the driver did with the override; without native delay, both retries wait in-process
  const delay = capabilities.nativeDelay
    ? Math.max(nativeDelayMs / 2, Math.floor(capabilities.maxInProcessDelayMs / 2) + 1)
    : Math.min(nativeDelayMs / 2, Math.floor(capabilities.maxInProcessDelayMs / 2))
  if (capabilities.nativeDelay) {
    const budget = `in-process budget ${capabilities.maxInProcessDelayMs} ms (overrides.maxInProcessDelayMs: ${nativeDelayMs - 1})`
    ok(
      delay * 2 <= capabilities.maxNativeDelayMs && delay * 3 < run.remainingMs(),
      `no retry delay forces a native retry in time with an ${budget} and native delays up to ${capabilities.maxNativeDelayMs} ms: honour overrides.maxInProcessDelayMs`,
    )
  }
  const attempts: number[] = []
  class FlakyConsumer {
    handle(_payload: unknown, message: InboundMessage): void {
      attempts.push(message.attempt)
      if (message.attempt < 3) throw new Error(`transient ${message.attempt}`)
    }
  }
  const app = await run.start(driver, [
    {
      class: FlakyConsumer,
      queue,
      options: suite.consumerOptions(queue),
      handlers: [handler('handle', { retry: { attempts: 3, backoff: 'exponential', delay } })],
    },
  ])
  const started = Date.now()
  await app.get(MessageBroker).publish(queue, { n: 1 })
  await run.waitFor(() => attempts.length === 3, 'three attempts')
  deepStrictEqual(attempts, [1, 2, 3])
  const elapsed = Date.now() - started
  ok(elapsed >= delay * 3 - 100, `the retries waited ${elapsed} ms, expected at least ${delay * 3 - 100} ms`)
}

/** `{ id: number }`, as a Standard Schema. */
const OrderSchema: StandardSchemaV1<unknown, { id: number }> = {
  '~standard': {
    version: 1,
    vendor: 'znight-conformance',
    validate: value =>
      typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number'
        ? { value: value as { id: number } }
        : { issues: [{ message: 'Expected a number', path: ['id'] }] },
  },
}

async function deadLetters(suite: Suite, run: Run): Promise<void> {
  const { queue, driver, options } = await suite.prepare('dlq')
  const dead: Received[] = []
  const attempts: number[] = []
  class FailingConsumer {
    handle(payload: { id: number }, message: InboundMessage): void {
      attempts.push(message.attempt)
      if (payload.id === 1) throw new Error('always failing')
      throw new NonRetryableError('permanent')
    }
  }
  const app = await run.start(driver, [
    {
      class: FailingConsumer,
      queue,
      options,
      handlers: [
        {
          method: 'handle',
          retry: { attempts: 2, backoff: 'fixed', delay: 10 },
          invoke: async (consumer: FailingConsumer, message: InboundMessage) =>
            consumer.handle(await validateMessage(OrderSchema, message.payload), message),
        },
      ],
    },
    suite.deadLetterCollector(driver, queue, dead),
  ])
  const broker = app.get(MessageBroker)
  await broker.publish(queue, { id: 1 }, { type: 'a', headers: { keep: 'me' } })
  await run.waitFor(() => dead.length === 1, 'first dead letter')
  await broker.publish(queue, { id: 2 })
  await run.waitFor(() => dead.length === 2, 'second dead letter')
  await broker.publish(queue, { id: 'invalid' })
  await run.waitFor(() => dead.length === 3, 'third dead letter')
  deepStrictEqual(attempts, [1, 2, 1])
  deepStrictEqual(
    dead.map(entry => entry.payload),
    [{ id: 1 }, { id: 2 }, { id: 'invalid' }],
  )
  deepStrictEqual(
    dead.map(entry => entry.message.headers[MessagingHeaders.DeadLetterReason]),
    ['max-attempts', 'non-retryable', 'validation'],
  )
  const first = dead[0]?.message
  ok(first, 'the first message was dead-lettered')
  strictEqual(first.headers['keep'], 'me', 'the dead letter keeps the original headers')
  strictEqual(first.headers[MessagingHeaders.Error], 'always failing')
  strictEqual(first.headers[MessagingHeaders.OriginalQueue], queue)
  strictEqual(first.headers[MessagingHeaders.Attempts], '2')
  strictEqual(first.type, 'a', 'the dead letter keeps the message type')
  strictEqual(first.attempt, 1, 'the dead letter starts over at attempt 1')
}

async function concurrency(suite: Suite, run: Run): Promise<void> {
  const { queue, driver, options } = await suite.prepare('concurrency')
  let active = 0
  let max = 0
  let done = 0
  class SlowConsumer {
    async handle(): Promise<void> {
      active++
      max = Math.max(max, active)
      await sleep(150)
      active--
      done++
    }
  }
  const app = await run.start(driver, [
    { class: SlowConsumer, queue, options: { ...options, concurrency: 3 }, handlers: [handler('handle')] },
  ])
  const broker = app.get(MessageBroker)
  for (let index = 0; index < 6; index++) await broker.publish(queue, index, { key: `k${index}` })
  await run.waitFor(() => done === 6, 'six messages')
  ok(max > 1, `messages were handled one at a time (max ${max} concurrently)`)
  ok(max <= 3, `${max} messages were handled concurrently, above the consumer concurrency (3)`)
}

async function restart(suite: Suite, run: Run): Promise<void> {
  // a budget covering the retry delay: the retry is pending in-process when the application stops
  const overrides = { maxInProcessDelayMs: RESTART_RETRY_DELAY_MS }
  const { queue, driver, options } = await suite.prepare('stop', overrides)
  ok(
    driver.capabilities.maxInProcessDelayMs >= RESTART_RETRY_DELAY_MS,
    `the restart scenario holds a ${RESTART_RETRY_DELAY_MS} ms retry in-process, the driver budget is ${driver.capabilities.maxInProcessDelayMs} ms: honour overrides.maxInProcessDelayMs`,
  )
  const firstRun: number[] = []
  class FailingConsumer {
    handle(_payload: unknown, message: InboundMessage): void {
      firstRun.push(message.attempt)
      throw new Error('fail')
    }
  }
  const app = await run.start(driver, [
    {
      class: FailingConsumer,
      queue,
      options,
      handlers: [handler('handle', { retry: { attempts: 5, backoff: 'fixed', delay: RESTART_RETRY_DELAY_MS } })],
    },
  ])
  await app.get(MessageBroker).publish(queue, { keep: true })
  await run.waitFor(() => firstRun.length === 1, 'first attempt')
  await sleep(50)
  await run.stop(app)

  const received: Received[] = []
  class HealthyConsumer {
    handle(payload: unknown, message: InboundMessage): void {
      received.push({ payload, message })
    }
  }
  await run.start(suite.options.driver(overrides), [
    { class: HealthyConsumer, queue, options, handlers: [handler('handle')] },
  ])
  await run.waitFor(() => received.length === 1, 'redelivery after restart')
  deepStrictEqual(received[0]?.payload, { keep: true })
}

async function delayedPublish(suite: Suite, run: Run): Promise<void> {
  const { queue, driver, options } = await suite.prepare('delay')
  const received: number[] = []
  class Consumer {
    handle(): void {
      received.push(Date.now())
    }
  }
  const app = await run.start(driver, [{ class: Consumer, queue, options, handlers: [handler('handle')] }])
  const broker = app.get(MessageBroker)
  if (driver.capabilities.maxPublishDelayMs <= 0) {
    await rejects(broker.publish(queue, 1, { delay: 1000 }), /does not support delayed publishing/)
    return
  }
  const started = Date.now()
  await broker.publish(queue, 1, { delay: 1000 })
  await run.waitFor(() => received.length === 1, 'delayed message')
  const elapsed = (received[0] ?? 0) - started
  ok(elapsed >= 900, `the message published with a delay of 1000 ms arrived after ${elapsed} ms`)
}

// ------------------------------------------------------------------------------------------------
// support

// biome-ignore lint/suspicious/noExplicitAny: scenario consumer classes take no constructor arguments
type ConsumerClass = new (...args: any[]) => unknown

interface TestConsumer {
  readonly class: ConsumerClass
  readonly queue: string
  readonly options?: ConsumerRuntimeOptions
  readonly handlers: readonly MessageHandlerDefinition[]
}

let counter = 0

class Suite {
  readonly options: DriverConformanceOptions
  readonly nativeDelayMs: number
  readonly timeoutMs: number

  constructor(options: DriverConformanceOptions) {
    this.options = options
    this.nativeDelayMs = options.nativeDelayMs ?? DEFAULT_NATIVE_DELAY_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Runs a scenario, then stops every application it started (in reverse order). */
  async run(body: (run: Run) => Promise<void>): Promise<void> {
    const margin = Math.min(MAX_STOP_MARGIN_MS, this.timeoutMs / 4)
    const run = new Run(Date.now() + this.timeoutMs - margin)
    try {
      await body(run)
    } finally {
      await run.stopAll()
    }
  }

  uniqueQueue(prefix: string): string {
    counter++
    const name = this.options.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    return `${name}-${prefix}-${Date.now().toString(36)}-${counter}`
  }

  consumerOptions(queue: string): Record<string, unknown> {
    return { ...this.options.consumerOptions?.(queue) }
  }

  async prepareQueue(queue: string, driver: MessagingDriver): Promise<void> {
    await this.options.prepareQueue?.(queue, driver.deadLetterName(queue))
  }

  async prepare(
    prefix: string,
    overrides: ConformanceDriverOverrides = {},
  ): Promise<{ queue: string; driver: MessagingDriver; options: Record<string, unknown> }> {
    const queue = this.uniqueQueue(prefix)
    const driver = this.options.driver(overrides)
    await this.prepareQueue(queue, driver)
    return { queue, driver, options: this.consumerOptions(queue) }
  }

  /** A consumer collecting the messages of the dead-letter queue of `queue`. */
  deadLetterCollector(driver: MessagingDriver, queue: string, sink: Received[]): TestConsumer {
    class DeadLetterCollector {
      collect(payload: unknown, message: InboundMessage): void {
        sink.push({ payload, message })
      }
    }
    const deadLetterQueue = driver.deadLetterName(queue)
    return {
      class: DeadLetterCollector,
      queue: deadLetterQueue,
      options: { ...this.consumerOptions(deadLetterQueue), deadLetter: false },
      handlers: [handler('collect', { retry: { attempts: 1, backoff: 'fixed', delay: 0 } })],
    }
  }
}

/** The applications of one scenario. */
class Run {
  #apps: Application[] = []
  /** When the scenario's waits give up (epoch ms), ahead of the framework timeout. */
  readonly #deadline: number

  constructor(deadline: number) {
    this.#deadline = deadline
  }

  /** Time left for the scenario's waits, in ms. */
  remainingMs(): number {
    return this.#deadline - Date.now()
  }

  /** Polls `predicate` until it holds, failing with `label` once the scenario's wait deadline passed. */
  async waitFor(predicate: () => boolean, label: string): Promise<void> {
    while (!predicate()) {
      if (Date.now() > this.#deadline) {
        throw new Error(`Timed out waiting for ${label} (the scenario timeout is near; see the timeoutMs option)`)
      }
      await sleep(20)
    }
  }

  async start(driver: MessagingDriver, consumers: readonly TestConsumer[]): Promise<Application> {
    const app = await Application.create({
      metadata: messagingMetadata(consumers),
      plugins: [MessagingPlugin.configure({ driver, defaults: { requeueDelay: 50 } })],
      logger: SILENT_LOGGER,
      shutdown: { signals: false, hookTimeoutMs: 20_000, timeoutMs: 30_000 },
    })
    this.#apps.push(app)
    await app.start()
    return app
  }

  async stop(app: Application): Promise<void> {
    this.#apps = this.#apps.filter(other => other !== app)
    await app.stop()
  }

  async stopAll(): Promise<void> {
    const running = this.#apps
    this.#apps = []
    for (const app of running.reverse()) await app.stop()
  }
}

const noop = (): void => {}
const SILENT_LOGGER: CoreLogger = { debug: noop, info: noop, warn: noop, error: noop }

/** Hand-written metadata shaped like the compiler output. */
function messagingMetadata(consumers: readonly TestConsumer[]): ZnightMetadata {
  const providers: Record<Token, ProviderDefinition> = {}
  const definitions: ConsumerDefinition[] = []
  for (const [index, consumer] of consumers.entries()) {
    const token: Token = `src/conformance.ts#${consumer.class.name}${index}`
    const cls = consumer.class
    providers[token] = {
      scope: 'singleton',
      class: cls as unknown as ProviderClass,
      deps: [],
      factory: () => new cls(),
    }
    definitions.push({
      token,
      queue: consumer.queue,
      handlers: consumer.handlers,
      ...(consumer.options === undefined ? {} : { options: consumer.options }),
    })
  }
  return {
    version: 1,
    providers,
    resolutionOrder: Object.keys(providers),
    externals: [
      { token: MessagingTokens.MessageBroker, providedBy: 'MessagingPlugin' },
      { token: MessagingTokens.InboundMessage, scope: 'request', providedBy: 'MessagingPlugin' },
    ],
    extensions: { messaging: { consumers: definitions } },
  }
}

/** A handler calling `method` with the payload and the message. */
function handler(method: string, extra: { type?: string; retry?: RetryPolicy } = {}): MessageHandlerDefinition {
  return {
    method,
    invoke: (consumer: Record<string, (...args: unknown[]) => unknown>, message: InboundMessage) =>
      (consumer[method] as (...args: unknown[]) => unknown).call(consumer, message.payload, message),
    ...extra,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
