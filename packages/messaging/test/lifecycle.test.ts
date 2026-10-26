import type { MessageDeliveryEvent } from '@znight/core'
import type { InboundMessage } from '../src/index.ts'

import { Application, ErrorCode, ZnightError } from '@znight/core'

import { MemoryDriver } from '../src/drivers/memory.ts'
import { MessagingPlugin, MessagingTokens } from '../src/index.ts'
import {
  caught,
  classDef,
  createTestApp,
  deferred,
  handler,
  memoryLogger,
  messageOf,
  messagingMetadata,
  sleep,
  type TestApp,
  t,
} from './helpers.ts'
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

describe('concurrency', () => {
  function gatedConsumer(gate: Promise<void>, stats: { active: number; max: number; done: number }) {
    return class GatedConsumer {
      async handle() {
        stats.active++
        stats.max = Math.max(stats.max, stats.active)
        await gate
        stats.active--
        stats.done++
      }
    }
  }

  it('handles one message at a time by default', async () => {
    const gate = deferred()
    const stats = { active: 0, max: 0, done: 0 }
    const { broker, driver } = await setup([
      { class: gatedConsumer(gate.promise, stats), queue: 'q', handlers: [handler('handle')] },
    ])
    for (let index = 0; index < 4; index++) await broker.publish('q', index)
    await sleep(5)
    expect(stats.active).toBe(1)
    gate.resolve()
    await driver.idle()
    expect(stats).toEqual({ active: 0, max: 1, done: 4 })
  })

  it('honours the consumer concurrency', async () => {
    const gate = deferred()
    const stats = { active: 0, max: 0, done: 0 }
    const { broker, driver, plugin } = await setup([
      {
        class: gatedConsumer(gate.promise, stats),
        queue: 'q',
        options: { concurrency: 3 },
        handlers: [handler('handle')],
      },
    ])
    for (let index = 0; index < 7; index++) await broker.publish('q', index)
    await sleep(5)
    expect(stats.active).toBe(3)
    expect(plugin.consumers()).toMatchObject([
      { consumer: 'GatedConsumer', queue: 'q', state: 'running', concurrency: 3, inFlight: 3 },
    ])
    gate.resolve()
    await driver.idle()
    expect(stats).toEqual({ active: 0, max: 3, done: 7 })
  })

  it('uses defaults.concurrency', async () => {
    const gate = deferred()
    const stats = { active: 0, max: 0, done: 0 }
    const { broker, driver } = await setup(
      [{ class: gatedConsumer(gate.promise, stats), queue: 'q', handlers: [handler('handle')] }],
      {
        plugin: { defaults: { concurrency: 2 } },
      },
    )
    for (let index = 0; index < 5; index++) await broker.publish('q', index)
    await sleep(5)
    expect(stats.active).toBe(2)
    gate.resolve()
    await driver.idle()
    expect(stats.max).toBe(2)
  })
})

