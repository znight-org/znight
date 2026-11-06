/**
 * Runtime behaviour on a compiled application (RFC 0011 §5.7–§5.13): errors of inline and detached
 * listeners, `emit()`, `onError`, hooks, `recordEvents()`, lifecycle errors and the drain on stop.
 */
import type { EventListenerEvent, EventPublishEvent, ZnightMetadata } from '@znight/core'
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
`,
  'src/listeners.ts': `import { OnEvent } from '@znight/events'
import { Boom, Slow } from './events.ts'
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
`,
}

let metadata: ZnightMetadata
let mod: {
  log: string[]
  gate: { release?: () => void }
  Boom: new (where: string) => object
  Slow: new () => object
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
})
