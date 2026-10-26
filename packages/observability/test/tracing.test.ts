import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import type { MessagePublishEventLike, MessagePublishWrapper } from '../src/index.ts'

import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { Hooks, silentLogger } from '@znight/core'

import {
  SemanticAttributes as Attr,
  formatTraceparent,
  Logger,
  parseTraceparent,
  TRACE_RESPONSE_HEADER,
  Tracer,
  traceHttpRequests,
  traceMessagePublish,
  traceMessages,
  W3CTraceContextFallback,
} from '../src/index.ts'
import {
  capture,
  caught,
  httpEvent,
  memoryTracing,
  messageEvent,
  PARENT_SPAN_ID,
  TRACE_ID,
  TRACEPARENT,
} from './helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const { provider, exporter } = memoryTracing()

function spans(): ReadableSpan[] {
  return exporter.getFinishedSpans()
}

function byName(name: string): ReadableSpan {
  const span = spans().find(candidate => candidate.name === name)
  if (span === undefined)
    throw new Error(
      `no span "${name}" in [${spans()
        .map(s => s.name)
        .join(', ')}]`,
    )
  return span
}

afterEach(() => exporter.reset())

describe('Tracer', () => {
  const tracer = new Tracer({ tracerProvider: provider, version: '1.0.0' })

  it('runs synchronous functions in an active span, synchronously', () => {
    const result = tracer.withSpan('sync', span => {
      expect(tracer.activeSpan()).toBe(span)
      return 42
    })
    expect(result).toBe(42)
    expect(byName('sync').status.code).toBe(SpanStatusCode.UNSET)
    expect(byName('sync').instrumentationScope).toMatchObject({ name: '@znight/observability', version: '1.0.0' })
    expect(tracer.activeSpan()).toBeUndefined()
  })

  it('ends async spans when the promise settles and nests children', async () => {
    const value = await tracer.withSpan('parent', async () => {
      await Promise.resolve()
      return tracer.withSpan('child', async () => 'done', { attributes: { step: 1 }, kind: SpanKind.CLIENT })
    })
    expect(value).toBe('done')
    const parent = byName('parent')
    const child = byName('child')
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId)
    expect(child.attributes).toEqual({ step: 1 })
    expect(child.kind).toBe(SpanKind.CLIENT)
  })

  it('records thrown errors and rejections', async () => {
    expect(() =>
      tracer.withSpan('throws', () => {
        throw new RangeError('sync failure')
      }),
    ).toThrow('sync failure')
    const rejection = await caught(() => tracer.withSpan('rejects', () => Promise.reject('plain string')))
    expect(rejection).toBe('plain string')
    const thrown = byName('throws')
    expect(thrown.status).toEqual({ code: SpanStatusCode.ERROR, message: 'sync failure' })
    expect(thrown.attributes[Attr.ERROR_TYPE]).toBe('RangeError')
    expect(thrown.events[0]?.name).toBe('exception')
    expect(thrown.events[0]?.attributes?.['exception.message']).toBe('sync failure')
    const rejected = byName('rejects')
    expect(rejected.status.code).toBe(SpanStatusCode.ERROR)
    expect(rejected.attributes[Attr.ERROR_TYPE]).toBe('string')
  })

  it('uses an explicit parent context', () => {
    const parent = tracer.extract({ traceparent: TRACEPARENT }, ROOT_CONTEXT)
    tracer.withSpan('remote child', () => undefined, { context: parent })
    expect(byName('remote child').parentSpanContext?.spanId).toBe(PARENT_SPAN_ID)
    expect(byName('remote child').spanContext().traceId).toBe(TRACE_ID)
  })

  it('exposes the active trace context', () => {
    expect(tracer.traceContext()).toBeUndefined()
    tracer.withSpan('ctx', span => {
      expect(tracer.traceContext()).toEqual({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        traceFlags: 1,
        sampled: true,
      })
    })
    const remote = tracer.extract({ traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-00` })
    expect(tracer.withContext(remote, () => tracer.traceContext())).toMatchObject({ traceId: TRACE_ID, sampled: false })
    const span = tracer.startSpan('manual')
    span.end()
    expect(byName('manual')).toBeDefined()
  })

  it('injects and extracts W3C trace context without a global propagator', () => {
    expect(propagation.fields()).toEqual([])
    const extracted = tracer.extract({ traceparent: TRACEPARENT, tracestate: 'vendor=value' })
    const carrier = tracer.inject({} as Record<string, string>, extracted)
    expect(carrier).toEqual({ traceparent: TRACEPARENT, tracestate: 'vendor=value' })
    expect(tracer.inject({} as Record<string, string>)).toEqual({})
    // header lookup is case-insensitive (message headers)
    const mixedCase = tracer.extract({ TraceParent: TRACEPARENT })
    expect(trace.getSpanContext(mixedCase)?.traceId).toBe(TRACE_ID)
    // arrays of values: the first wins
    const multi = tracer.extract({ traceparent: [TRACEPARENT, 'garbage'] })
    expect(trace.getSpanContext(multi)?.spanId).toBe(PARENT_SPAN_ID)
  })

  it('uses the global propagator when one is registered, or an explicit one', () => {
    let injected = 0
    propagation.setGlobalPropagator({
      inject: (_context, carrier, setter) => {
        injected++
        setter.set(carrier, 'x-custom', 'yes')
      },
      extract: ctx => ctx,
      fields: () => ['x-custom'],
    })
    try {
      expect(tracer.inject({} as Record<string, string>)).toEqual({ 'x-custom': 'yes' })
      expect(injected).toBe(1)
      const explicit = new Tracer({ tracerProvider: provider, propagator: new W3CTraceContextPropagator() })
      const ctx = explicit.extract({ traceparent: TRACEPARENT })
      expect(explicit.inject({} as Record<string, string>, ctx)).toEqual({ traceparent: TRACEPARENT })
    } finally {
      propagation.disable()
    }
  })

  it('flushes the tracer provider when it supports it', async () => {
    let flushed = 0
    const flushing = new Tracer({
      tracerProvider: { getTracer: () => trace.getTracer('noop'), forceFlush: async () => void flushed++ } as never,
    })
    await flushing.forceFlush()
    expect(flushed).toBe(1)
    const failing = new Tracer({
      tracerProvider: {
        getTracer: () => trace.getTracer('noop'),
        forceFlush: () => Promise.reject(new Error('x')),
      } as never,
    })
    await failing.forceFlush()
    // the global (proxy) provider without SDK: nothing to flush
    await new Tracer().forceFlush()
  })

  it('works without SDK (no-op spans) and still propagates incoming trace ids', () => {
    const noop = new Tracer()
    const parent = noop.extract({ traceparent: TRACEPARENT })
    const value = noop.withSpan('noop', span => span.spanContext().traceId, { context: parent })
    expect(value).toBe(TRACE_ID)
  })
})

describe('traceparent helpers', () => {
  it('parses valid headers and rejects invalid ones', () => {
    expect(parseTraceparent(TRACEPARENT)).toEqual({
      traceId: TRACE_ID,
      spanId: PARENT_SPAN_ID,
      traceFlags: 1,
      isRemote: true,
    })
    expect(parseTraceparent(` ${TRACEPARENT} `)?.traceId).toBe(TRACE_ID)
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_SPAN_ID}-01-future`)?.spanId).toBe(PARENT_SPAN_ID)
    for (const invalid of [
      `ff-${TRACE_ID}-${PARENT_SPAN_ID}-01`,
      `00-${TRACE_ID}-${PARENT_SPAN_ID}-01-extra`,
      `00-${'0'.repeat(32)}-${PARENT_SPAN_ID}-01`,
      `00-${TRACE_ID}-${'0'.repeat(16)}-01`,
      `00-${TRACE_ID.toUpperCase()}-${PARENT_SPAN_ID}-01`,
      `00-${TRACE_ID}-${PARENT_SPAN_ID}`,
      'garbage',
    ]) {
      expect(parseTraceparent(invalid)).toBeUndefined()
    }
    const fallback = new W3CTraceContextFallback()
    expect(fallback.fields()).toEqual(['traceparent', 'tracestate'])
    expect(
      fallback.extract(ROOT_CONTEXT, { traceparent: 'garbage' }, { get: (c, k) => (c as never)[k], keys: () => [] }),
    ).toBe(ROOT_CONTEXT)
  })

  it('formats span contexts', () => {
    expect(formatTraceparent({ traceId: TRACE_ID, spanId: PARENT_SPAN_ID, traceFlags: 0 })).toBe(
      `00-${TRACE_ID}-${PARENT_SPAN_ID}-00`,
    )
  })
})

