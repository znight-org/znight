---
description: "@znight/observability - structured logging with Pino, Prometheus metrics and OpenTelemetry tracing, wired into HTTP requests and message deliveries."
---

# @znight/observability <Badge type="tip" text="available" />

Logs, metrics and traces for Znight applications, wired automatically into every HTTP request and
message delivery through [hooks](/guide/plugins#hooks). Runs on Node.js 24+ and Bun 1.3+.

```sh
npm install @znight/observability prom-client   # prom-client only for metrics
npm install -D pino-pretty                       # optional: pretty logs in development
```

::: code-group

```ts [src/main.ts]
import { ObservabilityPlugin } from '@znight/observability'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    ObservabilityPlugin.configure({
      logging: { level: 'info', redact: ['*.password', 'req.headers.authorization'] },
      metrics: { prefix: 'orders_', server: { port: 9464, path: '/metrics' } },
      tracing: { http: { responseHeader: 'x-trace-id' } },
    }),
    HttpPlugin.configure({ port: 3000 }),
  ],
})
```

:::

Register `ObservabilityPlugin` **before** the plugins it observes, so its wrappers are the outermost.
Each part can be turned off (`metrics: false`, `tracing: false`, `logging: { requests: false }`...),
and the options may be a function of the container (`configure(c => ({ logging: { level:
c.get(AppConfig).logLevel } }))`).

## What it provides

| Injectable                                                    | Description                                           |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| `Logger`                                                      | Structured pino logger with automatic request context |
| `MetricsRegistry`                                             | Prometheus registry (counters, histograms, gauges)    |
| `Tracer`                                                      | OpenTelemetry tracer                                  |
| `LoggedInterceptor`, `TracedInterceptor`, `MetricInterceptor` | Interceptors behind `@Logged`, `@Traced`, `@Metric`   |

The plugin also installs its logger as the application logger (`app.setLogger()`, entries tagged
`component: 'znight'`), so the core and every plugin log through pino (`replaceCoreLogger: false`
opts out). Logs and spans are flushed when the application stops (`onDispose`).

## Logging

```ts
import { Logger } from '@znight/observability'

@Injectable()
export class PaymentService {
  constructor(private readonly logger: Logger) {}

  async charge(order: Order) {
    this.logger.info('charging order', { orderId: order.id, amount: order.total })
  }
}
```

Every entry written while handling a request or a message automatically carries `requestId` (from
the request scope) and `traceId` / `spanId` (from the active span). The logger accepts
`(message, context | Error)` and pino's `(context, message)`; `child()`, `isLevelEnabled()`, `level`
and `flush()` work as in pino. The level comes from the option, else `LOG_LEVEL`, else `info`.

Options include `redact` (paths censored by pino), `pretty` (`pino-pretty`), `base`, `timestamp` and
`transport`: `consoleTransport()` (default, JSON lines on stdout), `prettyTransport()`,
`cloudwatchTransport()` (Lambda / CloudWatch JSON format) and `datadogTransport()` (HTTP intake with
batching and retries; entry fields clashing with Datadog's reserved attributes, such as the HTTP
`status` of request logs, are kept under other names instead of overwriting them). The plugin also
writes one entry per HTTP request (`request completed`) and per message delivery. It flushes the
logger on shutdown, and entries written after that (the final `Application stopped`) are flushed
as soon as they are written, so they are delivered before the process exits.

## Metrics

When the optional peer `prom-client` is installed, the plugin records RED metrics (rate, errors,
duration) for HTTP requests (`http_server_requests_total`, `http_server_request_duration_seconds`,
labelled by route pattern, never the raw path) and message deliveries, plus process metrics, and
serves them on a dedicated server (`http://0.0.0.0:9464/metrics` by default, `server: false` to
disable it). Label cardinality stays bounded: the message `type` label is `unmatched` for
deliveries no handler matched and is capped per handler (`maxTypesPerHandler`, 50, then `_OTHER`).
Add your own with `MetricsRegistry` (`counter`, `gauge`, `histogram`, `summary`: get-or-create by
name) or the `@Metric()` decorator.

## Tracing

Spans are created for every HTTP request (`SERVER`), message delivery (`CONSUMER`) and message
published through `MessageBroker` (`PRODUCER`, its trace context injected into the message headers),
with W3C trace-context propagation: incoming `traceparent` headers are continued and responses carry a
`traceresponse` header. Znight only uses the OpenTelemetry **API**: register any SDK (the Node SDK,
with `serviceName` and an exporter) and spans are exported; without one they are no-ops, but the
incoming trace ids still reach the logs, the `traceresponse` header and the messages published while
handling the request (Znight registers a minimal `AsyncLocalStorage` context manager when nothing
did: register your SDK before the first request). Add spans to your own methods with `@Traced()` or
the `Tracer` (`withSpan`, `startSpan`, `inject`, `extract`).

## Interceptor decorators

```ts
import { Logged, Metric, Traced } from '@znight/observability'

@Injectable()
export class InvoiceService {
  @Logged({ level: 'debug', args: true }) // one entry per call: duration, or the error
  @Traced() // a span per call
  @Metric() // method_duration_seconds{class, method, outcome}
  async issue(order: Order): Promise<Invoice> {
    // ...
  }
}
```

These decorators are declared in the package's manifest and backed by
[method interceptors](/guide/aop): they work on any provider method, sync or async (synchronous
methods stay synchronous). Their options are literals, validated when the application is created.

| Decorator        | Options                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `@Logged(opts?)` | `level` (`'debug'`), `errorLevel` (`'error'`), `args`, `result`, `message` |
| `@Traced(opts?)` | `name` (`<Class>.<method>`), `attributes`, `kind` (`'internal'`)           |
| `@Metric(opts?)` | `type` (`'histogram'` or `'counter'`), `name`, `help`, `labels`, `buckets` |
