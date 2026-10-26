import { createServer } from 'node:http'
import { ErrorCode, Hooks, silentLogger, ZnightError } from '@znight/core'
import * as promClient from 'prom-client'

import {
  DEFAULT_METRICS_PORT,
  MetricsRegistry,
  MetricsServer,
  measureHttpRequests,
  measureMessages,
  UNMATCHED_ROUTE,
} from '../src/index.ts'
import { caught, httpEvent, messageEvent } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

function registry(options: ConstructorParameters<typeof MetricsRegistry>[0] = {}): MetricsRegistry {
  return new MetricsRegistry({ defaultMetrics: false, ...options })
}

/** Value of one series in the exposition text (`name{labels} value`). */
async function sample(metrics: MetricsRegistry, series: string): Promise<number | undefined> {
  const text = await metrics.metrics()
  const line = text.split('\n').find(candidate => candidate.startsWith(`${series} `))
  return line === undefined ? undefined : Number(line.slice(series.length + 1))
}

describe('MetricsRegistry', () => {
  it('creates metrics idempotently and exposes them in the Prometheus format', async () => {
    const metrics = registry()
    const counter = metrics.counter('orders_total', { help: 'Orders', labelNames: ['channel'] })
    expect(metrics.counter('orders_total', { labelNames: ['channel'] })).toBe(counter)
    counter.inc({ channel: 'web' })
    counter.inc({ channel: 'web' }, 2)
    metrics.gauge('queue_depth').set(7)
    metrics.histogram('latency_seconds', { buckets: [0.1, 1] }).observe(0.5)
    metrics.summary('size_bytes', { percentiles: [0.5] }).observe(10)
    const text = await metrics.metrics()
    expect(text).toContain('# HELP orders_total Orders')
    expect(text).toContain('# TYPE orders_total counter')
    expect(await sample(metrics, 'orders_total{channel="web"}')).toBe(3)
    expect(await sample(metrics, 'queue_depth')).toBe(7)
    expect(await sample(metrics, 'latency_seconds_bucket{le="1"}')).toBe(1)
    expect(await sample(metrics, 'latency_seconds_bucket{le="0.1"}')).toBe(0)
    expect(await sample(metrics, 'size_bytes{quantile="0.5"}')).toBe(10)
    expect(metrics.contentType).toContain('text/plain')
    expect(metrics.get('orders_total')).toBe(counter)
    expect(metrics.get('missing')).toBeUndefined()

    metrics.reset()
    expect(await sample(metrics, 'queue_depth')).toBe(0)
  })

  it('applies the prefix and default labels', async () => {
    const metrics = registry({ prefix: 'app_', defaultLabels: { service: 'users' } })
    metrics.counter('hits_total').inc()
    expect(await sample(metrics, 'app_hits_total{service="users"}')).toBe(1)
    expect(metrics.prefix).toBe('app_')
  })

  it('rejects conflicting definitions and invalid names with ZNIGHT005', () => {
    const metrics = registry()
    metrics.counter('things_total', { labelNames: ['a', 'b'] })
    expect(metrics.counter('things_total', { labelNames: ['b', 'a'] })).toBeDefined()
    expect(() => metrics.gauge('things_total', { labelNames: ['a', 'b'] })).toThrow(/already registered as a counter/)
    expect(() => metrics.counter('things_total', { labelNames: ['a'] })).toThrow(/\[a, b\], not \[a\]/)
    const invalid = (() => {
      try {
        metrics.counter('not valid!')
      } catch (error) {
        return error
      }
    })()
    expect(invalid).toBeInstanceOf(ZnightError)
    expect((invalid as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
    expect(() => metrics.counter('')).toThrow(/metric name/)
  })

  it('adopts metrics registered directly in a shared prom-client registry', () => {
    const shared = new promClient.Registry()
    const existing = new promClient.Counter({ name: 'legacy_total', help: 'h', registers: [shared] })
    const metrics = registry({ registry: shared, client: promClient })
    expect(metrics.counter('legacy_total')).toBe(existing as never)
    expect(() => metrics.histogram('legacy_total')).toThrow(/already registered as a counter/)
  })

  it('collects default process metrics (once per registry)', async () => {
    const metrics = new MetricsRegistry({ prefix: 'svc_', defaultMetrics: { prefix: 'proc_' } })
    const text = await metrics.metrics()
    expect(text).toContain('svc_proc_process_cpu_user_seconds_total')
    expect(text).toContain('svc_proc_nodejs_heap_size_total_bytes')
    const shared = new promClient.Registry()
    new MetricsRegistry({ registry: shared })
    expect(() => new MetricsRegistry({ registry: shared })).not.toThrow()
    expect(await registry().metrics()).not.toContain('process_cpu')
  })

  it('reports prom-client availability', () => {
    expect(MetricsRegistry.isAvailable()).toBe(true)
  })
})

describe('measureHttpRequests', () => {
  function setup(options: Parameters<typeof measureHttpRequests>[1] = {}) {
    const metrics = registry()
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('http:request', measureHttpRequests(metrics, options))
    return { metrics, hooks }
  }

  it('records RED metrics with method, route pattern and status labels', async () => {
    const { metrics, hooks } = setup()
    const event = httpEvent({ startTime: performance.now() - 50 })
    const result = await hooks.run('http:request', event, async () => {
      expect(await sample(metrics, 'http_server_active_requests{method="GET"}')).toBe(1)
      event.status = 200
      return 'body'
    })
    expect(result).toBe('body')
    const series = 'method="GET",route="/users/:id",status="200"'
    expect(await sample(metrics, `http_server_requests_total{${series}}`)).toBe(1)
    expect(await sample(metrics, `http_server_request_duration_seconds_count{${series}}`)).toBe(1)
    // duration measured from the producer's startTime
    expect(await sample(metrics, `http_server_request_duration_seconds_sum{${series}}`)).toBeGreaterThanOrEqual(0.05)
    expect(await sample(metrics, `http_server_request_duration_seconds_bucket{le="0.025",${series}}`)).toBe(0)
    expect(await sample(metrics, 'http_server_active_requests{method="GET"}')).toBe(0)
  })

  it('bounds cardinality: unmatched routes and unknown methods', async () => {
    const { metrics, hooks } = setup()
    const notFound = httpEvent({ route: undefined, path: '/random/123', status: 404 })
    await hooks.run('http:request', notFound, async () => undefined)
    const weird = httpEvent({ method: 'BREW', status: 405 })
    await hooks.run('http:request', weird, async () => undefined)
    expect(
      await sample(metrics, `http_server_requests_total{method="GET",route="${UNMATCHED_ROUTE}",status="404"}`),
    ).toBe(1)
    expect(await sample(metrics, 'http_server_requests_total{method="_OTHER",route="/users/:id",status="405"}')).toBe(1)
    expect(await metrics.metrics()).not.toContain('/random/123')
  })

  it('counts a pipeline failure as 500 and rethrows', async () => {
    const { metrics, hooks } = setup()
    const error = await caught(() =>
      hooks.run('http:request', httpEvent(), () => Promise.reject(new Error('unmapped'))),
    )
    expect((error as Error).message).toBe('unmapped')
    expect(await sample(metrics, 'http_server_requests_total{method="GET",route="/users/:id",status="500"}')).toBe(1)
    expect(await sample(metrics, 'http_server_active_requests{method="GET"}')).toBe(0)
  })

  it('uses custom buckets and skips ignored requests', async () => {
    const { metrics, hooks } = setup({ buckets: [1, 2], ignore: event => event.path === '/health' })
    await hooks.run('http:request', httpEvent({ path: '/health', status: 200 }), async () => undefined)
    expect(await sample(metrics, 'http_server_requests_total{method="GET",route="/users/:id",status="200"}')).toBe(
      undefined,
    )
    await hooks.run('http:request', httpEvent({ status: 201 }), async () => undefined)
    const text = await metrics.metrics()
    expect(text).toContain('le="2"')
    expect(text).not.toContain('le="0.005"')
  })
})

describe('measureMessages', () => {
  it('records processed messages by outcome', async () => {
    const metrics = registry()
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('messaging:message', measureMessages(metrics, { ignore: event => event.queue === 'ignored' }))
    const acked = messageEvent()
    await hooks.run('messaging:message', acked, async () => {
      expect(await sample(metrics, 'messaging_active_messages{queue="orders"}')).toBe(1)
      acked.outcome = 'ack'
    })
    await hooks.run('messaging:message', messageEvent({ outcome: 'retry', type: undefined }), async () => undefined)
    await caught(() => hooks.run('messaging:message', messageEvent(), () => Promise.reject(new Error('x'))))
    await hooks.run('messaging:message', messageEvent({ queue: 'ignored' }), async () => undefined)
    // no outcome set by the producer and no error: ack
    await hooks.run('messaging:message', messageEvent({ type: 'order.paid' }), async () => undefined)

    const base = 'queue="orders",consumer="OrderConsumer"'
    expect(
      await sample(metrics, `messaging_messages_processed_total{${base},type="order.created",outcome="ack"}`),
    ).toBe(1)
    expect(await sample(metrics, `messaging_messages_processed_total{${base},type="",outcome="retry"}`)).toBe(1)
    expect(
      await sample(metrics, `messaging_messages_processed_total{${base},type="order.created",outcome="error"}`),
    ).toBe(1)
    expect(await sample(metrics, `messaging_messages_processed_total{${base},type="order.paid",outcome="ack"}`)).toBe(1)
    expect(
      await sample(metrics, `messaging_process_duration_seconds_count{${base},type="order.created",outcome="ack"}`),
    ).toBe(1)
    expect(await sample(metrics, 'messaging_active_messages{queue="orders"}')).toBe(0)
    expect(await metrics.metrics()).not.toContain('ignored')
  })
})

describe('MetricsServer', () => {
  it('serves the registry on /metrics (GET and HEAD) and closes', async () => {
    const metrics = registry()
    metrics.counter('served_total').inc()
    const server = new MetricsServer(metrics, { port: 0, host: '127.0.0.1' })
    expect(server.listening).toBe(false)
    expect(server.port).toBeUndefined()
    expect(server.url).toBeUndefined()
    await server.listen()
    await server.listen()
    expect(server.listening).toBe(true)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/metrics`)
    const response = await fetch(`${server.url}?debug=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(metrics.contentType)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toContain('served_total 1')

    const head = await fetch(server.url as string, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    const notFound = await fetch(`http://127.0.0.1:${server.port}/other`)
    expect(notFound.status).toBe(404)
    await notFound.text()
    const post = await fetch(server.url as string, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
    await post.text()

    const keepAlive = fetch(server.url as string)
    await (await keepAlive).text()
    await server.close()
    await server.close()
    expect(server.listening).toBe(false)
    expect(await caught(() => fetch(`http://127.0.0.1:${server.port ?? 1}/metrics`))).toBeDefined()
  })

  it('answers 500 when collecting fails, and can restart', async () => {
    const metrics = registry()
    metrics.metrics = () => Promise.reject(new Error('collector broke'))
    const server = new MetricsServer(metrics, { port: 0, path: '/internal/metrics' })
    expect(server.path).toBe('/internal/metrics')
    await server.listen()
    const response = await fetch(`http://localhost:${server.port}/internal/metrics`)
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('collector broke')
    await server.close()
    await server.listen()
    expect(server.listening).toBe(true)
    await server.close()
  })

  it('fails to start on a busy port with a clear message', async () => {
    const blocker = createServer()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const port = (blocker.address() as { port: number }).port
    try {
      const server = new MetricsServer(registry(), { port, host: '127.0.0.1' })
      const error = await caught(() => server.listen())
      expect((error as Error).message).toStartWith(`Cannot start the metrics server on 127.0.0.1:${port}`)
      expect((error as Error).message).toContain('EADDRINUSE')
      expect(server.listening).toBe(false)
    } finally {
      await new Promise(resolve => blocker.close(resolve))
    }
  })

  it('validates its options', () => {
    expect(DEFAULT_METRICS_PORT).toBe(9464)
    expect(() => new MetricsServer(registry(), { port: 70_000 })).toThrow(/port/)
    expect(() => new MetricsServer(registry(), { port: 1.5 })).toThrow(/port/)
    expect(() => new MetricsServer(registry(), { path: 'metrics' })).toThrow(/path/)
  })
})
