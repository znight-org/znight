/**
 * Runtime behaviour on a compiled application (RFC 0011 §5.7–§5.13): errors of inline and detached
 * listeners, `emit()`, `onError`, hooks, `recordEvents()`, lifecycle errors and the drain on stop.
 */
import type { ErrorReportEvent, EventListenerEvent, EventPublishEvent, Plugin, ZnightMetadata } from '@znight/core'
import type { EventErrorInfo } from '../../src/index.ts'

import { Application, silentLogger, ZnightError } from '@znight/core'
import { TestApp } from '@znight/testing'

import { EventPublisher, EventsPlugin } from '../../src/index.ts'
import { recordEvents } from '../../src/testing/index.ts'
import { cleanupApps, compileAndLoad, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const APP: Readonly<Record<string, string>> = {
  'src/log.ts': `export const log: string[] = []
export const gate: { release?: () => void } = {}
`,
  'src/events.ts': `export class Boom {
  constructor(readonly where: 'inline' | 'detached' | 'none') {}
}
export class Slow {}
export class Late {}
`,
  'src/listeners.ts': `import { OnEvent } from '@znight/events'
import { Boom, Late, Slow } from './events.ts'
import { gate, log } from './log.ts'

export class DomainError extends Error {}

export class First {
  @OnEvent({ order: 1 })
  run(event: Boom): void {
    log.push('first')
    if (event.where === 'inline') throw new DomainError('inline failed')
  }
}

export class Second {
  @OnEvent({ order: 2 })
  run(_event: Boom): void {
    log.push('second')
  }
}

export class Later {
  @OnEvent({ detached: true })
  async fail(event: Boom): Promise<void> {
    log.push('detached-fail')
    if (event.where === 'detached') throw new Error('detached failed')
  }

  @OnEvent({ detached: true, order: 5 })
  ok(_event: Boom): void {
    log.push('detached-ok')
  }

  @OnEvent({ detached: true })
  slow(_event: Slow): Promise<void> {
    log.push('slow-start')
    return new Promise(resolve => {
      gate.release = () => {
        log.push('slow-end')
        resolve()
      }
    })
  }
}

export class Tracked {
  disposed = false

  @OnEvent({ detached: true })
  async late(_event: Late): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 20))
    log.push(this.disposed ? 'late-after-dispose' : 'late-ran')
  }

  [Symbol.dispose](): void {
    this.disposed = true
  }
}
`,
}

let metadata: ZnightMetadata
let mod: {
  log: string[]
  gate: { release?: () => void }
  Boom: new (where: string) => object
  Slow: new () => object
  Late: new () => object
  DomainError: new (message: string) => Error
}

beforeAll(async () => {
  const app = tempApp(APP)
  metadata = (await compileAndLoad(app)).metadata
  mod = {
    ...((await import(app.path('src/log.ts'))) as object),
    ...((await import(app.path('src/events.ts'))) as object),
    ...((await import(app.path('src/listeners.ts'))) as object),
  } as typeof mod
})

describe('errors', () => {
  it('rejects publish() with the first inline error, unchanged, and skips the rest', async () => {
    mod.log.length = 0
    const errors: unknown[] = []
    const plugin = EventsPlugin.configure({ onError: error => errors.push(error) })
    await using test = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    const publisher = test.app.container.get(EventPublisher)
    const failure = await publisher.publish(new mod.Boom('inline')).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(mod.DomainError)
    await plugin.idle()
    expect(mod.log).toEqual(['first'])
    expect(errors).toEqual([])
  })

  it('reports detached errors to onError, isolated, after publish() resolved', async () => {
    mod.log.length = 0
    const errors: [unknown, EventErrorInfo][] = []
    const plugin = EventsPlugin.configure({ onError: (error, info) => errors.push([error, info]) })
    await using test = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    const recorder = recordEvents(test)
    await test.app.container.get(EventPublisher).publish(new mod.Boom('detached'))
    expect(mod.log).toEqual(['first', 'second'])
    await recorder.idle()
    expect(mod.log).toEqual(['first', 'second', 'detached-fail', 'detached-ok'])
    expect(errors.map(([error, info]) => [(error as Error).message, info.listener, info.detached, info.mode])).toEqual([
      ['detached failed', 'Later.fail', true, 'publish'],
    ])
    expect(recorder.of(mod.Boom)).toHaveLength(1)
    expect(recorder.failures().map(failure => failure.listener)).toEqual(['Later.fail'])
  })

  it('reports every error of emit() to onError', async () => {
    mod.log.length = 0
    const errors: EventErrorInfo[] = []
    const plugin = EventsPlugin.configure({ onError: (_error, info) => errors.push(info) })
    await using test = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    test.app.container.get(EventPublisher).emit(new mod.Boom('inline'))
    expect(mod.log).toEqual([])
    await new Promise(resolve => setImmediate(resolve))
    await plugin.idle()
    expect(mod.log).toEqual(['first'])
    expect(errors.map(info => [info.listener, info.mode])).toEqual([['First.run', 'emit']])
  })

  it('reports the detached errors of emit() with mode emit', async () => {
    mod.log.length = 0
    const errors: EventErrorInfo[] = []
    const plugin = EventsPlugin.configure({ onError: (_error, info) => errors.push(info) })
    await using test = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    test.app.container.get(EventPublisher).emit(new mod.Boom('detached'))
    await new Promise(resolve => setImmediate(resolve))
    await plugin.idle()
    expect(mod.log).toEqual(['first', 'second', 'detached-fail', 'detached-ok'])
    expect(errors.map(info => [info.listener, info.detached, info.mode])).toEqual([['Later.fail', true, 'emit']])
  })
  it('waits for an async onError before the work counts as done', async () => {
    mod.log.length = 0
    const reported: string[] = []
    const plugin = EventsPlugin.configure({
      onError: async (_error, info) => {
        await new Promise(resolve => setTimeout(resolve, 30))
        reported.push(`${info.listener} ${info.mode}`)
      },
    })
    await using test = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    const publisher = test.app.container.get(EventPublisher)
    await publisher.publish(new mod.Boom('detached'))
    await plugin.idle()
    expect(reported).toEqual(['Later.fail publish'])
    publisher.emit(new mod.Boom('inline'))
    await test.app.stop()
    expect(reported).toEqual(['Later.fail publish', 'First.run emit'])
  })
})

describe('hooks', () => {
  it('produces events:publish and events:listener', async () => {
    mod.log.length = 0
    const plugin = EventsPlugin.configure()
    await using test = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    const publications: EventPublishEvent[] = []
    const listeners: EventListenerEvent[] = []
    test.app.hooks.on('events:publish', record => publications.push(record))
    test.app.hooks.on('events:listener', record => listeners.push(record))
    await test.app.container
      .get(EventPublisher)
      .publish(new mod.Boom('inline'))
      .catch(() => undefined)
    expect(publications.map(p => [p.event, p.mode, p.inline, p.detached, p.failedListener])).toEqual([
      ['Boom', 'publish', 2, 2, 'First.run'],
    ])
    expect(listeners.map(l => [l.listener, l.detached, l.error instanceof mod.DomainError])).toEqual([
      ['First.run', false, true],
    ])
  })
})

describe('error:report', () => {
  async function reporting() {
    const plugin = EventsPlugin.configure({ onError: () => undefined })
    const test = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    const reports: ErrorReportEvent[] = []
    test.app.hooks.on('error:report', report => {
      reports.push(report)
    })
    return { plugin, test, reports, publisher: test.app.container.get(EventPublisher) }
  }

  it('reports a detached listener failure once, even with an onError handler', async () => {
    mod.log.length = 0
    const { plugin, test, reports, publisher } = await reporting()
    await using _ = test
    const event = new mod.Boom('detached')
    await publisher.publish(event)
    await plugin.idle()
    expect(reports).toHaveLength(1)
    const report = reports[0] as ErrorReportEvent
    expect((report.error as Error).message).toBe('detached failed')
    expect(report.source).toBe('events')
    expect(report.operation).toBe('Boom Later.fail')
    expect(report.requestId).toBeUndefined()
    expect(report.tags).toEqual({ event: 'Boom', listener: 'Later.fail', detached: true, mode: 'publish' })
    expect(report.context).toBe(event)
  })

  it('reports the inline failure of emit(), not the inline failure of publish() (its caller gets it)', async () => {
    mod.log.length = 0
    const { plugin, test, reports, publisher } = await reporting()
    await using _ = test
    expect(await publisher.publish(new mod.Boom('inline')).catch((error: unknown) => error)).toBeInstanceOf(
      mod.DomainError,
    )
    await plugin.idle()
    expect(reports).toEqual([])
    publisher.emit(new mod.Boom('inline'))
    await new Promise(resolve => setImmediate(resolve))
    await plugin.idle()
    expect(reports.map(report => [report.operation, report.tags])).toEqual([
      ['Boom First.run', { event: 'Boom', listener: 'First.run', detached: false, mode: 'emit' }],
    ])
    await publisher.publish(new mod.Boom('none'))
    await plugin.idle()
    expect(reports).toHaveLength(1)
  })
})

describe('lifecycle', () => {
  it('waits for detached listeners on stop', async () => {
    mod.log.length = 0
    const app = await Application.create({ metadata, plugins: [EventsPlugin.configure()], logger: silentLogger })
    await app.start()
    await app.container.get(EventPublisher).publish(new mod.Slow())
    await new Promise(resolve => setImmediate(resolve))
    expect(mod.log).toEqual(['slow-start'])
    const stopped = app.stop()
    await Promise.resolve()
    mod.gate.release?.()
    await stopped
    expect(mod.log).toEqual(['slow-start', 'slow-end'])
    const late = await app.container
      .get(EventPublisher)
      .publish(new mod.Slow())
      .catch((error: unknown) => error)
    expect(late).toBeInstanceOf(ZnightError)
    expect((late as ZnightError).code).toBe('ZNIGHT021')
  })

  it('drains detached listeners before disposing the providers of an application never started', async () => {
    mod.log.length = 0
    const errors: unknown[] = []
    const app = await Application.create({
      metadata,
      plugins: [EventsPlugin.configure({ onError: error => errors.push(error) })],
      logger: silentLogger,
    })
    const publisher = app.container.get(EventPublisher)
    await publisher.publish(new mod.Late())
    publisher.emit(new mod.Late())
    await app.stop()
    expect(errors).toEqual([])
    expect(mod.log).toEqual(['late-ran', 'late-ran'])
  })

  it('a timed-out dispose of a shared instance leaves the next application alone', async () => {
    mod.log.length = 0
    const plugin = EventsPlugin.configure({ drainTimeoutMs: 200 })
    const warnings: unknown[] = []
    const logger = { ...silentLogger, warn: (message: string, context?: unknown) => warnings.push([message, context]) }
    // listed first, so it stops after EventsPlugin: its emit() is work started after onStop
    const late: Plugin = {
      name: 'late',
      async onStop(ctx) {
        ctx.container.get(EventPublisher).emit(new mod.Slow())
        await new Promise(resolve => setImmediate(resolve)) // its listener starts before the providers are disposed
      },
    }
    const shutdown = { signals: false, hookTimeoutMs: 50, timeoutMs: 120 } as const
    const first = await Application.create({ metadata, plugins: [late, plugin], logger, shutdown })
    await first.start()
    await first.container.get(EventPublisher).publish(new mod.Slow()) // never settles
    await new Promise(resolve => setImmediate(resolve))
    const failure = (await first.stop().catch((error: unknown) => error)) as { errors: readonly Error[] }
    expect(failure.errors.map(error => error.message)).toEqual([
      expect.stringContaining('Plugin "events" onStop() timed out'),
      expect.stringContaining('Plugin "events" onDispose() timed out'),
    ])
    // onDispose waits for the emit() only, not again for the listener left over by onStop
    expect(warnings).toContainEqual([
      'Events: waiting for 1 listener(s) started after onStop',
      { listeners: ['emit Slow'] },
    ])

    await using second = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    await new Promise(resolve => setTimeout(resolve, 300)) // the first dispose has ended meanwhile
    expect(plugin.state).toBe('running')
    await second.app.container.get(EventPublisher).publish(new mod.Boom('none'))
  })
})
