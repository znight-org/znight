---
description: "@znight/observability - structured logging with Pino, Prometheus metrics and OpenTelemetry tracing, wired into HTTP requests, message deliveries, scheduled runs, GraphQL operations, WebSocket messages and application events."
---

# @znight/observability <Badge type="tip" text="available" />

Logs, metrics and traces for Znight applications, wired automatically into every HTTP request,
message delivery, scheduled run, GraphQL operation, WebSocket message and application event through
[hooks](/guide/plugins#hooks). Runs on Node.js 24+ and Bun 1.3+.

```sh
npm install @znight/observability prom-client   # prom-client only for metrics
npm install -D pino-pretty                       # optional: pretty logs in development
```

::: code-group

```ts [src/main.ts]
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
```

:::

::: tip Guide
This page is the reference. To set up logs, metrics and traces step by step, read the
[Observability guide](/guide/observability).
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

Error reporters (Sentry...) listen to the `error:report` hook next to this plugin: the packages emit
it for the failures this plugin logs, without logging them again, and the plugin does not listen to
it, so nothing is logged twice. See [Report errors](/guide/plugins#report-errors-error-report).

## Logging

How to log, with the request context, levels, pretty output and static loggers:
[Logging](/guide/observability#logging) in the guide. The reference:

- `Logger` accepts `(message, context | Error)` and pino's `(context, message)`; `child()`,
  `isLevelEnabled()`, `level` and `flush()` work as in pino. The level comes from the option, else
  `LOG_LEVEL`, else `info`. Every entry written while handling a request or a message carries
  `requestId`, `traceId` and `spanId`.
- Options include `redact` (paths censored by pino), `pretty` (`pino-pretty`), `base`, `timestamp`
  and `transport`: `consoleTransport()` (default, JSON lines on stdout), `prettyTransport()`,
  `cloudwatchTransport()` (Lambda / CloudWatch JSON format) and `datadogTransport()` (HTTP intake
  with batching and retries; entry fields clashing with Datadog's reserved attributes, such as the
  HTTP `status` of request logs, are kept under other names instead of overwriting them).
- The plugin writes one entry per HTTP request (`request completed`) and per message delivery. It
  flushes the logger on shutdown, and entries written after that (the final `Application stopped`)
  are flushed as soon as they are written.
- With `pretty: true`, each entry is one line; `pid`, `hostname`, `traceId` and `spanId` are hidden.
  `PrettyOptions` (`ignore`, `singleLine`, `colorize`, `translateTime`, raw `options`) override these
  defaults; see the [README](../../packages/observability/README.md#pretty-output-development).

### Static loggers

`getLogger(name)` returns a logger usable outside dependency injection, even at module load
([how](/guide/observability#static-loggers)). Its entries go through the logger of the running
application (the one whose request scope is active when several run, otherwise the latest), as a
child with `{ logger: name }`; entries written before the application exists are buffered (the first
1000). `setFallbackLogger()` sets the logger used when no application runs. The
[package README](../../packages/observability/README.md) details the routing rules.

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

## GraphQL operations

With [`@znight/graphql`](/packages/graphql), the plugin also wraps the `graphql:operation` hook:

- **Span** `<type> <name>` (`query Books`; `mutation` for an anonymous operation) per operation,
  child of the HTTP request span, with the OpenTelemetry attributes `graphql.operation.type` and
  `graphql.operation.name`, plus the transport, the [driver](/guide/graphql#drivers) when it is not
  the built-in transport, the document id, the outcome and the error codes.
  The `error` and `rejected` outcomes set the status to `ERROR`; a subscription's span covers its
  whole life. The query text (`graphql.document`) is recorded only with
  `tracing: { graphql: { document: true } }`.
- **Metrics** `graphql_operations_total{type, name, outcome}` and
  `graphql_operation_duration_seconds{type, name}`. Clients choose operation names, so the `name`
  label is capped (`maxOperationNames`, 100, then `_OTHER`; names longer than 128 characters are
  `_OTHER` too); anonymous operations, and requests rejected before an operation was selected, are
  `anonymous`.
- **Logs**, off by default (the HTTP request is logged already): `logging: { graphql: true }` writes
  one entry per operation, `warn` for `partial` and `rejected`, `error` for `error`.

```ts
ObservabilityPlugin.configure({
  logging: { graphql: true },
  metrics: { graphql: { maxOperationNames: 50 } },
  tracing: { graphql: { document: true } },
})
```

`tracing.graphql`, `metrics.graphql` and `logging.graphql` turn each part off or tune it; when all
three are off, no wrapper is registered and operations do not pay for the hook.

## Scheduled jobs, WebSockets and application events

The plugin also observes the hooks of [`@znight/schedule`](/packages/schedule),
[`@znight/websocket`](/packages/websocket) and [`@znight/events`](/packages/events). Each part has its
own switch, on by default: `logging.jobs`, `metrics.schedule`, `tracing.schedule`;
`logging.websocket`, `metrics.websocket`, `tracing.websocket`; `logging.events`, `metrics.events`,
`tracing.events`.

- **Scheduled runs**: an `INTERNAL` span `schedule <job>` per executed run (the root of a new trace,
  except for manual runs), one log entry per run, and `schedule_runs_total{job, outcome}`,
  `schedule_run_duration_seconds`, `schedule_run_lateness_seconds`, `schedule_active_runs` and
  `schedule_last_success_timestamp_seconds{job}` (for "has not succeeded since" alerts).
- **WebSocket**: a `SERVER` span `WS <path> <event>` per inbound message, the root of a new trace
  linked to the handshake span; one log entry per closed connection and per failed message
  (`logging: { websocket: { messages: true } }` adds a `debug` entry per message);
  `websocket_connections_active{gateway}`, `websocket_connections_total{gateway, initiator}`,
  `websocket_messages_received_total` and `websocket_message_duration_seconds{gateway, event, outcome}`.
- **Application events**: an `INTERNAL` span `publish <Event>` around the inline phase and one span
  per listener, a `debug` entry per publication, `znight_events_published_total{event}` and
  `znight_event_listener_duration_seconds{event, listener, detached, outcome}`.

The [package README](../../packages/observability/README.md) lists every attribute, label and option.

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
