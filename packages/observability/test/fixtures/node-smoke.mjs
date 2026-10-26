// Runs on Node.js (type stripping) to check that the sources work outside of Bun.
// Usage: node --conditions=@znight/source test/fixtures/node-smoke.mjs

import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { context } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { Application } from '@znight/core'

import {
  datadogTransport,
  ObservabilityPlugin,
  REQUEST_ID_TOKEN,
  ObservabilityTokens as Tokens,
} from '../../src/index.ts'

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })

// fake Datadog intake
const received = []
const intake = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    received.push(...JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8')))
    response.writeHead(202).end()
  })
})
await new Promise(resolve => intake.listen(0, '127.0.0.1', resolve))
const datadog = datadogTransport({
  apiKey: 'k',
  url: `http://127.0.0.1:${intake.address().port}/api/v2/logs`,
  flushIntervalMs: 60_000,
})

const lines = []
class UserService {
  constructor(logger) {
    this.logger = logger
  }
  find(id) {
    this.logger.info('finding', { id })
    return { id }
  }
  async load(id) {
    await new Promise(resolve => setTimeout(resolve, 1))
    return { id }
  }
}

const service = 'src/app.ts#UserService'
const metadata = {
  version: 1,
  providers: {
    [service]: {
      scope: 'singleton',
      class: UserService,
      deps: [Tokens.Logger, Tokens.LoggedInterceptor, Tokens.TracedInterceptor, Tokens.MetricInterceptor],
      factory: d => new UserService(d[0]),
      interceptors: {
        find: { async: false, chain: [{ dep: 1, options: { level: 'info' } }, { dep: 2 }, { dep: 3 }] },
        load: { async: true, chain: [{ dep: 1, options: { level: 'info' } }, { dep: 2 }, { dep: 3 }] },
      },
    },
  },
  resolutionOrder: [service],
  externals: Object.values(Tokens).map(token => ({ token, providedBy: 'ObservabilityPlugin' })),
}

const plugin = ObservabilityPlugin.configure({
  logging: { destination: { write: line => lines.push(JSON.parse(line)) }, transport: datadog },
  tracing: { tracerProvider: provider },
  metrics: { defaultMetrics: false, server: { port: 0, host: '127.0.0.1' } },
})
const app = await Application.create({ metadata, plugins: [plugin], shutdown: { signals: false } })
const users = app.get(UserService)
const findResult = users.find(1)
const loadResult = users.load(2)
const loadIsPromise = loadResult instanceof Promise
await loadResult

const event = {
  method: 'GET',
  path: '/users/1',
  route: '/users/:id',
  requestId: 'req-node',
  headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
  context: undefined,
  startTime: performance.now(),
  responseHeaders: {},
}
await app.container.runInScope(
  () =>
    app.hooks.run('http:request', event, async () => {
      await Promise.resolve()
      users.find(3)
      event.status = 200
    }),
  [[REQUEST_ID_TOKEN, 'req-node']],
)

await app.start()
const metrics = await (await fetch(plugin.metricsServer.url)).text()
await app.stop()
await new Promise(resolve => intake.close(resolve))

const request = lines.find(line => line.msg === 'request completed')
const finding = lines.findLast(line => line.msg === 'finding')
console.log(
  JSON.stringify({
    findSync: !(findResult instanceof Promise) && findResult.id === 1,
    loadIsPromise,
    request: { requestId: request.requestId, traceId: request.traceId, status: request.status },
    correlated: finding.requestId === 'req-node' && finding.traceId === request.traceId,
    spans: exporter
      .getFinishedSpans()
      .map(span => span.name)
      .sort(),
    metrics: [
      metrics.includes('http_server_requests_total{method="GET",route="/users/:id",status="200"} 1'),
      metrics.includes('method_duration_seconds_count{class="UserService",method="find",outcome="success"} 2'),
    ],
    datadog: received.length === lines.length && received.every(entry => typeof entry.status === 'string'),
    traceresponse: event.responseHeaders.traceresponse.startsWith('00-4bf92f3577b34da6a3ce929d0e0e4736-'),
  }),
)