describe('graceful stop', () => {
  it('awaits in-flight handlers before stopping', async () => {
    const gate = deferred()
    const started = deferred()
    let signal: AbortSignal | undefined
    class SlowConsumer {
      async handle(_payload: unknown, message: InboundMessage) {
        signal = message.signal
        started.resolve()
        await gate.promise
      }
    }
    const { app, broker, driver } = await setup([{ class: SlowConsumer, queue: 'q', handlers: [handler('handle')] }])
    await broker.publish('q', {})
    await started.promise
    const stopping = app.stop()
    await sleep(5)
    expect(signal?.aborted).toBe(true)
    expect(app.state).toBe('stopping')
    gate.resolve()
    await stopping
    expect(app.state).toBe('stopped')
    expect(driver.settlements('q').map(s => s.action)).toEqual(['ack'])
    current = undefined
  })

  it('releases messages waiting for an in-process retry delay', async () => {
    const failed = deferred()
    class FailingConsumer {
      handle() {
        failed.resolve()
        throw new Error('transient')
      }
    }
    const { app, broker, driver } = await setup([
      {
        class: FailingConsumer,
        queue: 'q',
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 900 } })],
      },
    ])
    await broker.publish('q', { id: 1 })
    await failed.promise
    await sleep(5)
    const started = performance.now()
    await app.stop()
    expect(performance.now() - started).toBeLessThan(500)
    expect(driver.settlements('q').map(s => s.action)).toEqual(['release'])
    // never dropped: the message is back in the queue
    expect(driver.pending('q').map(m => m.payload)).toEqual([{ id: 1 }])
    current = undefined
  })

  it('releases messages waiting for a concurrency slot', async () => {
    const gate = deferred()
    const started = deferred()
    class SlowConsumer {
      async handle() {
        started.resolve()
        await gate.promise
      }
    }
    // a driver ignoring the requested concurrency: the runtime still enforces it
    class GreedyDriver extends MemoryDriver {
      override subscribe(...[queue, deliveryHandler, options]: Parameters<MemoryDriver['subscribe']>) {
        return super.subscribe(queue, deliveryHandler, { ...options, concurrency: 10 })
      }
    }
    const driver = new GreedyDriver()
    const { app, broker } = await setup([{ class: SlowConsumer, queue: 'q', handlers: [handler('handle')] }], {
      driver,
    })
    await broker.publish('q', 1)
    await broker.publish('q', 2)
    await started.promise
    await sleep(5)
    expect(current?.plugin.consumers()[0]?.inFlight).toBe(2)
    const stopping = app.stop()
    await sleep(5)
    gate.resolve()
    await stopping
    expect(driver.settlements('q').map(s => [s.action, s.id === driver.published('q')[0]?.id])).toEqual([
      ['release', false],
      ['ack', true],
    ])
    current = undefined
  })

  it('stops consumers that never started when consume is false', async () => {
    class Consumer {
      handle() {}
    }
    const { app, broker, driver, plugin } = await setup(
      [{ class: Consumer, queue: 'q', handlers: [handler('handle')] }],
      {
        plugin: { consume: false },
      },
    )
    await broker.publish('q', 1)
    await sleep(5)
    expect(driver.pending('q')).toHaveLength(1)
    expect(plugin.consumers()[0]?.state).toBe('created')
    await app.stop()
    expect(plugin.consumers()[0]?.state).toBe('stopped')
    expect(driver.connected).toBe(false)
    current = undefined
  })

  it('closes the driver on dispose', async () => {
    class Consumer {
      handle() {}
    }
    const { app, driver, broker } = await setup([{ class: Consumer, queue: 'q', handlers: [handler('handle')] }])
    expect(driver.connected).toBe(true)
    await app.stop()
    expect(driver.connected).toBe(false)
    const error = await caught(broker.publish('q', 1))
    expect((error as Error).message).toContain('has been disposed')
    current = undefined
  })
})

