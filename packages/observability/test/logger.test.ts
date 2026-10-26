import type { LogTransport } from '../src/index.ts'

import { Writable } from 'node:stream'
import { Container, ErrorCode, ZnightError } from '@znight/core'

import {
  cloudwatchTransport,
  LEVEL_VALUES,
  Logger,
  prettyTransport,
  REQUEST_ID_TOKEN,
  Tracer,
  toCoreLogger,
} from '../src/index.ts'
import { loadOptionalPeer } from '../src/internal/optional.ts'
import { capture, type Entry, memoryTracing, meta } from './helpers.ts'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

function logger(options: ConstructorParameters<typeof Logger>[0] = {}): { log: Logger; entries: Entry[] } {
  const { stream, entries } = capture()
  return { log: new Logger({ destination: stream, ...options }), entries }
}

describe('Logger', () => {
  const savedLevel = process.env['LOG_LEVEL']
  beforeEach(() => {
    delete process.env['LOG_LEVEL']
  })
  afterEach(() => {
    if (savedLevel === undefined) delete process.env['LOG_LEVEL']
    else process.env['LOG_LEVEL'] = savedLevel
  })

  it('writes one JSON entry per call with the message and the context', () => {
    const { log, entries } = logger()
    log.info('User created', { userId: 42 })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 30, msg: 'User created', userId: 42 })
    expect(typeof entries[0]?.['time']).toBe('number')
    expect(entries[0]?.['pid']).toBe(process.pid)
  })

  it('accepts the pino argument order and errors as details', () => {
    const { log, entries } = logger()
    log.warn({ orderId: 'o1' }, 'Order delayed')
    log.error('Payment failed', new TypeError('declined'))
    log.error(new Error('raw'))
    log.info({ only: 'context' })
    log.info('no context')
    log.info('primitive details', 42 as never)
    expect(entries[0]).toMatchObject({ level: 40, msg: 'Order delayed', orderId: 'o1' })
    expect(entries[1]).toMatchObject({
      level: 50,
      msg: 'Payment failed',
      err: { type: 'TypeError', message: 'declined' },
    })
    expect(JSON.stringify(entries[1]?.['err'])).toContain('TypeError: declined')
    expect(entries[2]).toMatchObject({ msg: 'raw', err: { message: 'raw' } })
    expect(entries[3]).toMatchObject({ only: 'context' })
    expect(entries[3]?.msg).toBeUndefined()
    expect(entries[4]).toMatchObject({ msg: 'no context' })
    expect(entries[5]).toMatchObject({ msg: 'primitive details', details: 42 })
  })

  it('serializes errors under `err` and `error`, including causes', () => {
    const { log, entries } = logger()
    log.error('failed', { error: new Error('outer', { cause: new Error('inner') }) })
    const error = entries[0]?.['error'] as { message: string; stack: string }
    expect(error.message).toBe('outer: inner')
    expect(error.stack).toContain('caused by: Error: inner')
  })

  it('does not interpolate printf placeholders in messages', () => {
    const { log, entries } = logger()
    log.info('100%s done %d', { a: 1 })
    log.info('50%s')
    expect(entries.map(entry => entry.msg)).toEqual(['100%s done %d', '50%s'])
  })

  it('filters by level (default info, LOG_LEVEL, option) and changes level at runtime', () => {
    const { log, entries } = logger()
    expect(log.level).toBe('info')
    log.debug('hidden')
    log.trace('hidden')
    log.fatal('shown')
    expect(entries.map(entry => entry.msg)).toEqual(['shown'])
    expect(log.isLevelEnabled('debug')).toBe(false)
    log.level = 'trace'
    log.trace('now shown')
    expect(entries.at(-1)).toMatchObject({ level: 10, msg: 'now shown' })

    process.env['LOG_LEVEL'] = 'WARN'
    expect(logger().log.level).toBe('warn')
    expect(logger({ level: 'error' }).log.level).toBe('error')

    const silent = logger({ level: 'silent' })
    silent.log.fatal('nothing')
    expect(silent.entries).toHaveLength(0)
  })

  it('logs at a level chosen at runtime', () => {
    const { log, entries } = logger({ level: 'trace' })
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) log.log(level, level)
    expect(entries.map(entry => entry.level)).toEqual([10, 20, 30, 40, 50, 60])
    expect(LEVEL_VALUES.warn).toBe(40)
  })

  it('rejects invalid levels with ZNIGHT005', () => {
    const error = (() => {
      try {
        logger({ level: 'verbose' as never })
      } catch (thrown) {
        return thrown
      }
    })()
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
    expect((error as ZnightError).message).toContain('verbose')
    const { log } = logger()
    expect(() => {
      log.level = 'loud' as never
    }).toThrow(/Invalid logger level/)
  })

  it('creates children with bindings, level and message prefix', () => {
    const { log, entries } = logger()
    const child = log.child({ component: 'billing' })
    child.info('charged', { amount: 10 })
    expect(entries[0]).toMatchObject({ component: 'billing', amount: 10, msg: 'charged' })
    expect(child.bindings()).toEqual({ component: 'billing' })

    const verbose = log.child({ component: 'debugger' }, { level: 'debug', msgPrefix: '[dbg] ' })
    verbose.debug('visible')
    log.debug('still hidden')
    expect(entries[1]).toMatchObject({ component: 'debugger', msg: '[dbg] visible', level: 20 })
    expect(entries).toHaveLength(2)
    expect(child).toBeInstanceOf(Logger)
    expect(child.pino).not.toBe(log.pino)
  })

  it('redacts paths (array and object forms)', () => {
    const censored = logger({ redact: ['password', 'user.token', 'cards[*].number'] })
    censored.log.info('login', {
      password: 'p',
      user: { name: 'ada', token: 't' },
      cards: [{ number: '4242' }, { number: '1111' }],
    })
    expect(censored.entries[0]).toMatchObject({
      password: '[Redacted]',
      user: { name: 'ada', token: '[Redacted]' },
      cards: [{ number: '[Redacted]' }, { number: '[Redacted]' }],
    })

    const removed = logger({ redact: { paths: ['secret'], remove: true } })
    removed.log.info('x', { secret: 's', kept: 1 })
    expect(removed.entries[0]).not.toHaveProperty('secret')
    expect(removed.entries[0]).toMatchObject({ kept: 1 })

    const custom = logger({ redact: { paths: ['apiKey'], censor: '***' } })
    custom.log.info('x', { apiKey: 'k' })
    expect(custom.entries[0]).toMatchObject({ apiKey: '***' })
  })

  it('supports name, base, messageKey, timestamp and serializers', () => {
    const { log, entries } = logger({
      name: 'api',
      base: { service: 'users' },
      messageKey: 'message',
      timestamp: 'iso',
      serializers: { user: (user: { name: string }) => ({ name: user.name }) },
    })
    log.info('hello', { user: { name: 'ada', password: 'p' } })
    expect(entries[0]).toMatchObject({ name: 'api', service: 'users', message: 'hello', user: { name: 'ada' } })
    expect(entries[0]).not.toHaveProperty('pid')
    expect(new Date(entries[0]?.['time'] as string).toISOString()).toBe(entries[0]?.['time'] as string)

    const bare = logger({ base: null, timestamp: false })
    bare.log.info('bare')
    expect(Object.keys(bare.entries[0] as object).sort()).toEqual(['level', 'msg'])
  })

  it('applies raw pino options last', () => {
    const { log, entries } = logger({ pino: { messageKey: 'text' } })
    log.info('raw')
    expect(entries[0]).toMatchObject({ text: 'raw' })
  })

  it('adds the user mixin to every entry', () => {
    let counter = 0
    const { log, entries } = logger({ mixin: () => ({ sequence: ++counter }) })
    log.info('a')
    log.child({ c: 1 }).info('b')
    expect(entries.map(entry => entry['sequence'])).toEqual([1, 2])
  })

  describe('context enrichment', () => {
    it('adds requestId from the active request scope', async () => {
      const container = Container.create(meta({}))
      await container.init()
      const { log, entries } = logger({ scope: container })
      log.info('outside')
      await container.runInScope(async () => {
        await Promise.resolve()
        log.info('inside')
        log.child({ component: 'c' }).info('child inside')
        log.info('explicit wins', { requestId: 'explicit' })
      }, [[REQUEST_ID_TOKEN, 'req-42']])
      await container.runInScope(() => log.info('scope without request id'))
      expect(entries[0]).not.toHaveProperty('requestId')
      expect(entries[1]).toMatchObject({ msg: 'inside', requestId: 'req-42' })
      expect(entries[2]).toMatchObject({ msg: 'child inside', requestId: 'req-42', component: 'c' })
      expect(entries[3]).toMatchObject({ requestId: 'explicit' })
      expect(entries[4]).not.toHaveProperty('requestId')
    })

    it('reads custom scope fields and skips null values', async () => {
      const container = Container.create(meta({}))
      await container.init()
      const { log, entries } = logger({
        scope: container,
        scopeFields: { tenant: 'src/tenant.ts#TenantId', user: 'src/user.ts#UserId' },
      })
      await container.runInScope(
        () => log.info('x'),
        [
          ['src/tenant.ts#TenantId', 'acme'],
          ['src/user.ts#UserId', null],
        ],
      )
      expect(entries[0]).toMatchObject({ tenant: 'acme' })
      expect(entries[0]).not.toHaveProperty('user')
      expect(entries[0]).not.toHaveProperty('requestId')
    })

    it('adds traceId and spanId of the active span', async () => {
      const { provider } = memoryTracing()
      const tracer = new Tracer({ tracerProvider: provider })
      const { log, entries } = logger()
      let ids: { traceId: string; spanId: string } | undefined
      await tracer.withSpan('outer', async span => {
        ids = { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId }
        await Promise.resolve()
        log.info('in span')
      })
      log.info('after span')
      expect(entries[0]).toMatchObject({ msg: 'in span', ...ids })
      expect(entries[1]).not.toHaveProperty('traceId')

      const disabled = logger({ traceContext: false })
      tracer.withSpan('x', () => disabled.log.info('no trace'))
      expect(disabled.entries[0]).not.toHaveProperty('traceId')
    })
  })

  describe('transports', () => {
    function recording(
      name: string,
      level?: LogTransport['level'],
    ): LogTransport & { lines: string[]; calls: string[] } {
      const lines: string[] = []
      const calls: string[] = []
      return {
        name,
        lines,
        calls,
        ...(level === undefined ? {} : { level }),
        stream: { write: line => lines.push(line) },
        flush: () => {
          calls.push('flush')
          return Promise.resolve()
        },
        close: () => {
          calls.push('close')
          return Promise.resolve()
        },
      }
    }

    it('fans out to several transports with their own levels', () => {
      const all = recording('all')
      const errors = recording('errors', 'error')
      const log = new Logger({ level: 'debug', transport: [all, errors] })
      log.debug('d')
      log.info('i')
      log.error('e')
      expect(all.lines.map(line => JSON.parse(line).msg)).toEqual(['d', 'i', 'e'])
      expect(errors.lines.map(line => JSON.parse(line).msg)).toEqual(['e'])
    })

    it('uses a single transport with a level through a multistream', () => {
      const warn = recording('warn', 'warn')
      const log = new Logger({ transport: warn })
      log.info('i')
      log.warn('w')
      expect(warn.lines.map(line => JSON.parse(line).msg)).toEqual(['w'])
    })

    it('combines transports and a raw destination', () => {
      const one = recording('one')
      const { stream, entries } = capture()
      const log = new Logger({ transport: one, destination: stream })
      log.info('both')
      expect(one.lines).toHaveLength(1)
      expect(entries).toHaveLength(1)
    })

    it('flushes and closes the transports, shared by children; never rejects', async () => {
      const ok = recording('ok')
      const failing: LogTransport = {
        name: 'failing',
        stream: { write: () => undefined },
        flush: () => Promise.reject(new Error('flush failed')),
        close: () => Promise.reject(new Error('close failed')),
      }
      const log = new Logger({ transport: [ok, failing] })
      await log.child({ a: 1 }).flush()
      await log.close()
      expect(ok.calls).toEqual(['flush', 'flush', 'close'])
    })

    it('flushes a raw destination when it supports it', async () => {
      let flushed = 0
      const destination = {
        write: () => undefined,
        flush: (callback: () => void) => {
          flushed++
          callback()
        },
      }
      await new Logger({ destination }).flush()
      expect(flushed).toBe(1)
      await new Logger({ destination: { write: () => undefined } }).flush()
    })

    it('writes CloudWatch / Lambda JSON (timestamp, upper-case level, message)', () => {
      const lines: string[] = []
      const transport = { ...cloudwatchTransport(), stream: { write: (line: string) => lines.push(line) } }
      const log = new Logger({ transport })
      log.info('stored', { orderId: 'o1' })
      log.error('failed', new Error('x'))
      const [info, error] = lines.map(line => JSON.parse(line))
      expect(info).toMatchObject({ level: 'INFO', message: 'stored', orderId: 'o1' })
      expect(info).not.toHaveProperty('pid')
      expect(info).not.toHaveProperty('msg')
      expect(new Date(info.timestamp).toISOString()).toBe(info.timestamp)
      expect(error).toMatchObject({ level: 'ERROR', message: 'failed', err: { message: 'x' } })
      expect(cloudwatchTransport().name).toBe('cloudwatch')
      expect(cloudwatchTransport({ includeProcessInfo: true }).loggerOptions).not.toHaveProperty('base')
      expect(cloudwatchTransport({ level: 'warn' }).level).toBe('warn')
    })

    it('pretty prints through pino-pretty', async () => {
      const chunks: string[] = []
      const destination = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(String(chunk))
          callback()
        },
      })
      const transport = prettyTransport({ colorize: false, options: { destination } })
      const log = new Logger({ transport })
      log.info('pretty hello', { userId: 7 })
      await log.flush()
      await new Promise(resolve => setTimeout(resolve, 20))
      const output = chunks.join('')
      expect(output).toContain('INFO')
      expect(output).toContain('pretty hello')
      expect(output).toContain('userId: 7')
      expect(output).not.toContain('"level"')
    })

    it('accepts pretty: true / options as a shortcut', () => {
      expect(() => new Logger({ pretty: { colorize: false, level: 'warn' } })).not.toThrow()
    })

    it('reports a missing optional peer with ZNIGHT001 and install hints', () => {
      let error: unknown
      try {
        loadOptionalPeer('@znight/definitely-not-installed', 'Something', 'or disable it')
      } catch (thrown) {
        error = thrown
      }
      expect(error).toBeInstanceOf(ZnightError)
      expect((error as ZnightError).code).toBe(ErrorCode.MissingProvider)
      expect((error as ZnightError).message).toContain('"@znight/definitely-not-installed"')
      expect((error as ZnightError).hints).toEqual([
        'Install it: bun add @znight/definitely-not-installed (or npm install @znight/definitely-not-installed)',
        'or disable it',
      ])
    })
  })

  it('adapts to the core logger interface', () => {
    const { log, entries } = logger({ level: 'debug' })
    const core = toCoreLogger(log)
    core.debug('d', { a: 1 })
    core.info('i')
    core.warn('w', { b: 2 })
    core.error('e', { err: new Error('x') })
    expect(entries.map(entry => [entry.level, entry.msg])).toEqual([
      [20, 'd'],
      [30, 'i'],
      [40, 'w'],
      [50, 'e'],
    ])
    expect(entries[3]).toMatchObject({ err: { message: 'x' } })
    expect(Object.isFrozen(core)).toBe(true)
  })
})
