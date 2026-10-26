import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import type {
  ExternalDefinition,
  MethodInvocation,
  Plugin,
  PluginOptions,
  ProcessLike,
  ProviderDefinition,
  ZnightMetadata,
} from '@znight/core'
import type {
  LogTransport,
  MessagePublishEventLike,
  ObservabilityOptions,
  ObservabilityPluginInstance,
} from '../src/index.ts'

import { EventEmitter } from 'node:events'
import { SpanKind } from '@opentelemetry/api'
import { Application, ErrorCode, InstantiationError, ZnightError } from '@znight/core'

import {
  datadogTransport,
  Logger,
  MetricsRegistry,
  OBSERVABILITY_PLUGIN_NAME,
  ObservabilityPlugin,
  REQUEST_ID_TOKEN,
  ObservabilityTokens as Tokens,
  Tracer,
} from '../src/index.ts'
import {
  capture,
  caught,
  type Entry,
  factoryDef,
  httpEvent,
  memoryTracing,
  messageEvent,
  meta,
  sleep,
  TRACE_ID,
  TRACEPARENT,
  t,
} from './helpers.ts'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'

const { provider, exporter } = memoryTracing()
afterEach(() => exporter.reset())

class UserService {
  readonly logger: Logger
  readonly tracer: Tracer

  constructor(logger: Logger, tracer: Tracer) {
    this.logger = logger
    this.tracer = tracer
  }

  find(id: number): { id: number } {
    this.logger.info('finding user', { id })
    return { id }
  }

  async load(id: number): Promise<{ id: number }> {
    await Promise.resolve()
    return { id }
  }
}

const EXTERNALS: ExternalDefinition[] = Object.values(Tokens).map(token => ({
  token,
  scope: 'singleton',
  providedBy: 'ObservabilityPlugin',
}))

/** Metadata shaped like the compiler output for a service using every observability external. */
function appMetadata(extra: Readonly<Record<string, ProviderDefinition>> = {}): ZnightMetadata {
  return meta(
    {
      ...extra,
      [t('UserService')]: {
        scope: 'singleton',
        class: UserService,
        deps: [
          Tokens.Logger,
          Tokens.Tracer,
          Tokens.LoggedInterceptor,
          Tokens.TracedInterceptor,
          Tokens.MetricInterceptor,
        ],
        factory: (d: unknown[]) => new UserService(d[0] as Logger, d[1] as Tracer),
        interceptors: {
          find: {
            async: false,
            chain: [{ dep: 2, options: { level: 'info' } }, { dep: 3 }, { dep: 4, options: { type: 'counter' } }],
          },
          load: { async: true, chain: [{ dep: 2 }, { dep: 3 }, { dep: 4 }] },
        },
      },
    },
    EXTERNALS,
  )
}

/** A `process` receiving the signals the test emits. */
class FakeProcess extends EventEmitter implements ProcessLike {
  exitCode: number | string | null | undefined = undefined

  exit(): void {
    throw new Error('unexpected forced exit')
  }
}

function recordingTransport(): LogTransport & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    name: 'recording',
    calls,
    stream: { write: () => undefined },
    flush: () => {
      calls.push('flush')
      return Promise.resolve()
    },
  }
}

function flushSpy(tracerProvider: BasicTracerProvider): { readonly count: () => number } {
  const spy = spyOn(tracerProvider, 'forceFlush')
  return { count: () => spy.mock.calls.length }
}

async function create(
  options: PluginOptions<ObservabilityOptions>,
  metadata: ZnightMetadata = appMetadata(),
): Promise<{ app: Application; plugin: ObservabilityPluginInstance }> {
  const plugin = ObservabilityPlugin.configure(options)
  const app = await Application.create({ metadata, plugins: [plugin], shutdown: { signals: false } })
  return { app, plugin }
}

function byMessage(entries: readonly Entry[], msg: string): Entry {
  const entry = entries.find(candidate => candidate.msg === msg)
  if (entry === undefined) throw new Error(`no entry "${msg}" in [${entries.map(e => e.msg).join(', ')}]`)
  return entry
}