describe('hooks and scopes', () => {
  it('runs each delivery through hooks.run("messaging:message")', async () => {
    const trail: string[] = []
    const events: MessageDeliveryEvent[] = []
    class Consumer {
      handle() {
        trail.push('handler')
      }
    }
    const { app, broker, driver } = await setup([
      { class: Consumer, queue: 'q', handlers: [handler('handle', { type: 'ping' })] },
    ])
    app.hooks.wrap('messaging:message', async (event, next) => {
      trail.push(`outer:${event.outcome}`)
      await next()
      trail.push(`outer-after:${event.outcome}`)
      events.push(event)
    })
    app.hooks.wrap('messaging:message', async (_event, next) => {
      trail.push('inner')
      await next()
    })
    const { id } = await broker.publish('q', { a: 1 }, { type: 'ping', headers: { h: 'v' } })
    await driver.idle()
    expect(trail).toEqual(['outer:undefined', 'inner', 'handler', 'outer-after:ack'])
    expect(events[0]).toMatchObject({
      queue: 'q',
      type: 'ping',
      messageId: id,
      attempt: 1,
      headers: { h: 'v' },
      consumer: 'Consumer',
      handler: 'handle',
      outcome: 'ack',
    })
    expect((events[0]?.message as InboundMessage | undefined)?.payload).toEqual({ a: 1 })
    expect(events[0]?.startTime).toBeGreaterThan(0)
  })

  it('emits the completed event to hooks.on() listeners', async () => {
    class Consumer {
      handle(payload: number) {
        if (payload === 2) throw new Error('fail')
      }
    }
    const { app, broker, driver } = await setup([
      {
        class: Consumer,
        queue: 'q',
        handlers: [handler('handle', { retry: { attempts: 1, backoff: 'fixed', delay: 0 } })],
      },
    ])
    const seen: [string | undefined, unknown][] = []
    app.hooks.on('messaging:message', event => {
      seen.push([event.outcome, messageOf(event.error)])
    })
    await broker.publish('q', 1)
    await broker.publish('q', 2)
    await driver.idle()
    expect(seen).toEqual([
      ['ack', undefined],
      ['dead-letter', 'fail'],
    ])
  })

  it('reports the outcome and error of failed deliveries', async () => {
    const events: MessageDeliveryEvent[] = []
    class Consumer {
      handle() {
        throw new Error('kaboom')
      }
    }
    const { app, broker, driver } = await setup([
      {
        class: Consumer,
        queue: 'q',
        handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 1 } })],
      },
    ])
    app.hooks.wrap('messaging:message', async (event, next) => {
      await next()
      events.push(event)
    })
    await broker.publish('q', {})
    await driver.idle()
    expect(events.map(e => [e.attempt, e.outcome, (e.error as Error).message])).toEqual([
      [1, 'retry', 'kaboom'],
      [2, 'dead-letter', 'kaboom'],
    ])
  })

  it('counts a wrapper failure before next() as a failed attempt', async () => {
    let calls = 0
    class Consumer {
      handle() {
        calls++
      }
    }
    const { app, broker, driver } = await setup([
      {
        class: Consumer,
        queue: 'q',
        handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 1 } })],
      },
    ])
    let failures = 1
    app.hooks.wrap('messaging:message', async (_event, next) => {
      if (failures-- > 0) throw new Error('wrapper failure')
      await next()
    })
    await broker.publish('q', {})
    await driver.idle()
    expect(calls).toBe(1)
    expect(driver.settlements('q').map(s => s.action)).toEqual(['retry', 'ack'])
  })

  it('retries when a wrapper does not call next()', async () => {
    let calls = 0
    class Consumer {
      handle() {
        calls++
      }
    }
    const { app, broker, driver } = await setup([
      {
        class: Consumer,
        queue: 'q',
        handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 1 } })],
      },
    ])
    let skips = 1
    app.hooks.wrap('messaging:message', async (_event, next) => {
      if (skips-- > 0) return
      await next()
    })
    await broker.publish('q', {})
    await driver.idle()
    expect(calls).toBe(1)
    expect(driver.settlements('q').map(s => s.action)).toEqual(['retry', 'ack'])
  })

  it('logs (without settling twice) a wrapper failing after next()', async () => {
    class Consumer {
      handle() {}
    }
    const { app, broker, driver, logs } = await setup([{ class: Consumer, queue: 'q', handlers: [handler('handle')] }])
    app.hooks.wrap('messaging:message', async (_event, next) => {
      await next()
      await next() // ignored: the delivery runs once
      throw new Error('late wrapper failure')
    })
    await broker.publish('q', {})
    await driver.idle()
    expect(driver.settlements('q').map(s => s.action)).toEqual(['ack'])
    expect(logs.some(log => log.message.includes('error after handling message'))).toBe(true)
  })

  it('creates request-scoped providers once per delivery and disposes them', async () => {
    const created: RequestContext[] = []
    const disposed: string[] = []
    class RequestContext {
      readonly message: InboundMessage
      constructor(message: InboundMessage) {
        this.message = message
        created.push(this)
      }
      [Symbol.dispose]() {
        disposed.push(this.message.id)
      }
    }
    class Consumer {
      readonly #context: { get(): RequestContext }
      constructor(context: { get(): RequestContext }) {
        this.#context = context
      }
      handle(payload: unknown) {
        const context = this.#context.get()
        expect(context).toBe(this.#context.get())
        expect(context.message.payload).toEqual(payload)
      }
    }
    const { broker, driver } = await setup(
      [{ class: Consumer, queue: 'q', deps: [{ lazy: t('RequestContext') }], handlers: [handler('handle')] }],
      { providers: { [t('RequestContext')]: classDef(RequestContext, [MessagingTokens.InboundMessage], 'request') } },
    )
    const first = await broker.publish('q', 1)
    const second = await broker.publish('q', 2)
    await driver.idle()
    expect(created.map(context => context.message.payload)).toEqual([1, 2])
    expect(disposed).toEqual([first.id, second.id])
  })

  it('instantiates request-scoped consumers per delivery', async () => {
    const instances = new Set<object>()
    class ScopedConsumer {
      handle() {
        instances.add(this)
      }
    }
    const { broker, driver } = await setup([
      { class: ScopedConsumer, queue: 'q', scope: 'request', handlers: [handler('handle')] },
    ])
    await broker.publish('q', 1)
    await broker.publish('q', 2)
    await driver.idle()
    expect(instances.size).toBe(2)
  })

  it('treats a consumer factory failure as a failed attempt', async () => {
    let constructed = 0
    class BrokenConsumer {
      constructor() {
        constructed++
        if (constructed === 1) throw new Error('constructor failure')
      }
      handle() {}
    }
    const { broker, driver } = await setup([
      {
        class: BrokenConsumer,
        queue: 'q',
        scope: 'request',
        handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 1 } })],
      },
    ])
    await broker.publish('q', 1)
    await driver.idle()
    expect(driver.settlements('q').map(s => s.action)).toEqual(['retry', 'ack'])
  })
})

