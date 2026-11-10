/**
 * The pretty (development) output: one line per entry, short messages for the instrumentation
 * entries, `[name]` prefixes for named loggers, the other fields in a trailing `{...}`, error stacks
 * below. Only the pretty output changes: the JSON entries keep every field.
 */
import type { LoggerOptions, PrettyOptions } from '../src/index.ts'

import { Writable } from 'node:stream'
import { Application } from '@znight/core'

import { getLogger, Logger, ObservabilityPlugin, prettyTransport } from '../src/index.ts'
import { formatDuration, formatPrettyMessage } from '../src/logging/pretty-format.ts'
import { capture, httpEvent, messageEvent, meta } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

/** A writable stream recording what pino-pretty prints. */
function sink(): { readonly destination: Writable; output(): string } {
  const chunks: string[] = []
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  return { destination, output: () => chunks.join('') }
}

/** A logger printing through pino-pretty without colors nor timestamps (exact output). */
function prettyLogger(
  pretty: PrettyOptions = {},
  options: Partial<LoggerOptions> = {},
): { readonly log: Logger; lines(): Promise<string[]> } {
  const { destination, output } = sink()
  const log = new Logger({
    timestamp: false,
    base: null,
    transport: prettyTransport({ colorize: false, ...pretty, options: { destination, ...pretty.options } }),
    ...options,
  })
  return {
    log,
    lines: async () => {
      await log.flush()
      return output().split('\n').slice(0, -1)
    },
  }
}

