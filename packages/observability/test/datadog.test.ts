import type { AddressInfo } from 'node:net'

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { ErrorCode, Hooks, silentLogger, ZnightError } from '@znight/core'

import { type DatadogTransportOptions, datadogTransport, Logger, logHttpRequests } from '../src/index.ts'
import { toDatadogEntry } from '../src/logging/datadog.ts'
import { httpEvent, sleep } from './helpers.ts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

interface Received {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly headers: IncomingHttpHeaders
  readonly entries: Record<string, unknown>[]
}

/** A fake Datadog intake: records requests, answers with scripted statuses (then 202). */
class FakeIntake {
  readonly received: Received[] = []
  statuses: number[] = []
  retryAfter: string | undefined
  #server: Server | undefined

  async start(): Promise<string> {
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const raw = Buffer.concat(chunks)
        const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
        this.received.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          entries: JSON.parse(body.toString('utf8')) as Record<string, unknown>[],
        })
        const status = this.statuses.shift() ?? 202
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (status === 429 && this.retryAfter !== undefined) headers['retry-after'] = this.retryAfter
        response.writeHead(status, headers)
        response.end('{}')
      })
    })
    await new Promise<void>(resolve => this.#server?.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/api/v2/logs`
  }

  reset(): void {
    this.received.length = 0
    this.statuses = []
    this.retryAfter = undefined
  }

  get entries(): Record<string, unknown>[] {
    return this.received.flatMap(request => request.entries)
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      this.#server?.close(() => resolve())
      this.#server?.closeAllConnections()
    })
  }
}

