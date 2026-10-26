import type { MethodInterceptor } from '@znight/core'

import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { ErrorCode, interceptMethod, ZnightError } from '@znight/core'

import {
  SemanticAttributes as Attr,
  Logged,
  LoggedInterceptor,
  Logger,
  Metric,
  MetricInterceptor,
  MetricsRegistry,
  Traced,
  TracedInterceptor,
  Tracer,
} from '../src/index.ts'
import { capture, caught, memoryTracing } from './helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const { provider, exporter } = memoryTracing()
afterEach(() => exporter.reset())

class UserService {
  readonly #secret = 'private-field'
  calls = 0

  find(id: number): { id: number; secret: string } {
    this.calls++
    return { id, secret: this.#secret }
  }

  async load(id: number): Promise<{ id: number }> {
    await Promise.resolve()
    this.calls++
    return { id }
  }

  fail(): never {
    throw new TypeError('sync failure')
  }

  async reject(): Promise<never> {
    await Promise.resolve()
    throw new RangeError('async failure')
  }

  /** Not declared async: returns a promise from a "sync" method. */
  deferred(): Promise<string> {
    return Promise.reject(new Error('left untouched'))
  }

  outer(): number {
    return this.find(1).id
  }
}

function intercepted(interceptor: MethodInterceptor, options?: unknown): UserService {
  const service = new UserService()
  for (const [method, async] of [
    ['find', false],
    ['load', true],
    ['fail', false],
    ['reject', true],
    ['deferred', false],
    ['outer', false],
  ] as const) {
    interceptMethod(service, method, [{ interceptor, options }], { async, className: 'UserService', checkSync: true })
  }
  return service
}

describe('LoggedInterceptor', () => {
  function setup(level: Logger['level'] = 'debug') {
    const { stream, entries } = capture()
    return { logger: new Logger({ destination: stream, level }), entries }
  }

  it('logs synchronous calls synchronously, with duration', () => {
    const { logger, entries } = setup()
    const service = intercepted(new LoggedInterceptor(logger))
    const result = service.find(7)
    expect(result).toEqual({ id: 7, secret: 'private-field' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 20,
      msg: 'UserService.find() completed',
      class: 'UserService',
      method: 'find',
    })
    expect(typeof entries[0]?.['durationMs']).toBe('number')
    expect(entries[0]).not.toHaveProperty('args')
    expect(entries[0]).not.toHaveProperty('result')
  })

  it('logs arguments and results on demand, through redaction', async () => {
    const { stream, entries } = capture()
    const logger = new Logger({ destination: stream, redact: ['args[0].password', 'result.secret'] })
    const service = new UserService()
    const interceptor = new LoggedInterceptor(logger)
    interceptMethod(service, 'find', [{ interceptor, options: { level: 'info', args: true, result: true } }])
    interceptMethod(service, 'load', [{ interceptor, options: { level: 'info', result: true, message: 'Loading' } }], {
      async: true,
    })
    service.find({ password: 'p' } as never)
    await service.load(3)
    expect(entries[0]).toMatchObject({
      args: [{ password: '[Redacted]' }],
      result: { secret: '[Redacted]' },
    })
    expect(entries[1]).toMatchObject({ msg: 'Loading completed', result: { id: 3 } })
  })

  it('logs async calls once settled, and failures at errorLevel', async () => {
    const { logger, entries } = setup()
    const service = intercepted(new LoggedInterceptor(logger), { errorLevel: 'warn' })
    const pending = service.load(1)
    expect(pending).toBeInstanceOf(Promise)
    expect(entries).toHaveLength(0)
    expect(await pending).toEqual({ id: 1 })
    expect(entries[0]).toMatchObject({ msg: 'UserService.load() completed' })

    expect(() => service.fail()).toThrow('sync failure')
    expect(entries[1]).toMatchObject({ level: 40, msg: 'UserService.fail() failed', err: { type: 'TypeError' } })
    const error = await caught(() => service.reject())
    expect((error as Error).message).toBe('async failure')
    expect(entries[2]).toMatchObject({
      level: 40,
      msg: 'UserService.reject() failed',
      err: { message: 'async failure' },
    })
  })

  it('passes through when both levels are disabled', () => {
    const { logger, entries } = setup('fatal')
    const service = intercepted(new LoggedInterceptor(logger))
    expect(service.find(1).id).toBe(1)
    expect(() => service.fail()).toThrow()
    expect(entries).toHaveLength(0)
    const errorsOnly = intercepted(new LoggedInterceptor(setup('error').logger))
    expect(errorsOnly.find(2).id).toBe(2)
  })

  it('passes a promise returned by a sync method through untouched', async () => {
    const { logger, entries } = setup()
    const service = intercepted(new LoggedInterceptor(logger))
    const promise = service.deferred()
    expect(entries[0]).toMatchObject({ msg: 'UserService.deferred() completed' })
    expect((await caught(() => promise)) as Error).toMatchObject({ message: 'left untouched' })
  })

  it('intercepts self-invocations', () => {
    const { logger, entries } = setup()
    intercepted(new LoggedInterceptor(logger)).outer()
    expect(entries.map(entry => entry['method'])).toEqual(['find', 'outer'])
  })

  it('rejects invalid levels with ZNIGHT005', () => {
    const service = intercepted(new LoggedInterceptor(setup().logger), { level: 'loud' })
    const error = (() => {
      try {
        service.find(1)
      } catch (thrown) {
        return thrown
      }
    })()
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
    expect(() => intercepted(new LoggedInterceptor(setup().logger), { errorLevel: 'silent' }).find(1)).toThrow(/silent/)
    expect(() => intercepted(new LoggedInterceptor(setup().logger), 'info').find(1)).toThrow(/expected an object/)
    expect(() => intercepted(new LoggedInterceptor(setup().logger), { message: 1 }).find(1)).toThrow(/message/)
  })
})

describe('TracedInterceptor', () => {
  const tracer = new Tracer({ tracerProvider: provider })

  it('traces sync calls synchronously, with nested spans and logs correlated', () => {
    const { stream, entries } = capture()
    const logger = new Logger({ destination: stream })
    const service = new UserService()
    const interceptor = new TracedInterceptor(tracer)
    interceptMethod(service, 'find', [{ interceptor }], { className: 'UserService' })
    interceptMethod(service, 'outer', [{ interceptor, options: { name: 'users.outer' } }], { className: 'UserService' })
    const original = service.find.bind(service)
    service.find = ((id: number) => {
      logger.info('inside find')
      return original(id)
    }) as never
    expect(service.outer()).toBe(1)
    const outer = exporter.getFinishedSpans().find(span => span.name === 'users.outer')
    expect(outer?.attributes[Attr.CODE_FUNCTION_NAME]).toBe('UserService.outer')
    expect(outer?.kind).toBe(SpanKind.INTERNAL)
    expect(entries[0]?.['spanId']).toBe(outer?.spanContext().spanId)
  })

  it('ends async spans when the promise settles and records errors', async () => {
    const service = intercepted(new TracedInterceptor(tracer), {
      attributes: { 'app.feature': 'users' },
      kind: 'client',
    })
    expect(await service.load(4)).toEqual({ id: 4 })
    expect(() => service.fail()).toThrow('sync failure')
    await caught(() => service.reject())
    const finished = exporter.getFinishedSpans()
    const [load, fail, reject] = finished
    expect(load?.name).toBe('UserService.load')
    expect(load?.attributes).toEqual({ [Attr.CODE_FUNCTION_NAME]: 'UserService.load', 'app.feature': 'users' })
    expect(load?.kind).toBe(SpanKind.CLIENT)
    expect(load?.status.code).toBe(SpanStatusCode.UNSET)
    expect(fail?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'sync failure' })
    expect(reject?.status.code).toBe(SpanStatusCode.ERROR)
    expect(reject?.events[0]?.attributes?.['exception.type']).toBe('RangeError')
  })

  it('keeps the active span during async continuations', async () => {
    const service = new UserService()
    const interceptor = new TracedInterceptor(tracer)
    let seen: string | undefined
    service.load = async (id: number) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      seen = tracer.activeSpan()?.spanContext().spanId
      return { id }
    }
    interceptMethod(service, 'load', [{ interceptor }], { async: true, className: 'UserService' })
    await service.load(1)
    expect(seen).toBe(exporter.getFinishedSpans()[0]?.spanContext().spanId)
  })