describe('bootstrap', () => {
  class Consumer {
    handle() {}
  }

  async function bootError(
    consumers: Parameters<typeof messagingMetadata>[0],
    options: Partial<Parameters<typeof MessagingPlugin.configure>[0] & object> = {},
    driver = new MemoryDriver(),
  ): Promise<ZnightError> {
    const error = await caught(
      Application.create({
        metadata: messagingMetadata(consumers),
        plugins: [MessagingPlugin.configure({ driver, ...options })],
        logger: memoryLogger(),
        shutdown: { signals: false },
      }),
    )
    // lifecycle errors wrap the plugin failure
    const cause = error instanceof ZnightError && error.code === ErrorCode.LifecycleFailed ? error.cause : error
    expect(cause).toBeInstanceOf(ZnightError)
    return cause as ZnightError
  }

  it('fails when a retry delay exceeds the driver capabilities', async () => {
    const error = await bootError(
      [
        {
          class: Consumer,
          queue: 'q',
          handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 60_000 } })],
        },
      ],
      {},
      new MemoryDriver({ nativeDelay: false }),
    )
    expect(error.code).toBe(ErrorCode.InvalidConsumer)
    expect(error.message).toContain('@Retry on Consumer.handle(): the memory driver cannot wait 60000 ms')
    expect(error.hints.length).toBeGreaterThan(0)
  })

  it('checks the default policy too', async () => {
    const error = await bootError(
      [{ class: Consumer, queue: 'q', handlers: [handler('handle')] }],
      {},
      new MemoryDriver({ maxNativeDelayMs: 1500 }),
    )
    expect(error.message).toContain('Consumer.handle() (default retry policy): the memory driver cannot wait 2000 ms')
  })

  it.each([
    [[handler('handle', { type: 'a' }), handler('other', { type: 'a' })], 'several @OnMessage handlers for type "a"'],
    [
      [handler('handle', { type: 'a.*' }), handler('other', { type: 'a.*' })],
      'several @OnMessage handlers for type "a.*"',
    ],
    [[handler('handle'), handler('other')], 'are both default @OnMessage() handlers'],
    [[], 'has no @OnMessage handler'],
    [[handler('handle', { retry: { attempts: 0, backoff: 'fixed', delay: 1 } })], '"attempts" must be an integer'],
    [[handler('handle', { retry: { attempts: 2, backoff: 'linear' as never, delay: 1 } })], '"backoff" must be'],
    [[handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: -1 } })], '"delay" must be'],
    [[handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 10, maxDelay: 5 } })], '"maxDelay" must be'],
    [[{ method: 'handle', invoke: undefined as never }], 'the handler has no invoker'],
    [[handler('handle', { type: '' })], 'the @OnMessage type must be a non-empty string'],
  ])('rejects invalid handlers (%#)', async (handlers, message) => {
    const error = await bootError([{ class: Consumer, queue: 'q', handlers }])
    expect(error.code).toBe(ErrorCode.InvalidConsumer)
    expect(error.message).toContain(message)
  })

  it('rejects two consumers of the same queue', async () => {
    class Other {
      handle() {}
    }
    const error = await bootError([
      { class: Consumer, queue: 'q', handlers: [handler('handle')] },
      { class: Other, queue: 'q', handlers: [handler('handle')] },
    ])
    expect(error.message).toContain('Consumer and Other both consume "q"')
  })

  it.each([
    [{ concurrency: 0 }, '"concurrency" must be a positive integer'],
    [{ concurrency: 1.5 }, '"concurrency" must be a positive integer'],
    [{ deadLetter: 42 as never }, '"deadLetter" must be a queue name or false'],
    [{ deadLetter: 'q' }, 'the dead-letter queue cannot be the consumed queue'],
  ])('rejects invalid consumer options (%#)', async (options, message) => {
    const error = await bootError([{ class: Consumer, queue: 'q', options, handlers: [handler('handle')] }])
    expect(error.message).toContain(message)
  })

  it('rejects an unknown @OnError method', async () => {
    const error = await bootError([
      { class: Consumer, queue: 'q', errorHandler: 'missing', handlers: [handler('handle')] },
    ])
    expect(error.message).toContain('the @OnError method missing() does not exist')
  })

  it('rejects a consumer without provider', async () => {
    const error = await caught(
      Application.create({
        metadata: {
          version: 1,
          providers: {},
          resolutionOrder: [],
          extensions: { messaging: { consumers: [{ token: t('Ghost'), queue: 'q', handlers: [handler('handle')] }] } },
        },
        plugins: [MessagingPlugin.configure({ driver: new MemoryDriver() })],
        logger: memoryLogger(),
        shutdown: { signals: false },
      }),
    )
    expect(String((error as Error).cause ?? error)).toContain('no provider is registered for src/app.ts#Ghost')
  })

  it.each([
    [{ driver: {} as never }, '"driver" must be a messaging driver'],
    [{ defaults: { concurrency: -1 } }, 'defaults.concurrency must be a positive integer'],
    [{ defaults: { requeueDelay: Number.NaN } }, 'defaults.requeueDelay must be'],
    [{ defaults: { deadLetter: 'dlq' as never } }, 'defaults.deadLetter must be a function'],
    [{ defaults: { retry: { attempts: 1.5 } } }, 'MessagingPlugin defaults.retry: "attempts" must be an integer'],
  ])('rejects invalid plugin options (%#)', async (options, message) => {
    const error = await bootError([{ class: Consumer, queue: 'q', handlers: [handler('handle')] }], options)
    expect(error.message).toContain(message)
  })

  it('accepts options computed from the container', async () => {
    const driver = new MemoryDriver()
    const app = await Application.create({
      metadata: messagingMetadata([{ class: Consumer, queue: 'q', handlers: [handler('handle')] }]),
      plugins: [MessagingPlugin.configure(container => ({ driver: container.get<MemoryDriver>('driver') }))],
      providers: { driver },
      logger: memoryLogger(),
      shutdown: { signals: false },
    })
    await app.start()
    expect(driver.connected).toBe(true)
    await app.stop()
  })

  it('works without messaging metadata (publish-only application)', async () => {
    const driver = new MemoryDriver()
    const app = await Application.create({
      metadata: { version: 1, providers: {}, resolutionOrder: [] },
      plugins: [MessagingPlugin.configure({ driver })],
      logger: memoryLogger(),
      shutdown: { signals: false },
    })
    await app.start()
    await app.get<{ publish(q: string, p: unknown): Promise<unknown> }>(MessagingTokens.MessageBroker).publish('q', 1)
    expect(driver.published('q')).toHaveLength(1)
    await app.stop()
  })

  it('closes the driver when connect fails', async () => {
    const driver = new MemoryDriver()
    driver.fail('connect', { error: new Error('broker down') })
    const error = await caught(
      Application.create({
        metadata: messagingMetadata([]),
        plugins: [MessagingPlugin.configure({ driver })],
        logger: memoryLogger(),
        shutdown: { signals: false },
      }),
    )
    expect(String((error as Error).cause)).toContain('broker down')
    expect(driver.connected).toBe(false)
  })

  it('unsubscribes every consumer when one subscription fails', async () => {
    class Other {
      handle() {}
    }
    const driver = new MemoryDriver()
    driver.fail('subscribe', { queue: 'b', error: new Error('no such queue') })
    const app = await Application.create({
      metadata: messagingMetadata([
        { class: Consumer, queue: 'a', handlers: [handler('handle')] },
        { class: Other, queue: 'b', handlers: [handler('handle')] },
      ]),
      plugins: [MessagingPlugin.configure({ driver })],
      logger: memoryLogger(),
      shutdown: { signals: false },
    })
    const error = await caught(app.start())
    expect(String((error as Error).cause)).toContain('no such queue')
    expect(app.state).toBe('failed')
    expect(driver.connected).toBe(false)
    // nothing consumes "a" anymore
    driver.reset()
  })
})
