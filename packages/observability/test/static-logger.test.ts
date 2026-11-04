import type { ObservabilityOptions, StaticLogger } from '../src/index.ts'

import { Application, ErrorCode, ZnightError } from '@znight/core'

import { getLogger, Logger, ObservabilityPlugin, REQUEST_ID_TOKEN, setFallbackLogger } from '../src/index.ts'
import { resetStaticLoggers, STATIC_LOG_BUFFER_SIZE } from '../src/logging/static.ts'
import { capture, caught, type Entry, meta } from './helpers.ts'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

/** A started application whose logger writes to memory. */
async function start(
  logging: ObservabilityOptions['logging'] = {},
): Promise<{ readonly app: Application; readonly entries: Entry[] }> {
  const { stream, entries } = capture()
  const plugin = ObservabilityPlugin.configure({
    logging: { base: null, requests: false, messages: false, jobs: false, ...logging, destination: stream },
    metrics: false,
    tracing: false,
  })
  const app = await Application.create({ metadata: meta({}), plugins: [plugin], shutdown: { signals: false } })
  return { app, entries }
}

function messages(entries: readonly Entry[]): (string | undefined)[] {
  return entries.map(entry => entry.msg)
}

/** Entries written by static loggers (the framework's own entries have `component: 'znight'`). */
function staticEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter(entry => entry['logger'] !== undefined)
}

const apps: Application[] = []

beforeEach(() => resetStaticLoggers())
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop()
  resetStaticLoggers()
})

async function started(logging?: ObservabilityOptions['logging']): Promise<{ app: Application; entries: Entry[] }> {
  const result = await start(logging)
  apps.push(result.app)
  return result
}