  it('rejects invalid options with ZNIGHT005', () => {
    expect(() => intercepted(new TracedInterceptor(tracer), { kind: 'sideways' }).find(1)).toThrow(/@Traced\(\) kind/)
    expect(() => intercepted(new TracedInterceptor(tracer), { attributes: [1] }).find(1)).toThrow(/attributes/)
    expect(() => intercepted(new TracedInterceptor(tracer), { name: false }).find(1)).toThrow(/name/)
    expect(() => intercepted(new TracedInterceptor(tracer), 42).find(1)).toThrow(/expected an object/)
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })
})

describe('MetricInterceptor', () => {
  const metricsRegistry = () => new MetricsRegistry({ defaultMetrics: false })

  it('records call durations in a shared histogram by default', async () => {
    const metrics = metricsRegistry()
    const service = intercepted(new MetricInterceptor(metrics))
    expect(service.find(1).id).toBe(1)
    await service.load(1)
    expect(() => service.fail()).toThrow()
    await caught(() => service.reject())
    const text = await metrics.metrics()
    expect(text).toContain('method_duration_seconds_count{class="UserService",method="find",outcome="success"} 1')
    expect(text).toContain('method_duration_seconds_count{class="UserService",method="load",outcome="success"} 1')
    expect(text).toContain('method_duration_seconds_count{class="UserService",method="fail",outcome="error"} 1')
    expect(text).toContain('method_duration_seconds_count{class="UserService",method="reject",outcome="error"} 1')
  })

  it('records counters with static labels and custom names', async () => {
    const metrics = metricsRegistry()
    const options = { name: 'users_found_total', type: 'counter', help: 'Users found', labels: { source: 'db' } }
    const service = intercepted(new MetricInterceptor(metrics), options)
    service.find(1)
    service.find(2)
    const text = await metrics.metrics()
    expect(text).toContain('# HELP users_found_total Users found')
    expect(text).toContain('users_found_total{class="UserService",method="find",outcome="success",source="db"} 2')

    const histogram = intercepted(new MetricInterceptor(metrics), { name: 'find_seconds', buckets: [0.5] })
    histogram.find(1)
    expect(await metrics.metrics()).toContain(
      'find_seconds_bucket{le="0.5",class="UserService",method="find",outcome="success"} 1',
    )
  })

  it('reports a conflicting definition once and keeps the method working', () => {
    const metrics = metricsRegistry()
    metrics.gauge('taken')
    const errors: unknown[] = []
    const interceptor = new MetricInterceptor(metrics, { onError: error => errors.push(error) })
    const service = intercepted(interceptor, { name: 'taken' })
    expect(service.find(1).id).toBe(1)
    expect(service.find(2).id).toBe(2)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toContain('already registered as a gauge')
  })

  it('rejects invalid options with ZNIGHT005 (usage errors, unlike registry conflicts)', () => {
    const interceptor = new MetricInterceptor(metricsRegistry())
    for (const [options, pattern] of [
      [{ type: 'summary' }, /@Metric\(\) type/],
      ['histogram', /@Metric\(\) options: expected an object/],
      [{ labels: { class: 'x' } }, /"class" is set automatically/],
      [{ labels: { tier: 1 } }, /labels.tier: expected a string/],
      [{ buckets: [1, 'x'] }, /buckets/],
      [{ name: 42 }, /name: expected a string/],
    ] as const) {
      expect(() => intercepted(interceptor, options).find(1)).toThrow(pattern)
    }
  })

  it('passes through without a registry (metrics disabled)', async () => {
    const service = intercepted(new MetricInterceptor(undefined))
    expect(service.find(1).id).toBe(1)
    expect(await service.load(2)).toEqual({ id: 2 })
  })
})