describe('pretty output', () => {
  it('renders an HTTP request on one line, without repeating the fields of its message', async () => {
    const { log, lines } = prettyLogger()
    const entry = { method: 'GET', path: '/users/1', route: '/users/:id', status: 200, durationMs: 3.298 }
    log.info('request completed', { ...entry, requestId: 'req-1' })
    log.warn('request completed', { method: 'POST', path: '/users', status: 422, durationMs: 12.5, requestId: 'r2' })
    log.info('request completed', { ...entry, durationMs: 1534.2, requestId: 'req-3' })
    expect(await lines()).toEqual([
      'INFO: [GET] [/users/1] - [200] 3.3ms {"requestId":"req-1"}',
      'WARN: [POST] [/users] - [422] 13ms {"requestId":"r2"}',
      'INFO: [GET] [/users/1] - [200] 1.53s {"requestId":"req-3"}',
    ])
  })

  it('prefixes the entries of a named logger with its name', async () => {
    const { log, lines } = prettyLogger()
    log.child({ logger: 'UserService' }).info('User created', { userId: 42 })
    log.child({ logger: 'UserService' }).info('Users listed')
    log.child({ component: 'billing' }).warn('Invoice overdue', { invoiceId: 'i-1' })
    expect(await lines()).toEqual([
      'INFO: [UserService] User created {"userId":42}',
      'INFO: [UserService] Users listed',
      'WARN: [billing] Invoice overdue {"invoiceId":"i-1"}',
    ])
  })

  it('shows the service name once and hides pid, hostname and the trace context', async () => {
    const { log, lines } = prettyLogger({}, { base: undefined, name: 'users-api', level: 'debug' })
    log.info('ready', { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', port: 3000 })
    log.child({ component: 'znight' }).debug('Application started')
    expect(await lines()).toEqual([
      'INFO (users-api): ready {"port":3000}',
      'DEBUG (users-api): [znight] Application started',
    ])
  })

  it('keeps the error message and its stack on the following lines', async () => {
    const { log, lines } = prettyLogger()
    const error = new Error('card declined')
    error.stack = 'Error: card declined\n    at pay (billing.ts:12:5)'
    log.child({ logger: 'Billing' }).error('Payment failed', error)
    log.error('request failed', { method: 'POST', path: '/orders', status: 500, durationMs: 18, err: error })
    expect(await lines()).toEqual([
      'ERROR: [Billing] Payment failed ',
      '    err: {',
      '      "type": "Error",',
      '      "message": "card declined",',
      '      "stack":',
      '          Error: card declined',
      '              at pay (billing.ts:12:5)',
      '    }',
      'ERROR: [POST] [/orders] - [500] 18ms ',
      '    err: {',
      '      "type": "Error",',
      '      "message": "card declined",',
      '      "stack":',
      '          Error: card declined',
      '              at pay (billing.ts:12:5)',
      '    }',
    ])
  })

  it('renders messaging, scheduling, GraphQL, WebSocket and event entries on one line', async () => {
    const { log, lines } = prettyLogger({}, { level: 'debug' })
    log.info('message processed', {
      queue: 'orders',
      type: 'order.created',
      messageId: 'msg-1',
      attempt: 1,
      consumer: 'OrderConsumer',
      handler: 'onCreated',
      outcome: 'ack',
      durationMs: 12.04,
    })
    log.warn('message failed, will be retried', { queue: 'orders', attempt: 2, outcome: 'retry', durationMs: 3 })
    log.info('job completed', { job: 'cleanup', runId: 'run-1', trigger: 'schedule', durationMs: 40.2 })
    log.debug('job not acquired', { job: 'cleanup', runId: 'run-2', trigger: 'schedule' })
    log.info('graphql operation completed', {
      operationType: 'query',
      operationName: 'GetUser',
      outcome: 'success',
      transport: 'http',
      requestId: 'req-1',
      durationMs: 5.06,
    })
    log.warn('graphql operation rejected', { operationType: 'mutation', outcome: 'rejected', durationMs: 0.3 })
    log.debug('websocket message handled', {
      path: '/chat',
      event: 'message.send',
      outcome: 'ok',
      bytes: 42,
      durationMs: 2,
    })
    log.debug('websocket message handled', { path: '/chat', event: 'message.send', outcome: 'rejected', durationMs: 1 })
    log.error('websocket message failed', { path: '/feed', outcome: 'timeout', durationMs: 5000 })
    log.info('websocket connection closed', { path: '/chat', connectionId: 'c-1', durationMs: 1500.04, code: 1000 })
    log.debug('event published', { event: 'UserCreated', mode: 'publish', inline: 1, detached: 0, durationMs: 1.03 })
    expect(await lines()).toEqual([
      'INFO: [queue orders] message processed 12ms {"type":"order.created","messageId":"msg-1","attempt":1,"consumer":"OrderConsumer","handler":"onCreated"}',
      'WARN: [queue orders] message failed, will be retried 3ms {"attempt":2}',
      'INFO: [job cleanup] run completed 40ms {"runId":"run-1","trigger":"schedule"}',
      'DEBUG: [job cleanup] run not acquired {"runId":"run-2","trigger":"schedule"}',
      'INFO: [GraphQL query GetUser] 5.1ms {"transport":"http","requestId":"req-1"}',
      'WARN: [GraphQL mutation] rejected 0.3ms',
      'DEBUG: [WebSocket /chat] message.send handled 2ms {"bytes":42}',
      'DEBUG: [WebSocket /chat] message.send handled (rejected) 1ms',
      'ERROR: [WebSocket /feed] message failed (timeout) 5.00s',
      'INFO: [WebSocket /chat] connection closed 1.50s {"connectionId":"c-1","code":1000}',
      'DEBUG: [event UserCreated] published 1ms {"mode":"publish","inline":1,"detached":0}',
    ])
  })

  it('leaves the user entries alone, fields named like the instrumentation ones included', async () => {
    const { log, lines } = prettyLogger()
    log.info('Order updated', {
      orderId: 'o-1',
      status: 'shipped',
      method: 'post',
      durationMs: 3,
      nested: { a: [1, 2] },
    })
    log.info('request completed', { method: 'GET', path: '/x' })
    log.info('job completed', { job: 7 })
    log.info({ orderId: 'o-2' })
    expect(await lines()).toEqual([
      'INFO: Order updated {"orderId":"o-1","status":"shipped","method":"post","durationMs":3,"nested":{"a":[1,2]}}',
      'INFO: request completed {"method":"GET","path":"/x"}',
      'INFO: job completed {"job":7}',
      'INFO: {"orderId":"o-2"}',
    ])
  })

  it('lets the user options win', async () => {
    const custom = prettyLogger({ singleLine: false, ignore: 'pid,hostname' })
    custom.log.child({ logger: 'UserService' }).info('User created', { userId: 42, traceId: 't-1' })
    expect(await custom.lines()).toEqual(['INFO: [UserService] User created', '    userId: 42', '    traceId: "t-1"'])

    const own = prettyLogger({
      options: { messageFormat: (log: Record<string, unknown>) => `>> ${String(log['msg'])}` },
    })
    own.log.info('request completed', { method: 'GET', path: '/a', status: 200, durationMs: 1 })
    expect(await own.lines()).toEqual([
      'INFO: >> request completed {"method":"GET","path":"/a","status":200,"durationMs":1}',
    ])

    const plain = prettyLogger({ options: { messageFormat: false } })
    plain.log.child({ logger: 'UserService' }).info('User created')
    expect(await plain.lines()).toEqual(['INFO: User created {"logger":"UserService"}'])
  })

  it('never throws on odd entries', () => {
    const throwing = {
      get msg(): string {
        throw new Error('getter')
      },
    }
    expect(formatPrettyMessage(throwing, 'msg')).toBeUndefined()
    expect(formatPrettyMessage({ msg: 'request completed', method: 'GET', path: '/', status: 200 }, 'msg')).toBe(
      '[GET] [/] - [200]',
    )
    expect(formatPrettyMessage({ msg: 'request completed', method: 'GET', path: '/', status: '200' }, 'msg')).toBe(
      'request completed',
    )
    expect(formatPrettyMessage({ msg: 42, logger: '' }, 'msg')).toBe('42')
    expect(formatPrettyMessage({ msg: { a: 1 } }, 'msg')).toBeUndefined()
    expect(formatPrettyMessage({ logger: 'Svc' }, 'msg')).toBe('[Svc]')
    expect(formatPrettyMessage({ message: 'hi\u001b[31m', logger: 'Svc\u0007' }, 'message')).toBe('[Svc] hi[31m')
    expect([0, 0.04, 3.298, 9.96, 10, 999.4, 999.6, 1000, 61_000].map(formatDuration)).toEqual([
      '0ms',
      '0ms',
      '3.3ms',
      '10ms',
      '10ms',
      '999ms',
      '1.00s',
      '1.00s',
      '61.00s',
    ])
    expect([Number.NaN, -1, '3', undefined, Number.POSITIVE_INFINITY].map(formatDuration)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('formats the entries of the instrumentation and of getLogger() through ObservabilityPlugin, JSON unchanged', async () => {
    const pretty = sink()
    const { stream, entries } = capture()
    const plugin = ObservabilityPlugin.configure({
      logging: {
        timestamp: false,
        base: null,
        destination: stream,
        pretty: { colorize: false, options: { destination: pretty.destination } },
      },
      metrics: false,
      tracing: false,
    })
    const app = await Application.create({ metadata: meta({}), plugins: [plugin], shutdown: { signals: false } })
    try {
      getLogger('UserService').info('User created', { userId: 42 })
      await app.hooks.run('http:request', httpEvent({ status: 200 }), async () => undefined)
      await app.hooks.run('messaging:message', messageEvent({ outcome: 'ack' }), async () => undefined)
      await plugin.logger?.flush()
      const lines = pretty.output().split('\n').slice(0, -1)
      expect(lines[0]).toBe('INFO: [UserService] User created {"userId":42}')
      expect(lines[1]).toMatch(/^INFO: \[GET\] \[\/users\/42\] - \[200\] [\d.]+ms \{"requestId":"req-1"\}$/)
      expect(lines[2]).toMatch(
        /^INFO: \[queue orders\] message processed [\d.]+ms \{"type":"order.created","messageId":"msg-1","attempt":1,"consumer":"OrderConsumer","handler":"onCreated"\}$/,
      )
      // the JSON entries keep every field
      expect(entries[0]).toEqual({ level: 30, logger: 'UserService', userId: 42, msg: 'User created' })
      expect(entries[1]).toEqual({
        level: 30,
        method: 'GET',
        path: '/users/42',
        route: '/users/:id',
        status: 200,
        durationMs: expect.any(Number),
        requestId: 'req-1',
        msg: 'request completed',
      })
      expect(entries[2]).toMatchObject({ queue: 'orders', outcome: 'ack', durationMs: expect.any(Number) })
    } finally {
      await app.stop()
    }
  })
})