describe('traceHttpRequests', () => {
  const tracer = new Tracer({ tracerProvider: provider })

  function hooksWith(options: Parameters<typeof traceHttpRequests>[1] = {}): Hooks {
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('http:request', traceHttpRequests(tracer, options))
    return hooks
  }

  it('creates a SERVER span child of the incoming traceparent, active during the request', async () => {
    const hooks = hooksWith()
    const { stream, entries } = capture()
    const logger = new Logger({ destination: stream })
    const event = httpEvent({
      headers: {
        traceparent: TRACEPARENT,
        'user-agent': 'curl/8',
        host: 'api.example.com:8443',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      },
      startTime: performance.now() - 30,
    })
    const result = await hooks.run('http:request', event, async () => {
      await Promise.resolve()
      logger.info('handling')
      tracer.withSpan('db.query', () => undefined)
      event.status = 200
      return 'ok'
    })
    expect(result).toBe('ok')
    const server = byName('GET /users/:id')
    expect(server.kind).toBe(SpanKind.SERVER)
    expect(server.spanContext().traceId).toBe(TRACE_ID)
    expect(server.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID)
    expect(server.attributes).toEqual({
      [Attr.HTTP_REQUEST_METHOD]: 'GET',
      [Attr.URL_PATH]: '/users/42',
      [Attr.HTTP_ROUTE]: '/users/:id',
      [Attr.ZNIGHT_REQUEST_ID]: 'req-1',
      [Attr.USER_AGENT_ORIGINAL]: 'curl/8',
      [Attr.SERVER_ADDRESS]: 'api.example.com',
      [Attr.SERVER_PORT]: 8443,
      [Attr.URL_SCHEME]: 'https',
      [Attr.CLIENT_ADDRESS]: '203.0.113.7',
      [Attr.HTTP_RESPONSE_STATUS_CODE]: 200,
    })
    expect(server.status.code).toBe(SpanStatusCode.UNSET)
    // the span starts at the producer's startTime
    const durationMs = server.duration[0] * 1000 + server.duration[1] / 1e6
    expect(durationMs).toBeGreaterThanOrEqual(25)
    expect(byName('db.query').parentSpanContext?.spanId).toBe(server.spanContext().spanId)
    expect(entries[0]).toMatchObject({ traceId: TRACE_ID, spanId: server.spanContext().spanId })
    expect(event.responseHeaders[TRACE_RESPONSE_HEADER]).toBe(formatTraceparent(server.spanContext()))
  })

  it('starts a new trace without traceparent', async () => {
    const event = httpEvent({ headers: { traceparent: 'invalid' } })
    await hooksWith().run('http:request', event, async () => {
      await Promise.resolve()
      event.status = 204
    })
    const span = byName('GET /users/:id')
    expect(span.parentSpanContext).toBeUndefined()
    expect(span.spanContext().traceId).not.toBe(TRACE_ID)
  })

  it('marks 5xx as errors, records exceptions, leaves 4xx unset', async () => {
    const hooks = hooksWith()
    const failing = httpEvent({ route: '/fail' })
    await hooks.run('http:request', failing, async () => {
      await Promise.resolve()
      failing.status = 500
      failing.error = new TypeError('db down')
    })
    const clientError = httpEvent({ route: '/missing' })
    await hooks.run('http:request', clientError, async () => {
      await Promise.resolve()
      clientError.status = 404
      clientError.error = new Error('not found')
    })
    const bare = httpEvent({ route: '/bare' })
    await hooks.run('http:request', bare, async () => {
      await Promise.resolve()
      bare.status = 503
    })
    const fail = byName('GET /fail')
    expect(fail.status.code).toBe(SpanStatusCode.ERROR)
    expect(fail.attributes[Attr.ERROR_TYPE]).toBe('TypeError')
    expect(fail.events.map(event => event.name)).toEqual(['exception'])
    const missing = byName('GET /missing')
    expect(missing.status.code).toBe(SpanStatusCode.UNSET)
    expect(missing.events).toEqual([])
    expect(missing.attributes[Attr.HTTP_RESPONSE_STATUS_CODE]).toBe(404)
    const unavailable = byName('GET /bare')
    expect(unavailable.status.code).toBe(SpanStatusCode.ERROR)
    expect(unavailable.attributes[Attr.ERROR_TYPE]).toBe('503')
  })

  it('records an unhandled pipeline error as 500 and rethrows', async () => {
    const error = await caught(() =>
      hooksWith().run('http:request', httpEvent(), () => Promise.reject(new Error('unexpected'))),
    )
    expect((error as Error).message).toBe('unexpected')
    const span = byName('GET /users/:id')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes[Attr.HTTP_RESPONSE_STATUS_CODE]).toBe(500)
  })

  it('names unmatched and non-standard requests without the raw path', async () => {
    const hooks = hooksWith({ responseHeader: false })
    const notFound = httpEvent({ route: undefined, path: '/random/1', status: 404 })
    await hooks.run('http:request', notFound, async () => undefined)
    await hooks.run('http:request', httpEvent({ method: 'brew', route: undefined, status: 405 }), async () => undefined)
    expect(byName('GET').attributes[Attr.URL_PATH]).toBe('/random/1')
    expect(byName('GET').attributes).not.toHaveProperty(Attr.HTTP_ROUTE)
    expect(byName('HTTP').attributes).toMatchObject({
      [Attr.HTTP_REQUEST_METHOD]: '_OTHER',
      [Attr.HTTP_REQUEST_METHOD_ORIGINAL]: 'brew',
    })
    expect(notFound.responseHeaders).toEqual({})
  })

  it('uses a custom response header and skips ignored requests', async () => {
    const hooks = hooksWith({ responseHeader: 'x-trace', ignore: event => event.path === '/health' })
    const health = httpEvent({ path: '/health', status: 200 })
    await hooks.run('http:request', health, async () => undefined)
    expect(spans()).toHaveLength(0)
    expect(health.responseHeaders).toEqual({})
    const event = httpEvent({ status: 200, headers: { host: '[::1]:3000' } })
    await hooks.run('http:request', event, async () => undefined)
    expect(event.responseHeaders['x-trace']).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/)
    expect(byName('GET /users/:id').attributes).toMatchObject({
      [Attr.SERVER_ADDRESS]: '[::1]',
      [Attr.SERVER_PORT]: 3000,
    })
  })
})