describe('getLogger()', () => {
  it('writes to the application logger with the logger name and bindings', async () => {
    const { entries } = await started()
    const log = getLogger('UserService', { component: 'users' })
    expect(log.name).toBe('UserService')
    log.info('user created', { userId: 1 })
    log.warn({ orderId: 2 }, 'order delayed')
    log.error('failed', new Error('boom'))
    const [created, delayed, failed] = staticEntries(entries)
    expect(created).toMatchObject({
      level: 30,
      logger: 'UserService',
      component: 'users',
      userId: 1,
      msg: 'user created',
    })
    expect(delayed).toMatchObject({ level: 40, logger: 'UserService', orderId: 2, msg: 'order delayed' })
    expect(failed).toMatchObject({ level: 50, logger: 'UserService', err: { message: 'boom', type: 'Error' } })
  })

  it('works when created at module load, before any application exists', async () => {
    const log = getLogger('EarlyService')
    const { entries } = await started()
    log.info('after bootstrap')
    expect(staticEntries(entries)).toMatchObject([{ logger: 'EarlyService', msg: 'after bootstrap' }])
  })

  it('buffers the entries written before the application exists and writes them once it does', async () => {
    const log = getLogger('EarlyService')
    const before = Date.now()
    log.info('during module load', { step: 1 })
    log.debug('too verbose for the application')
    log.warn({ step: 2 }, 'still early')
    const { entries } = await started()
    const early = staticEntries(entries)
    expect(messages(early)).toEqual(['during module load', 'still early'])
    expect(early[0]).toMatchObject({ level: 30, logger: 'EarlyService', step: 1 })
    expect(early[1]).toMatchObject({ level: 40, step: 2 })
    // the time of the call is kept in `loggedAt` (`time` is when the entry was written)
    const loggedAt = Date.parse(String(early[0]?.['loggedAt']))
    expect(loggedAt).toBeGreaterThanOrEqual(before)
    expect(loggedAt).toBeLessThanOrEqual(Date.now())
  })

  it('writes the buffered entries to the first application only', async () => {
    getLogger('EarlyService').info('early')
    const first = await started()
    const second = await started()
    expect(messages(staticEntries(first.entries))).toEqual(['early'])
    expect(staticEntries(second.entries)).toEqual([])
  })

  it('bounds the buffer, keeps the first entries and reports how many were dropped', async () => {
    const log = getLogger('Chatty')
    for (let index = 0; index < STATIC_LOG_BUFFER_SIZE + 25; index++) log.info(`entry ${index}`)
    const { entries } = await started()
    const written = entries.filter(entry => entry['logger'] === 'Chatty')
    expect(written).toHaveLength(STATIC_LOG_BUFFER_SIZE)
    expect(written[0]?.msg).toBe('entry 0')
    expect(written.at(-1)?.msg).toBe(`entry ${STATIC_LOG_BUFFER_SIZE - 1}`)
    const dropped = entries.find(entry => entry['dropped'] !== undefined)
    expect(dropped).toMatchObject({ level: 40, dropped: 25, component: 'znight' })
  })

  it('follows the level of the application logger', async () => {
    const { entries } = await started({ level: 'warn' })
    const log = getLogger('Quiet')
    expect(log.isLevelEnabled('info')).toBe(false)
    expect(log.isLevelEnabled('warn')).toBe(true)
    log.info('dropped')
    log.debug('dropped')
    log.log('error', 'kept')
    log.fatal('kept too')
    expect(messages(staticEntries(entries))).toEqual(['kept', 'kept too'])
  })

  it('does not evaluate the context of a disabled level', async () => {
    let mixins = 0
    await started({ level: 'warn', mixin: () => ({ mixins: ++mixins }) })
    const log = getLogger('Quiet')
    for (let index = 0; index < 100; index++) log.debug('off', { index })
    expect(mixins).toBe(0)
    log.warn('on')
    expect(mixins).toBe(1)
  })

  it('creates child loggers with merged bindings', async () => {
    const { entries } = await started()
    const child = getLogger('Billing', { region: 'eu' }).child({ invoice: 7 })
    expect(child.name).toBe('Billing')
    child.info('issued')
    expect(staticEntries(entries)[0]).toMatchObject({ logger: 'Billing', region: 'eu', invoice: 7, msg: 'issued' })
  })

  it('adds the request id and the scope fields inside a request scope', async () => {
    const { app, entries } = await started({ scopeFields: { requestId: REQUEST_ID_TOKEN, tenant: 'tenant' } })
    const log = getLogger('Orders')
    await app.container.runInScope(async () => {
      await Promise.resolve()
      log.info('in request')
    }, [
      [REQUEST_ID_TOKEN, 'req-42'],
      ['tenant', 'acme'],
    ])
    log.info('outside')
    const [inside, outside] = staticEntries(entries)
    expect(inside).toMatchObject({ requestId: 'req-42', tenant: 'acme', msg: 'in request' })
    expect(outside).not.toHaveProperty('requestId')
  })

  it('writes to the most recently created application, or to the one whose request scope is active', async () => {
    const first = await started()
    const second = await started()
    const log = getLogger('Shared')
    log.info('latest')
    await first.app.container.runInScope(() => log.info('in a request of the first'), [[REQUEST_ID_TOKEN, 'req-1']])
    expect(messages(staticEntries(first.entries))).toEqual(['in a request of the first'])
    expect(staticEntries(first.entries)[0]).toMatchObject({ requestId: 'req-1' })
    expect(messages(staticEntries(second.entries))).toEqual(['latest'])
  })

  it('goes back to the previous application once the latest one stops', async () => {
    const first = await started()
    const second = await start()
    const log = getLogger('Shared')
    await second.app.stop()
    log.info('after the second stopped')
    expect(messages(staticEntries(first.entries))).toEqual(['after the second stopped'])
    expect(staticEntries(second.entries)).toEqual([])
  })

  it('keeps writing to the last stopped application while no other one runs', async () => {
    const { app, entries } = await start()
    const log = getLogger('Shutdown')
    await app.stop()
    log.info('after stop')
    expect(messages(staticEntries(entries))).toEqual(['after stop'])
    expect(app.state).toBe('stopped') // still referenced: its logger stays the target
    // a new application takes over
    const next = await started()
    log.info('next')
    expect(messages(staticEntries(next.entries))).toEqual(['next'])
  })

  it('goes back to the last stopped application when one fails to start', async () => {
    const { app, entries } = await start()
    await app.stop()
    const failing = ObservabilityPlugin.configure({ logging: { level: 'nope' as never }, metrics: false })
    await caught(() => Application.create({ metadata: meta({}), plugins: [failing], shutdown: { signals: false } }))
    getLogger('Survivor').info('still delivered')
    expect(messages(staticEntries(entries))).toEqual(['still delivered'])
    expect(app.state).toBe('stopped')
  })

  it('writes to the fallback logger when no application runs', async () => {
    const fallback = capture()
    getLogger('Early').info('buffered before the fallback')
    setFallbackLogger(new Logger({ base: null, destination: fallback.stream }))
    getLogger('Unit').info('no application')
    expect(messages(staticEntries(fallback.entries))).toEqual(['buffered before the fallback', 'no application'])
    // a running application still wins
    const { entries } = await started()
    getLogger('Unit').info('with an application')
    expect(messages(staticEntries(entries))).toEqual(['with an application'])
    expect(fallback.entries).toHaveLength(2)
  })

  it('is silenced by a silent fallback logger (unit tests without an application)', async () => {
    setFallbackLogger(new Logger({ level: 'silent' }))
    const log = getLogger('UseCase')
    expect(log.isLevelEnabled('fatal')).toBe(false)
    log.error('not written anywhere')
    // nothing was buffered for a later application
    const { entries } = await started()
    expect(staticEntries(entries)).toEqual([])
  })

  it('reports every level as enabled before any application exists', () => {
    const log = getLogger('Early')
    expect(log.isLevelEnabled('trace')).toBe(true)
  })

  it('rejects an empty name', async () => {
    const error = await caught(() => getLogger(''))
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
  })

  it('returns a logger usable through its interface', () => {
    const log: StaticLogger = getLogger('Typed')
    expect(typeof log.trace).toBe('function')
    expect(typeof log.child).toBe('function')
  })
})