describe('ObservabilityPlugin', () => {
  it('provides the externals, wraps the hooks and serves metrics through the application lifecycle', async () => {
    const { stream, entries } = capture()
    const transport = recordingTransport()
    const flushes = flushSpy(provider)
    const { app, plugin } = await create({
      logging: { destination: stream, transport },
      tracing: { tracerProvider: provider },
      metrics: { defaultMetrics: false, server: { port: 0, host: '127.0.0.1' } },
    })
    expect(app.getPlugin<ObservabilityPluginInstance>(OBSERVABILITY_PLUGIN_NAME)).toBe(plugin)
    expect(ObservabilityPlugin.name).toBe('observability')
    const service = app.get(UserService)
    expect(service.logger).toBe(plugin.logger as Logger)
    expect(service.tracer).toBe(plugin.tracer as Tracer)
    expect(app.get(Tokens.MetricsRegistry)).toBe(plugin.metrics as MetricsRegistry)
    expect(app.get(Tokens.Logger)).toBe(app.get(Tokens.Logger))

    // core logger replaced: framework logs are structured
    app.logger.warn('from the core', { detail: 1 })
    expect(byMessage(entries, 'from the core')).toMatchObject({ level: 40, component: 'znight', detail: 1 })

    // an HTTP request, as @znight/http runs it
    const event = httpEvent({ requestId: 'req-9', headers: { traceparent: TRACEPARENT } })
    await app.container.runInScope(
      () =>
        app.hooks.run('http:request', event, async () => {
          await Promise.resolve()
          service.find(1)
          event.status = 200
        }),
      [[REQUEST_ID_TOKEN, 'req-9']],
    )
    const serverSpan = exporter.getFinishedSpans().find(span => span.kind === SpanKind.SERVER)
    const methodSpan = exporter.getFinishedSpans().find(span => span.name === 'UserService.find')
    expect(serverSpan?.spanContext().traceId).toBe(TRACE_ID)
    expect(methodSpan?.parentSpanContext?.spanId).toBe(serverSpan?.spanContext().spanId)
    expect(event.responseHeaders['traceresponse']).toContain(TRACE_ID)
    const ids = { requestId: 'req-9', traceId: TRACE_ID }
    expect(byMessage(entries, 'finding user')).toMatchObject({ ...ids, spanId: methodSpan?.spanContext().spanId })
    expect(byMessage(entries, 'UserService.find() completed')).toMatchObject({ level: 30, ...ids })
    expect(byMessage(entries, 'request completed')).toMatchObject({
      ...ids,
      spanId: serverSpan?.spanContext().spanId,
      method: 'GET',
      route: '/users/:id',
      status: 200,
    })

    // a message delivery, as @znight/messaging runs it
    const message = messageEvent()
    await app.hooks.run('messaging:message', message, async () => {
      await service.load(2)
      message.outcome = 'ack'
    })
    expect(exporter.getFinishedSpans().map(span => span.name)).toContain('process orders')
    expect(byMessage(entries, 'message processed')).toMatchObject({ queue: 'orders', outcome: 'ack' })

    // metrics endpoint, started with the application
    await app.start()
    const server = plugin.metricsServer
    expect(server?.listening).toBe(true)
    expect(byMessage(entries, 'Metrics server listening')).toMatchObject({ url: server?.url, component: 'znight' })
    const body = await (await fetch(server?.url as string)).text()
    expect(body).toContain('http_server_requests_total{method="GET",route="/users/:id",status="200"} 1')
    expect(body).toContain('messaging_messages_processed_total{queue="orders"')
    expect(body).toContain('method_calls_total{class="UserService",method="find",outcome="success"} 1')
    expect(body).toContain('method_duration_seconds_count{class="UserService",method="load",outcome="success"} 1')

    await app.stop()
    expect(server?.listening).toBe(false)
    expect(transport.calls).toContain('flush')
    expect(flushes.count()).toBeGreaterThanOrEqual(1)

    // hooks are removed on dispose
    const after = httpEvent()
    const logged = entries.length
    await app.hooks.run('http:request', after, async () => undefined)
    expect(entries.length).toBe(logged)
  })

  it('injects the trace context into published messages (messaging:publish)', async () => {
    const { stream } = capture()
    const { app } = await create({
      logging: { destination: stream },
      metrics: false,
      tracing: { tracerProvider: provider },
    })
    const hooks = app.hooks as unknown as {
      run(name: string, event: MessagePublishEventLike, fn: () => Promise<unknown>): Promise<unknown>
    }
    const event: MessagePublishEventLike = { queue: 'orders', headers: {} }
    await hooks.run('messaging:publish', event, () => Promise.resolve())
    const producer = exporter.getFinishedSpans().find(span => span.kind === SpanKind.PRODUCER)
    expect(event.headers['traceparent']).toContain(producer?.spanContext().spanId as string)
    await app.stop()
    // removed on dispose
    const after: MessagePublishEventLike = { queue: 'orders', headers: {} }
    await hooks.run('messaging:publish', after, () => Promise.resolve())
    expect(after.headers).toEqual({})
  })

  it('evaluates options given as a function of the container', async () => {
    const { stream, entries } = capture()
    let evaluated = 0
    const metadata = appMetadata({
      [t('AppConfig')]: { scope: 'singleton', deps: [], factory: () => ({ logLevel: 'debug', service: 'users' }) },
    })
    const { app, plugin } = await create(container => {
      evaluated++
      const config = container.get<{ logLevel: 'debug'; service: string }>(t('AppConfig'))
      return {
        logging: { level: config.logLevel, base: { service: config.service }, destination: stream },
        metrics: false,
        tracing: { tracerProvider: provider },
      }
    }, metadata)
    expect(evaluated).toBe(1)
    expect(plugin.logger?.level).toBe('debug')
    app.get(UserService).logger.debug('configured lazily')
    expect(byMessage(entries, 'configured lazily')).toMatchObject({ service: 'users' })
    app.logger.debug('core after init')
    expect(byMessage(entries, 'core after init')).toMatchObject({ component: 'znight' })
    await app.stop()
  })

  it('builds lazily-configured options in onBootstrap when nothing injects them', async () => {
    const { stream, entries } = capture()
    const { app, plugin } = await create(
      () => ({ logging: { destination: stream }, metrics: false, tracing: false }),
      meta({}),
    )
    expect(plugin.logger).toBeInstanceOf(Logger)
    await app.hooks.run('http:request', httpEvent({ status: 201 }), async () => undefined)
    expect(byMessage(entries, 'request completed')).toMatchObject({ status: 201 })
    await app.stop()
  })

  it('works with metrics disabled: @Metric passes through, MetricsRegistry fails where injected', async () => {
    const { stream } = capture()
    const { app, plugin } = await create({ logging: { destination: stream }, metrics: false, tracing: false })
    expect(plugin.metrics).toBeUndefined()
    expect(plugin.metricsServer).toBeUndefined()
    expect(app.get(UserService).find(3)).toEqual({ id: 3 })
    const error = (() => {
      try {
        app.get(Tokens.MetricsRegistry)
      } catch (thrown) {
        return thrown
      }
    })()
    expect(error).toBeInstanceOf(InstantiationError)
    expect((error as Error).message).toContain('MetricsRegistry is unavailable: metrics are disabled')
    await app.start()
    await app.stop()
  })

  it('reports a missing prom-client where MetricsRegistry is injected', async () => {
    const available = spyOn(MetricsRegistry, 'isAvailable').mockReturnValue(false)
    try {
      const { stream, entries } = capture()
      const metadata = meta(
        {
          [t('Reporter')]: {
            scope: 'singleton',
            deps: [Tokens.MetricsRegistry],
            factory: (d: unknown[]) => ({ registry: d[0] }),
          },
        },
        EXTERNALS,
      )
      const error = await caught(() =>
        create({ logging: { destination: stream, level: 'debug' }, tracing: false }, metadata),
      )
      expect((error as ZnightError).code).toBe(ErrorCode.InstantiationFailed)
      expect((error as Error).message).toContain('"prom-client" is not installed')
      expect(entries.map(entry => entry.msg)).toContain(
        'Metrics disabled: the optional peer dependency "prom-client" is not installed',
      )
    } finally {
      available.mockRestore()
    }
  })

  it('honours disabled features', async () => {
    const { stream, entries } = capture()
    const { app } = await create({
      logging: { destination: stream, requests: false, messages: false, replaceCoreLogger: false },
      tracing: false,
      metrics: { defaultMetrics: false, server: false, http: false, messaging: false },
    })
    await app.hooks.run('http:request', httpEvent({ status: 200 }), async () => undefined)
    await app.hooks.run('messaging:message', messageEvent({ outcome: 'ack' }), async () => undefined)
    expect(entries).toHaveLength(0)
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    const metrics = app.get(Tokens.MetricsRegistry)
    expect(await metrics.metrics()).not.toContain('http_server')
    expect(app.get(Tokens.Tracer)).toBeInstanceOf(Tracer)
    await app.stop()
  })

  it('logs requests and messages at the configured levels', async () => {
    const { stream, entries } = capture()
    const { app } = await create({
      logging: { destination: stream, requests: { level: 'debug' }, messages: { level: 'warn' }, level: 'debug' },
      tracing: false,
      metrics: false,
    })
    await app.hooks.run('http:request', httpEvent({ status: 200 }), async () => undefined)
    const failed = httpEvent({ route: '/boom' })
    await app.hooks.run('http:request', failed, async () => {
      await Promise.resolve()
      failed.status = 500
      failed.error = new Error('kaboom')
    })
    await app.hooks.run('http:request', httpEvent({ status: 404, route: undefined }), async () => undefined)
    await app.hooks.run('messaging:message', messageEvent({ outcome: 'ack' }), async () => undefined)
    await app.hooks.run(
      'messaging:message',
      messageEvent({ outcome: 'retry', error: new Error('later') }),
      async () => undefined,
    )
    await app.hooks.run('messaging:message', messageEvent({ outcome: 'dead-letter' }), async () => undefined)
    await caught(() => app.hooks.run('messaging:message', messageEvent(), () => Promise.reject(new Error('crash'))))
    const requests = entries.filter(entry => 'status' in entry)
    expect(requests.map(entry => [entry.level, entry.msg, entry['status']])).toEqual([
      [20, 'request completed', 200],
      [50, 'request failed', 500],
      [40, 'request completed', 404],
    ])
    expect(requests[1]?.['err']).toMatchObject({ message: 'kaboom' })
    expect(typeof requests[0]?.['durationMs']).toBe('number')
    const deliveries = entries.filter(entry => 'outcome' in entry)
    expect(deliveries.map(entry => [entry.level, entry.msg, entry['outcome']])).toEqual([
      [40, 'message processed', 'ack'],
      [40, 'message failed, will be retried', 'retry'],
      [50, 'message dead-lettered', 'dead-letter'],
      [50, 'message failed', 'error'],
    ])
    expect(deliveries[1]?.['err']).toMatchObject({ message: 'later' })
    expect(deliveries[3]?.['err']).toMatchObject({ message: 'crash' })
    await app.stop()
  })

  it('validates @Logged / @Traced / @Metric options at boot', async () => {
    const invalid = (chain: { dep: number; options?: unknown }[]) =>
      meta(
        {
          [t('UserService')]: {
            scope: 'singleton',
            class: UserService,
            deps: [
              Tokens.Logger,
              Tokens.Tracer,
              Tokens.LoggedInterceptor,
              Tokens.TracedInterceptor,
              Tokens.MetricInterceptor,
            ],
            factory: (d: unknown[]) => new UserService(d[0] as Logger, d[1] as Tracer),
            interceptors: { find: { async: false, chain } },
          },
        },
        EXTERNALS,
      )
    const options = { metrics: false, tracing: false } as const
    for (const [chain, message] of [
      [[{ dep: 2, options: { level: 'loud' } }], 'Invalid @Logged() on UserService.find() level'],
      [[{ dep: 3, options: { kind: 'up' } }], 'Invalid @Traced() on UserService.find() kind'],
      [[{ dep: 4, options: { type: 'gauge' } }], 'Invalid @Metric() on UserService.find() type'],
    ] as const) {
      const error = await caught(() => create(options, invalid([...chain])))
      expect((error as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
      expect((error as Error).message).toContain(message)
    }
    // bindings of other interceptors are not validated
    const custom = meta(
      {
        [t('Timing')]: factoryDef(() => ({ intercept: (invocation: MethodInvocation) => invocation.proceed() })),
        [t('Svc')]: factoryDef(() => ({ find: () => 1 }), [t('Timing')], {
          interceptors: { find: { async: false, chain: [{ dep: 0, options: 'anything' }] } },
        }),
      },
      EXTERNALS,
    )
    const { app } = await create(options, custom)
    expect((app.get(t('Svc')) as { find(): number }).find()).toBe(1)
    await app.stop()
  })

  it('fails fast on invalid options and rolls back', async () => {
    const error = await caught(() => create({ logging: { level: 'loud' as never } }))
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).message).toContain('ZNIGHT')
    expect((error as Error).message).toContain('loud')
  })

  it('belongs to one application at a time', async () => {
    const { stream } = capture()
    const plugin = ObservabilityPlugin.configure({ logging: { destination: stream }, metrics: false, tracing: false })
    const options = { metadata: appMetadata(), plugins: [plugin], shutdown: { signals: false as const } }
    const first = await Application.create(options)
    const error = await caught(() => Application.create(options))
    expect((error as Error).message).toContain('already used by another application')
    await first.stop()
    const second = await Application.create(options)
    expect(second.get(UserService).find(1)).toEqual({ id: 1 })
    expect(plugin.logger).toBeInstanceOf(Logger)
    await second.stop()
  })

  it('ships the logs written after onDispose (shutdown logs) without waiting for a flush', async () => {
    for (const failing of [false, true]) {
      const sent: string[] = []
      const fakeFetch = (_url: unknown, init?: RequestInit): Promise<Response> => {
        for (const entry of JSON.parse(String(init?.body)) as { message: string }[]) sent.push(entry.message)
        return Promise.resolve(new Response(null, { status: 202 }))
      }
      // the batch timer would only fire in a minute (and is unref'd: the process would exit first)
      const datadog = datadogTransport({
        apiKey: 'k',
        url: 'http://127.0.0.1:1/api/v2/logs',
        compress: false,
        flushIntervalMs: 60_000,
        fetch: fakeFetch as typeof fetch,
      })
      const proc = new FakeProcess()
      const plugins: Plugin[] = [
        ObservabilityPlugin.configure({ logging: { transport: datadog }, metrics: false, tracing: false }),
      ]
      if (failing) plugins.push({ name: 'failing', onStop: () => Promise.reject(new Error('boom')) })
      const app = await Application.create({ metadata: appMetadata(), plugins, shutdown: { process: proc } })
      await app.start()
      proc.emit('SIGTERM', 'SIGTERM')
      for (let attempt = 0; attempt < 100 && app.state !== 'stopped'; attempt++) await sleep(2)
      await sleep(10)
      // core logs these once the plugins are disposed (after the plugin's own flush)
      expect(sent).toContain(failing ? 'The application stopped with errors' : 'Application stopped')
      expect(datadog.pending).toBe(0)
      expect(proc.exitCode).toBe(failing ? 1 : undefined)
    }
  })

  it('accepts typed options', () => {
    const options: ObservabilityOptions[] = [
      {},
      { metrics: true, tracing: true },
      { logging: { level: 'trace', redact: { paths: ['a'], censor: (value: unknown) => String(value).slice(0, 2) } } },
      { metrics: { prefix: 'app_', http: { buckets: [1] }, server: { port: 9100, path: '/m' } } },
    ]
    expect(options).toHaveLength(4)
  })

  it('fails the start when the metrics port is taken', async () => {
    const { stream } = capture()
    const blocker = await create({
      logging: { destination: stream },
      tracing: false,
      metrics: { defaultMetrics: false, server: { port: 0, host: '127.0.0.1' } },
    })
    await blocker.app.start()
    const port = blocker.plugin.metricsServer?.port
    const { app } = await create({
      logging: { destination: stream },
      tracing: false,
      metrics: { defaultMetrics: false, server: { port, host: '127.0.0.1' } },
    })
    const error = await caught(() => app.start())
    expect((error as Error).message).toContain('Cannot start the metrics server')
    expect(app.state).toBe('failed')
    await blocker.app.stop()
  })
})