describe('datadogTransport', () => {
  const intake = new FakeIntake()
  let url = ''
  const errors: { message: string; dropped: number }[] = []
  const savedEnv = { ...process.env }

  beforeAll(async () => {
    url = await intake.start()
  })
  afterEach(() => {
    intake.reset()
    errors.length = 0
    for (const key of ['DD_API_KEY', 'DD_ENV', 'DD_VERSION', 'DD_SERVICE', 'DD_SITE']) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })
  afterAll(() => intake.stop())

  function transport(options: DatadogTransportOptions = {}) {
    return datadogTransport({
      apiKey: 'test-key',
      url,
      service: 'users-api',
      hostname: 'host-1',
      flushIntervalMs: 60_000,
      retryDelayMs: 1,
      onError: (error, dropped) => errors.push({ message: error.message, dropped }),
      ...options,
    })
  }

  it('sends gzip-compressed batches mapped to Datadog attributes', async () => {
    const dd = transport({ tags: ['team:core'], source: 'znight' })
    const logger = new Logger({ transport: dd, level: 'debug' })
    logger.info('User created', { userId: 42 })
    logger.debug('details')
    logger.error('Payment failed', new TypeError('declined'))
    logger.fatal('down')
    logger.warn('careful', {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    })
    expect(dd.pending).toBe(5)
    await logger.flush()
    expect(dd.pending).toBe(0)
    expect(intake.received).toHaveLength(1)
    const [request] = intake.received
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/api/v2/logs')
    expect(request?.headers['dd-api-key']).toBe('test-key')
    expect(request?.headers['content-type']).toBe('application/json')
    expect(request?.headers['content-encoding']).toBe('gzip')
    const [info, debug, error, fatal, warn] = intake.entries
    expect(info).toMatchObject({
      message: 'User created',
      status: 'info',
      level: 'info',
      userId: 42,
      service: 'users-api',
      ddsource: 'znight',
      ddtags: 'team:core',
      pid: process.pid,
    })
    // pino's own hostname wins over the option
    expect(typeof info?.['hostname']).toBe('string')
    expect(typeof info?.['timestamp']).toBe('number')
    expect(info).not.toHaveProperty('msg')
    expect(info).not.toHaveProperty('time')
    expect(debug).toMatchObject({ status: 'debug' })
    expect(error).toMatchObject({ status: 'error', error: { kind: 'TypeError', message: 'declined' } })
    expect(JSON.stringify(error)).toContain('TypeError: declined')
    expect(error).not.toHaveProperty('err')
    expect(fatal).toMatchObject({ status: 'critical' })
    expect(warn).toMatchObject({
      status: 'warning',
      dd: { trace_id: BigInt('0xa3ce929d0e0e4736').toString(), span_id: BigInt('0x00f067aa0ba902b7').toString() },
    })
  })

  it('keeps record fields that clash with the reserved attributes (status, message, timestamp)', async () => {
    const dd = transport({ compress: false })
    const logger = new Logger({ transport: dd })
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('http:request', logHttpRequests(logger))
    await hooks.run('http:request', httpEvent({ status: 404 }), async () => undefined)
    logger.error('Payment failed', { message: 'card_declined' })
    logger.info('evt', { timestamp: '2020-01-01T00:00:00Z', status: 'pending', attributes: { kept: true } })
    await logger.flush()
    const [request, payment, event] = intake.entries
    // the HTTP status code of the request log survives the Datadog level
    expect(request).toMatchObject({
      message: 'request completed',
      status: 'warning',
      http: { status_code: 404 },
      route: '/users/:id',
    })
    // pino's message wins over a `message` context field, which is kept
    expect(payment).toMatchObject({
      message: 'Payment failed',
      status: 'error',
      attributes: { message: 'card_declined' },
    })
    // the log time wins over a `timestamp` context field, which is kept
    expect(typeof event?.['timestamp']).toBe('number')
    expect(event).toMatchObject({
      message: 'evt',
      status: 'info',
      attributes: { kept: true, timestamp: '2020-01-01T00:00:00Z', status: 'pending' },
    })
  })

  it('splits batches by entry count and by size', async () => {
    const dd = transport({ batchSize: 2, compress: false })
    const logger = new Logger({ transport: dd })
    for (let index = 0; index < 5; index++) logger.info(`m${index}`)
    await dd.flush()
    expect(intake.received.map(request => request.entries.length)).toEqual([2, 2, 1])
    expect(intake.received[0]?.headers['content-encoding']).toBeUndefined()
    expect(intake.entries.map(entry => entry['message'])).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])

    intake.reset()
    const bySize = transport({ maxBatchBytes: 1024, compress: false })
    const big = new Logger({ transport: bySize })
    for (let index = 0; index < 4; index++) big.info('x'.repeat(400))
    await bySize.flush()
    expect(intake.received.length).toBeGreaterThan(1)
    expect(intake.entries).toHaveLength(4)
  })

  it('sends as soon as a batch is full, and after the flush interval otherwise', async () => {
    const full = transport({ batchSize: 2 })
    const logger = new Logger({ transport: full })
    logger.info('a')
    logger.info('b')
    await sleep(50)
    expect(intake.entries.map(entry => entry['message'])).toEqual(['a', 'b'])

    intake.reset()
    const timed = transport({ flushIntervalMs: 20 })
    new Logger({ transport: timed }).info('timed')
    expect(intake.received).toHaveLength(0)
    await sleep(120)
    expect(intake.entries.map(entry => entry['message'])).toEqual(['timed'])
    await timed.close()
  })

  it('retries 5xx and 429 (honouring Retry-After) then succeeds', async () => {
    intake.statuses = [503, 429, 500]
    intake.retryAfter = '0'
    const dd = transport()
    new Logger({ transport: dd }).info('eventually')
    await dd.flush()
    expect(intake.received).toHaveLength(4)
    expect(intake.received.every(request => request.entries[0]?.['message'] === 'eventually')).toBe(true)
    expect(errors).toEqual([])
    expect(dd.dropped).toBe(0)
  })

  it('drops a batch on non-retryable statuses and after the last retry', async () => {
    intake.statuses = [400]
    const dd = transport({ maxRetries: 1 })
    const logger = new Logger({ transport: dd })
    logger.info('rejected')
    await dd.flush()
    expect(intake.received).toHaveLength(1)
    expect(errors).toEqual([{ message: 'Datadog log intake responded 400 Bad Request', dropped: 1 }])

    errors.length = 0
    intake.reset()
    intake.statuses = [500, 502]
    logger.info('a')
    logger.info('b')
    await dd.flush()
    expect(intake.received).toHaveLength(2)
    expect(errors).toEqual([{ message: 'Datadog log intake responded 502 Bad Gateway', dropped: 2 }])
    expect(dd.dropped).toBe(3)

    // later entries are still delivered
    errors.length = 0
    intake.reset()
    logger.info('after')
    await dd.flush()
    expect(intake.entries.map(entry => entry['message'])).toEqual(['after'])
  })

  it('retries network errors then reports the loss', async () => {
    const dd = transport({ url: 'http://127.0.0.1:1/api/v2/logs', maxRetries: 2, timeoutMs: 2000 })
    new Logger({ transport: dd }).info('lost')
    await dd.flush()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toStartWith('Datadog log intake unreachable')
    expect(errors[0]?.dropped).toBe(1)
  })

  it('uses an injected fetch and bounds the buffer (oldest dropped)', async () => {
    const bodies: string[] = []
    const dd = transport({
      maxBufferSize: 2,
      compress: false,
      fetch: ((_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return Promise.resolve(new Response(null, { status: 202 }))
      }) as typeof fetch,
    })
    const logger = new Logger({ transport: dd })
    logger.info('1')
    logger.info('2')
    logger.info('3')
    expect(errors).toEqual([{ message: 'Datadog log transport: buffer full, dropping the oldest entry', dropped: 1 }])
    await dd.flush()
    expect(JSON.parse(bodies[0] as string).map((entry: { message: string }) => entry.message)).toEqual(['2', '3'])
  })

  it('truncates entries above 1 MB', async () => {
    const dd = transport({ compress: false })
    new Logger({ transport: dd }).info('y'.repeat(1_100_000), { traceId: 'abc' })
    await dd.flush()
    const [entry] = intake.entries
    expect(entry?.['truncated']).toBe(true)
    expect(String(entry?.['message']).length).toBeLessThan(70_000)
    expect(entry).toMatchObject({ status: 'info', traceId: 'abc', service: 'users-api' })
  })

  it('reads DD_* environment variables', async () => {
    process.env['DD_API_KEY'] = 'env-key'
    process.env['DD_ENV'] = 'staging'
    process.env['DD_VERSION'] = '1.2.3'
    process.env['DD_SERVICE'] = 'env-service'
    const dd = datadogTransport({ url, tags: { team: 'core' }, compress: false, flushIntervalMs: 60_000 })
    new Logger({ transport: dd, base: null }).info('env')
    await dd.flush()
    expect(intake.received[0]?.headers['dd-api-key']).toBe('env-key')
    expect(intake.entries[0]).toMatchObject({
      service: 'env-service',
      ddtags: 'team:core,env:staging,version:1.2.3',
      ddsource: 'nodejs',
    })
  })

  it('requires an API key (ZNIGHT006) and validates options (ZNIGHT005)', () => {
    delete process.env['DD_API_KEY']
    const missing = (() => {
      try {
        datadogTransport({ url })
      } catch (error) {
        return error
      }
    })()
    expect(missing).toBeInstanceOf(ZnightError)
    expect((missing as ZnightError).code).toBe(ErrorCode.MissingConfig)
    expect(() => transport({ batchSize: 0 })).toThrow(/batchSize/)
    expect(() => transport({ batchSize: 1001 })).toThrow(/batchSize/)
    expect(() => transport({ maxRetries: 1.5 })).toThrow(/maxRetries/)
  })

  it('targets the intake of the configured site', async () => {
    const urls: string[] = []
    const dd = datadogTransport({
      apiKey: 'k',
      site: 'datadoghq.eu',
      fetch: ((target: string) => {
        urls.push(target)
        return Promise.resolve(new Response(null, { status: 202 }))
      }) as typeof fetch,
    })
    new Logger({ transport: dd }).info('eu')
    await dd.close()
    expect(urls).toEqual(['https://http-intake.logs.datadoghq.eu/api/v2/logs'])
  })

  it('maps CloudWatch-shaped and non-JSON records', () => {
    const settings = { service: 's', source: 'nodejs', hostname: 'h', tags: undefined, traceCorrelation: false }
    expect(
      toDatadogEntry({ level: 'WARN', message: 'm', timestamp: '2026-01-01T00:00:00.000Z', err: 'plain' }, settings),
    ).toEqual({
      message: 'm',
      status: 'warning',
      level: 'warn',
      timestamp: '2026-01-01T00:00:00.000Z',
      ddsource: 'nodejs',
      hostname: 'h',
      service: 's',
      err: 'plain',
    })
    expect(toDatadogEntry({ level: 'weird' }, settings)).toMatchObject({ status: 'info', message: '' })
    expect(
      toDatadogEntry({ level: 30, msg: 'm', status: 503, http: { status_code: 502 }, attributes: 'x' }, settings),
    ).toMatchObject({
      message: 'm',
      status: 'info',
      http: { status_code: 502 },
      attributes: { attributes: 'x', status: 503 },
    })
    expect(
      toDatadogEntry(
        { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: 'nothex' },
        { ...settings, traceCorrelation: true },
      ),
    ).not.toHaveProperty('dd')
  })
})
