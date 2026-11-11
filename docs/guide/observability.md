---
description: Logs, metrics and traces with @znight/observability - set up the plugin, what is instrumented automatically, structured logging with request context, static loggers, custom Prometheus metrics, OpenTelemetry tracing across HTTP and messaging, and error reporting.
---

# Observability

`@znight/observability` wires logs (Pino), metrics (Prometheus, through `prom-client`) and traces
(OpenTelemetry) into every HTTP request, message delivery, scheduled run, GraphQL operation,
WebSocket message and application event, through [hooks](./plugins#hooks): register the plugin and
the application is observable, without touching a controller or a consumer.

This page shows how to use it. The [package reference](/packages/observability) lists the options,
the transports and the name of every metric and span.

## Set up {#setup}

```sh
npm install @znight/observability prom-client   # prom-client only for metrics
npm install -D pino-pretty                       # optional: pretty logs in development
```

```ts
import { HttpPlugin } from '@znight/http'
import { ObservabilityPlugin } from '@znight/observability'
import { createApplication } from './.znight/container.generated.js'

const app = await createApplication({
  plugins: [
    ObservabilityPlugin.configure({
      logging: { level: 'info', redact: ['*.password', 'req.headers.authorization'] },
      metrics: { prefix: 'orders_', server: { port: 9464, path: '/metrics' } },
      tracing: { http: { responseHeader: 'x-trace-id' } },
    }),
    HttpPlugin.configure({ port: 3000 }),
  ],
})
await app.start()
```

Register `ObservabilityPlugin` **first**, before the plugins it observes: its wrappers are then the
outermost, and they see everything the other plugins do. Options may come from configuration
through the function form, `ObservabilityPlugin.configure(c => ({ logging: { level: c.get(AppConfig).logLevel } }))`
([Config in plugin options](./configuration#plugin-options)).

## What is instrumented {#instrumented}

| Activity                           | Logs                                        | Metrics                                                                               | Traces                                        |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| HTTP requests                      | one entry per request (`request completed`) | `http_server_requests_total`, `http_server_request_duration_seconds` by route pattern | a `SERVER` span, W3C trace context continued  |
| [Message deliveries](./messaging)  | one entry per message                       | `messaging_messages_processed_total`, `messaging_process_duration_seconds`            | a `CONSUMER` span; `PRODUCER` when publishing |
| [Scheduled runs](./scheduling)     | one entry per run                           | `schedule_runs_total`, durations, lateness, last success                              | an `INTERNAL` span per run                    |
| [GraphQL operations](./graphql)    | opt-in (`logging: { graphql: true }`)       | `graphql_operations_total`, `graphql_operation_duration_seconds`                      | a span per operation                          |
| [WebSocket messages](./websockets) | one entry per closed connection or failure  | connections and messages by gateway and event                                         | a `SERVER` span per inbound message           |
| [Application events](./events)     | a `debug` entry per publication             | `znight_events_published_total`, listener durations                                   | a span per publication and per listener       |
| Your methods                       | `@Logged()`                                 | `@Metric()`                                                                           | `@Traced()`                                   |

Each part has its own switch (`metrics: false`, `tracing: false`, `logging: { requests: false }`,
`logging.jobs`, `tracing.websocket`...). Labels stay bounded: routes are labelled by pattern, never by
raw path, and client-chosen names (GraphQL operations, message types) are capped. The
[reference](/packages/observability#scheduled-jobs-websockets-and-application-events) has every name.

## Logging {#logging}

Inject the `Logger`:

```ts
import { Injectable } from '@znight/core'
import { Logger } from '@znight/observability'

@Injectable()
export class PaymentService {
  constructor(private readonly logger: Logger) {}

  async charge(order: Order) {
    this.logger.info('charging order', { orderId: order.id, amount: order.total })
  }
}
```

- **Request context for free.** Every entry written while handling a request or a message carries
  `requestId` and the `traceId` / `spanId` of the active span: find every line of one request
  without passing anything around.
- **Levels.** The level comes from the option, else `LOG_LEVEL`, else `info`. The logger accepts
  `(message, context | Error)` and pino's `(context, message)`; `child()`, `isLevelEnabled()` and
  `flush()` work as in pino.
- **One logger for everything.** The plugin installs its logger as the application logger, so the
  core and every plugin log through pino, in the same format, with the same redaction.
- **Redaction.** `redact` censors paths in every entry (`'*.password'`,
  `'req.headers.authorization'`): never log credentials, even by accident.
- **Shutdown.** Logs are flushed when the application stops, and entries written after that are
  flushed at once: the last lines reach the output before the process exits.

### Pretty output in development {#pretty}

With `pretty: true` (and `pino-pretty` installed as a dev dependency), each entry is one readable
line:

```txt
[14:38:00.040] INFO (users-api): [UserService] User created {"requestId":"req-7f3a","userId":42}
[14:38:00.041] INFO (users-api): [GET] [/users/42] - [200] 3.3ms {"requestId":"req-7f3a"}
[14:38:00.041] INFO (users-api): [queue orders] message processed 12ms {"type":"order.created","messageId":"msg-1","attempt":1,"consumer":"OrderConsumer","handler":"onCreated"}
```

Turn it on in development only, from configuration: projects created by `znight new` pretty-print
under `znight dev` and write JSON lines in production.

### Choose a transport {#transports}

JSON lines on stdout (`consoleTransport()`, the default) suit containers and Kubernetes: the
platform collects stdout. `cloudwatchTransport()` writes the Lambda / CloudWatch format and
`datadogTransport()` sends to the Datadog HTTP intake, with batching and retries. Options of each
transport: [transports](/packages/observability#logging).

### Static loggers {#static-loggers}

Inject the `Logger` by default. For code outside dependency injection, or to migrate NestJS's
`new Logger(X.name)` without changing constructors, `getLogger()` returns a logger usable anywhere,
even at module load:

```ts
import { getLogger } from '@znight/observability'

export class UserImporter {
  private readonly logger = getLogger(UserImporter.name)

  import(rows: readonly unknown[]): void {
    this.logger.info('Importing users', { count: rows.length })
  }
}
```

Its entries go through the logger of the running application, with its level, redaction, transport
and request context; entries written before the application exists are buffered. In tests that
create no application, `setFallbackLogger(new Logger({ level: 'silent' }))` in the test preload
silences them.

## Metrics {#metrics}

With `prom-client` installed, the plugin records RED metrics (rate, errors, duration) for HTTP
requests and message deliveries, plus process metrics, and serves them on a **dedicated server**
(`http://0.0.0.0:9464/metrics` by default): the metrics never share a port, a prefix or the guards
of your API. `metrics: { server: false }` turns the server off when you expose
`MetricsRegistry.metrics()` yourself.

Add your own with `MetricsRegistry` (`counter`, `gauge`, `histogram`, `summary`: get-or-create by
name):

```ts
import { Injectable } from '@znight/core'
import { type Counter, MetricsRegistry } from '@znight/observability'

@Injectable()
export class OrderService {
  readonly #placed: Counter

  constructor(metrics: MetricsRegistry) {
    this.#placed = metrics.counter('orders_placed_total', { help: 'Orders placed', labelNames: ['channel'] })
  }

  place(order: Order) {
    this.#placed.inc({ channel: order.channel })
  }
}
```

or measure a method with `@Metric()` (`method_duration_seconds{class, method, outcome}` by default).
Keep label values bounded: an id or an email as a label creates one series per value.

## Tracing {#tracing}

Spans are created for every HTTP request (`SERVER`), message delivery (`CONSUMER`) and message
published through `MessageBroker` (`PRODUCER`, its trace context injected into the message headers).
Incoming `traceparent` headers are continued, and responses carry a `traceresponse` header.

Znight only uses the OpenTelemetry **API**: register any SDK (the Node SDK with an OTLP exporter, or a
`tracerProvider` in the options) and spans are exported. Without one they cost nothing, but the
incoming trace ids still reach the logs, the response header and the published messages. Register
the SDK before the first request.

**Across services.** Because the trace context travels in the message headers, one trace follows a
request from the HTTP API through the broker to the consumer, in another process. The
[`microservice` example](/examples) does exactly that with RabbitMQ: `POST /orders` (`SERVER`),
its publication (`PRODUCER`) and the payment consumer (`CONSUMER`) share one trace id, visible in
every log line.

Add spans to your own code with `@Traced()` on a method, or with the injectable `Tracer`
(`withSpan`, `startSpan`, `inject`, `extract`) for finer control.

## Interceptor decorators {#decorators}

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

They are [method interceptors](./aop#built-in-interceptor-decorators): they work on any provider
method, sync or async, and their options are checked when the application is created. The
[decorator options](/packages/observability#interceptor-decorators) are in the reference.

## Report errors {#error-reporting}

Unexpected failures (a `500`, a dead-lettered message, a failed job) are logged by this plugin and
emitted on the `error:report` hook. An error tracker (Sentry, Rollbar...) listens to that hook in a
small plugin of your own, so nothing is reported twice: see
[Report errors](./plugins#report-errors-error-report) and its Sentry recipe.

## Testing {#testing}

In tests, keep logs quiet and metrics off: `ObservabilityPlugin.configure({ logging: { level:
'silent' }, metrics: false })`, or pass these options through the
[production wiring](./testing#production-wiring) (`src/app.ts` in the examples). To assert on log
entries, give `logging` a `destination` and parse the JSON lines, as the `worker` example's tests do.