describe('traceMessages', () => {
  const tracer = new Tracer({ tracerProvider: provider })

  it('creates a CONSUMER span child of the message trace context', async () => {
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('messaging:message', traceMessages(tracer, { system: 'rabbitmq' }))
    const event = messageEvent({ headers: { Traceparent: TRACEPARENT }, attempt: 2 })
    await hooks.run('messaging:message', event, async () => {
      await Promise.resolve()
      expect(trace.getSpanContext(context.active())?.traceId).toBe(TRACE_ID)
      event.outcome = 'ack'
    })
    const span = byName('process orders')
    expect(span.kind).toBe(SpanKind.CONSUMER)
    expect(span.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID)
    expect(span.attributes).toEqual({
      [Attr.MESSAGING_OPERATION_NAME]: 'process',
      [Attr.MESSAGING_OPERATION_TYPE]: 'process',
      [Attr.MESSAGING_DESTINATION_NAME]: 'orders',
      [Attr.MESSAGING_MESSAGE_ID]: 'msg-1',
      [Attr.MESSAGING_SYSTEM]: 'rabbitmq',
      [Attr.ZNIGHT_CONSUMER]: 'OrderConsumer',
      [Attr.ZNIGHT_HANDLER]: 'onCreated',
      [Attr.ZNIGHT_MESSAGE_TYPE]: 'order.created',
      [Attr.ZNIGHT_ATTEMPT]: 2,
      [Attr.ZNIGHT_OUTCOME]: 'ack',
    })
    expect(span.status.code).toBe(SpanStatusCode.UNSET)
  })

  it('marks retries, dead letters and failures as errors', async () => {
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('messaging:message', traceMessages(tracer, { ignore: event => event.queue === 'skip' }))
    await hooks.run('messaging:message', messageEvent({ queue: 'retry', outcome: 'retry' }), async () => undefined)
    await hooks.run(
      'messaging:message',
      messageEvent({
        queue: 'dlq',
        outcome: 'dead-letter',
        error: new Error('poison'),
        handler: undefined,
        type: undefined,
      }),
      async () => undefined,
    )
    await caught(() =>
      hooks.run('messaging:message', messageEvent({ queue: 'boom' }), () => Promise.reject(new Error('x'))),
    )
    await hooks.run('messaging:message', messageEvent({ queue: 'skip' }), async () => undefined)
    expect(byName('process retry').status).toEqual({ code: SpanStatusCode.ERROR, message: 'message retry' })
    const dlq = byName('process dlq')
    expect(dlq.status.code).toBe(SpanStatusCode.ERROR)
    expect(dlq.events[0]?.attributes?.['exception.message']).toBe('poison')
    expect(dlq.attributes).not.toHaveProperty(Attr.ZNIGHT_HANDLER)
    expect(byName('process boom').attributes[Attr.ZNIGHT_OUTCOME]).toBe('error')
    expect(spans().map(span => span.name)).not.toContain('process skip')
  })
})