describe('chained interceptors', () => {
  it('compose (first = outermost) and keep sync methods sync under the dev check', async () => {
    const { stream, entries } = capture()
    const logger = new Logger({ destination: stream, level: 'debug' })
    const tracer = new Tracer({ tracerProvider: provider })
    const metrics = new MetricsRegistry({ defaultMetrics: false })
    const service = new UserService()
    const chain = [
      { interceptor: new LoggedInterceptor(logger) },
      { interceptor: new TracedInterceptor(tracer) },
      { interceptor: new MetricInterceptor(metrics) },
    ]
    interceptMethod(service, 'find', chain, { className: 'UserService', checkSync: true })
    interceptMethod(service, 'load', chain, { className: 'UserService', async: true, checkSync: true })
    expect(service.find(5).id).toBe(5)
    expect(await service.load(6)).toEqual({ id: 6 })
    expect(service.calls).toBe(2)
    expect(entries).toHaveLength(2)
    expect(exporter.getFinishedSpans()).toHaveLength(2)
    expect(await metrics.metrics()).toContain('method="load",outcome="success"} 1')
  })
})

describe('decorators', () => {
  it('are no-op markers', () => {
    class Decorated {
      @Logged({ level: 'info' })
      @Traced({ name: 'x' })
      @Metric({ type: 'counter' })
      method(): number {
        return 1
      }
    }
    expect(new Decorated().method()).toBe(1)
    expect(Logged()).toBe(Traced())
    expect(Traced()).toBe(Metric())
    expect(Logged()(Decorated.prototype, 'method')).toBeUndefined()
  })
})
