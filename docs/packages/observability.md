---
description: "@znight/observability - structured logging with Pino, Prometheus metrics and OpenTelemetry tracing, wired into HTTP requests and message deliveries."
---

# @znight/observability <Badge type="warning" text="in development" />

Logs, metrics and traces for Znight applications, wired automatically into every HTTP request and
message delivery through [hooks](/guide/plugins#hooks).

<!-- TODO(api): verify against implementation (this page follows the specification; option names may change) -->

```sh
npm install @znight/observability prom-client   # prom-client only for metrics
```

::: code-group

```ts [src/main.ts]
import { ObservabilityPlugin } from '@znight/observability'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    ObservabilityPlugin.configure({
      logging: { level: 'info' },
      metrics: { path: '/metrics' },
      tracing: { serviceName: 'orders-api' },
    }),
    HttpPlugin.configure({ port: 3000 }),
  ],
})
```

:::

Register `ObservabilityPlugin` **before** the plugins it observes, so its wrappers are the outermost.

## What it provides

| Injectable                                                    | Description                                           |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| `Logger`                                                      | Structured pino logger with automatic request context |
| `MetricsRegistry`                                             | Prometheus registry (counters, histograms, gauges)    |
| `Tracer`                                                      | OpenTelemetry tracer                                  |
| `LoggedInterceptor`, `TracedInterceptor`, `MetricInterceptor` | Interceptors behind `@Logged`, `@Traced`, `@Metric`   |

The plugin also installs its logger as the application logger (`app.setLogger()`), so the core and
every plugin log through pino. Logs are flushed when the application stops (`onDispose`).

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

Every entry written while handling a request or a message automatically carries `requestId`,
`traceId` and `spanId`, read from the current scope. `@Secret` config values are masked.

## Metrics

The plugin records RED metrics (rate, errors, duration) for HTTP requests and message deliveries, and
exposes them in the Prometheus format. Add your own with `MetricsRegistry` or the `@Metric()`
decorator.

## Tracing

Spans are created for every HTTP request and message delivery, with W3C trace-context propagation
(incoming `traceparent` headers are continued, outgoing responses carry the context). Add spans to
your own methods with `@Traced()` or the `Tracer`.

## Interceptor decorators

```ts
import { Logged, Metric, Traced } from '@znight/observability'

@Injectable()
export class InvoiceService {
  @Logged({ level: 'debug' }) // logs calls, durations and failures
  @Traced() // a span per call
  @Metric() // a duration histogram and an error counter
  async issue(order: Order): Promise<Invoice> {
    // ...
  }
}
```

These decorators are declared in the package's manifest and backed by
[method interceptors](/guide/aop): they work on any provider method, sync or async.