describe('traceMessagePublish', () => {
  const tracer = new Tracer({ tracerProvider: provider })

  /** Hooks running the `messaging:publish` hook declared by @znight/messaging. */
  function publishHooks(options: Parameters<typeof traceMessagePublish>[1] = {}) {
    const hooks = new Hooks({ logger: silentLogger })
    const untyped = hooks as unknown as {
      wrap(name: string, wrapper: MessagePublishWrapper): () => void
      run(name: string, event: MessagePublishEventLike, fn: () => Promise<unknown>): Promise<unknown>
    }
    untyped.wrap('messaging:publish', traceMessagePublish(tracer, options))
    return untyped
  }

  it('creates a PRODUCER span and propagates it to the consumer through the headers', async () => {
    const hooks = publishHooks({ system: 'rabbitmq' })
    const published: MessagePublishEventLike = {
      queue: 'orders',
      type: 'order.created',
      messageId: 'm-1',
      headers: {},
      startTime: performance.now(),
    }
    await tracer.withSpan('request', () => hooks.run('messaging:publish', published, () => Promise.resolve()))
    const producer = byName('send orders')
    expect(producer.kind).toBe(SpanKind.PRODUCER)
    expect(producer.parentSpanContext?.spanId).toBe(byName('request').spanContext().spanId)
    expect(producer.attributes).toEqual({
      [Attr.MESSAGING_OPERATION_NAME]: 'send',
      [Attr.MESSAGING_OPERATION_TYPE]: 'send',
      [Attr.MESSAGING_DESTINATION_NAME]: 'orders',
      [Attr.MESSAGING_MESSAGE_ID]: 'm-1',
      [Attr.ZNIGHT_MESSAGE_TYPE]: 'order.created',
      [Attr.MESSAGING_SYSTEM]: 'rabbitmq',
    })
    expect(published.headers['traceparent']).toBe(formatTraceparent(producer.spanContext()))

    // the consumer continues the trace
    const consumerHooks = new Hooks({ logger: silentLogger })
    consumerHooks.wrap('messaging:message', traceMessages(tracer))
    await consumerHooks.run('messaging:message', messageEvent({ headers: published.headers }), () => Promise.resolve())
    const consumer = byName('process orders')
    expect(consumer.parentSpanContext?.spanId).toBe(producer.spanContext().spanId)
    expect(consumer.spanContext().traceId).toBe(producer.spanContext().traceId)
  })

  it('records publication failures and skips ignored queues', async () => {
    const hooks = publishHooks({ ignore: event => event.queue === 'audit' })
    const failing: MessagePublishEventLike = { queue: 'orders', headers: {} }
    const error = await caught(() =>
      hooks.run('messaging:publish', failing, () => {
        failing.error = new Error('broker down')
        return Promise.reject(failing.error)
      }),
    )
    expect((error as Error).message).toBe('broker down')
    expect(byName('send orders').status).toEqual({ code: SpanStatusCode.ERROR, message: 'broker down' })
    const audit: MessagePublishEventLike = { queue: 'audit', headers: {} }
    await hooks.run('messaging:publish', audit, () => Promise.resolve())
    expect(audit.headers).toEqual({})
    expect(spans().map(span => span.name)).not.toContain('send audit')
  })
})
