import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { Hooks, silentLogger } from '@znight/core'

import { Logger, Tracer, traceHttpRequests, traceMessagePublish } from '../src/index.ts'
import { FallbackContextManager } from '../src/tracing/context.ts'
import { capture, enableContextManager, httpEvent, PARENT_SPAN_ID, sleep, TRACE_ID, TRACEPARENT } from './helpers.ts'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'

/** The registered global context manager (OpenTelemetry API internals). */
function globalContextManager(): unknown {
  return (context as unknown as { _getContextManager(): unknown })._getContextManager()
}

describe('without a registered context manager (no OpenTelemetry SDK)', () => {
  // other test files register one in this process: start from the API's no-op manager
  beforeEach(() => context.disable())
  afterEach(() => context.disable())
  afterAll(() => enableContextManager())

  it('correlates the logs and the published messages of a request with its incoming trace context', async () => {
    expect(context.with(ROOT_CONTEXT.setValue(Symbol('probe'), 1), () => context.active())).toBe(ROOT_CONTEXT)
    const { stream, entries } = capture()
    const logger = new Logger({ destination: stream, base: null })
    const tracer = new Tracer()
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('http:request', traceHttpRequests(tracer))
    const publish = traceMessagePublish(tracer)
    const message = { queue: 'orders', headers: {} as Record<string, string> }
    const event = httpEvent({ headers: { traceparent: TRACEPARENT } })

    await hooks.run('http:request', event, async () => {
      await sleep(1)
      logger.info('inside handler')
      await publish(message, async () => undefined)
    })

    expect(entries[0]).toMatchObject({ msg: 'inside handler', traceId: TRACE_ID, spanId: PARENT_SPAN_ID })
    expect(message.headers['traceparent']).toBe(TRACEPARENT)
    expect(event.responseHeaders['traceresponse']).toBe(TRACEPARENT)
    expect(globalContextManager()).toBeInstanceOf(FallbackContextManager)
  })

  it('keeps the context manager registered by the application', async () => {
    const registered = new AsyncLocalStorageContextManager().enable()
    context.setGlobalContextManager(registered)
    const tracer = new Tracer()
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('http:request', traceHttpRequests(tracer))
    let traceId: string | undefined
    await hooks.run('http:request', httpEvent({ headers: { traceparent: TRACEPARENT } }), () => {
      traceId = trace.getSpanContext(context.active())?.traceId
      return Promise.resolve()
    })
    expect(traceId).toBe(TRACE_ID)
    expect(globalContextManager()).toBe(registered)
  })

  it('activates contexts through Tracer.withSpan() and withContext()', async () => {
    const tracer = new Tracer()
    const parent = tracer.extract({ traceparent: TRACEPARENT })
    const seen = await tracer.withContext(parent, () =>
      tracer.withSpan('child', async () => {
        await sleep(1)
        return tracer.traceContext()?.traceId
      }),
    )
    expect(seen).toBe(TRACE_ID)
  })
})

describe('FallbackContextManager', () => {
  const manager = new FallbackContextManager().enable()
  const key = Symbol('key')
  const ctx = ROOT_CONTEXT.setValue(key, 'value')

  it('runs functions with a context, a this and arguments, and binds functions', () => {
    expect(manager.active()).toBe(ROOT_CONTEXT)
    const self = { factor: 2 }
    const result = manager.with(
      ctx,
      function (this: typeof self, value: number) {
        return [manager.active().getValue(key), this.factor * value]
      },
      self,
      21,
    )
    expect(result).toEqual(['value', 42])
    const bound = manager.bind(ctx, (suffix: string) => `${String(manager.active().getValue(key))}${suffix}`)
    expect(bound('!')).toBe('value!')
    const target = { name: 'not a function' }
    expect(manager.bind(ctx, target)).toBe(target)
    expect(manager.active()).toBe(ROOT_CONTEXT)
  })
})
