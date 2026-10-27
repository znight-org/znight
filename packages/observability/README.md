# @znight/observability

Logging, metrics and tracing for [Znight](../../README.md) applications:

- **Logging**: a structured [pino](https://getpino.io) `Logger`, automatically enriched with the
  current `requestId`, `traceId` and `spanId` (and `job` / `runId` inside a scheduled run);
  redaction; transports for stdout JSON, pretty output, Datadog and CloudWatch / AWS Lambda; one log
  entry per HTTP request, per message and per scheduled run.
- **Metrics**: a Prometheus `MetricsRegistry` ([prom-client](https://github.com/siimon/prom-client)),
  HTTP RED metrics, consumer metrics, scheduled job metrics, process metrics, a dedicated `/metrics`
  server.
- **Tracing**: an OpenTelemetry `Tracer`, a `SERVER` span per HTTP request, a `CONSUMER` span per
  message with W3C trace context propagation, and an `INTERNAL` span per scheduled run. Works with
  any OpenTelemetry SDK.
- **Decorators**: `@Logged()`, `@Traced()` and `@Metric()` on any provider method.

Everything is wired by one plugin, and like the rest of Znight, it is resolved at compile time: no
`reflect-metadata`, no runtime scanning.

```sh
bun add @znight/observability
bun add prom-client        # optional: metrics
bun add -d pino-pretty     # optional: pretty logs in development
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only).

## Quick start

```ts
// src/main.ts
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { ObservabilityPlugin } from '@znight/observability'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    ObservabilityPlugin.configure({
      logging: { level: 'info', redact: ['*.password', 'req.headers.authorization'] },
    }),
    HttpPlugin.configure({ port: 3000 }),
  ],
})
await app.start() // also starts the metrics server on :9464/metrics
```

```ts
// src/users/user.service.ts
import { Injectable } from '@znight/core'
import { Logged, Logger, Metric, Traced } from '@znight/observability'

@Injectable()
export class UserService {
  constructor(
    private readonly repository: UserRepository,
    private readonly logger: Logger, // injected: provided by ObservabilityPlugin
  ) {}

  @Logged({ level: 'debug', args: true })
  @Traced()
  @Metric()
  async findById(id: string): Promise<User> {
    this.logger.info('Finding user', { id }) // carries requestId, traceId, spanId
    return this.repository.findById(id)
  }
}
```

Place `ObservabilityPlugin` first in `plugins`: its hook wrappers are then the outermost, so every
other plugin's work happens inside the request span.

A request produces (one JSON line each):

```json
{"level":30,"time":1730000000000,"pid":1,"hostname":"api-1","requestId":"9f1c","traceId":"4bf9…4736","spanId":"a2fb…","id":"42","msg":"Finding user"}
{"level":30,"time":1730000000004,"pid":1,"hostname":"api-1","requestId":"9f1c","traceId":"4bf9…4736","spanId":"00f0…","method":"GET","path":"/users/42","route":"/users/:id","status":200,"durationMs":4.18,"msg":"request completed"}
```

## Logging

### The `Logger`

```ts
logger.info('User created', { userId }) // message first (like the core logger)...
logger.warn({ orderId }, 'Order delayed') // ...or pino's order
logger.error('Payment failed', error) // an Error is serialized under `err` (type, message, stack, cause)
logger.log(level, 'Dynamic level')

const billing = logger.child({ component: 'billing' }) // bindings written in every entry
const verbose = logger.child({ component: 'sync' }, { level: 'debug', msgPrefix: '[sync] ' })

if (logger.isLevelEnabled('debug')) logger.debug('Costly', { dump: expensive() })
logger.level = 'warn' // change at runtime
await logger.flush() // resolves once the transports wrote out what they buffered
logger.pino // the underlying pino logger (escape hatch)
```

Methods: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `log(level, ...)`, `child`, `bindings`,
`isLevelEnabled`, `level`, `flush`, `close`. A `Logger` is also a valid `CoreLogger`. After `close()`
the logger stays usable: entries written afterwards are flushed right away (no batching), so they are
delivered before the process exits.

Every entry is enriched automatically:

| Field              | Source                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `requestId`        | the active request scope (`@znight/http#RequestId`, set by the HTTP plugin for each request)                     |
| `job`/`runId`      | the `JobContext` of the current scheduled run (`@znight/schedule#JobContext`, seeded in each run's scope)        |
| `traceId`/`spanId` | the active OpenTelemetry span (HTTP server span, consumer span, `@Traced()` span...)                             |
| custom fields      | `scopeFields: { tenant: 'src/tenant.ts#TenantId' }` reads more values from the scope; `mixin` adds computed ones |

You can create a `Logger` outside of an application: `new Logger({ level: 'debug' })`.

### Logger options

`ObservabilityPlugin.configure({ logging })` accepts every option below plus the request-log
options of the next section.

| Option         | Default                                   | Description                                                                                   |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `level`        | `LOG_LEVEL` env var, else `info`          | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`                                |
| `name`         | —                                         | Written as the `name` field                                                                   |
| `base`         | `{ pid, hostname }`                       | Fields of every entry; `null` for none                                                        |
| `redact`       | —                                         | Paths to censor: `['password', '*.token', 'users[*].email']` or `{ paths, censor?, remove? }` |
| `pretty`       | `false`                                   | `true` or `PrettyOptions`: human-readable output through `pino-pretty` (development)          |
| `transport`    | `consoleTransport()`                      | One transport or an array (see below)                                                         |
| `destination`  | —                                         | Any stream with `write(line)`, added to the transports (handy in tests)                       |
| `timestamp`    | `'epoch'`                                 | `'epoch'` (ms), `'iso'` or `false`                                                            |
| `messageKey`   | `'msg'`                                   | Key of the message                                                                            |
| `serializers`  | `err`, `error`                            | Per-key serializers                                                                           |
| `mixin`        | —                                         | `() => fields` added to every entry                                                           |
| `scopeFields`  | `{ requestId: '@znight/http#RequestId' }` | Log field → scope token                                                                       |
| `jobContext`   | `true`                                    | Add `job` / `runId` inside a scheduled run (`@znight/schedule`)                               |
| `traceContext` | `true`                                    | Add `traceId` / `spanId`                                                                      |
| `pino`         | —                                         | Raw pino options, applied last                                                                |

Redaction is applied by pino with precompiled paths: it is cheap and also covers what `@Logged({ args:
true })` logs (`args[0].password`).

### Transports

```ts
import { cloudwatchTransport, consoleTransport, datadogTransport, ObservabilityPlugin } from '@znight/observability'

ObservabilityPlugin.configure({
  logging: {
    transport: [
      consoleTransport(), // JSON lines on stdout
      datadogTransport({ service: 'users-api', level: 'warn' }), // warnings and errors also go to Datadog
    ],
  },
})
```

| Transport                       | Use it for                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `consoleTransport(options?)`    | The default: newline-delimited JSON on stdout (`fd: 1 \| 2`, `sync`, `level`). What Docker, Kubernetes and log shippers expect.                                                                                                                        |
| `prettyTransport(options?)`     | Development: colored, human-readable output via the optional `pino-pretty` peer (`colorize`, `translateTime`, `ignore`, `singleLine`, `options`). Runs in the main thread (no worker), identical on Node.js and Bun. Also `logging: { pretty: true }`. |
| `cloudwatchTransport(options?)` | Amazon CloudWatch Logs and AWS Lambda (see below).                                                                                                                                                                                                     |
| `datadogTransport(options?)`    | Shipping directly to the Datadog HTTP logs intake (see below).                                                                                                                                                                                         |

A transport is a plain object (`{ name, stream, level?, loggerOptions?, flush?, close? }`): write your
own by implementing `LogTransport`. The `level` of a transport only raises the logger level.

Asynchronous writes to stdout (the console default) stay in order, even when the output is slow (a
pipe, a busy CI runner, a log collector): `flush()` waits for the writes in flight instead of forcing
the queued entries out ahead of them, and the process does not exit before they are written.

#### CloudWatch and AWS Lambda

`cloudwatchTransport()` writes one JSON object per line to stdout, **synchronously** (Lambda freezes
the process as soon as the handler returns, asynchronously buffered lines could be lost), shaped the
way Lambda's JSON log format and CloudWatch Logs Insights expect:

```json
{
  "level": "INFO",
  "timestamp": "2026-10-26T12:00:00.000Z",
  "requestId": "9f1c",
  "orderId": "o1",
  "message": "Order stored"
}
```

- `timestamp` (ISO 8601 / RFC 3339), upper-case `level` and `message`: the keys Lambda uses for its
  log-level filtering (`AWS_LAMBDA_LOG_LEVEL`) and Logs Insights discovers automatically
  (`fields @timestamp, level, message | filter level = "ERROR"`);
- no `pid` / `hostname` (the log stream identifies the source; `includeProcessInfo: true` keeps them).

No AWS SDK call is made: the Lambda runtime, the ECS `awslogs` driver, the CloudWatch agent or Fluent
Bit ship stdout. To follow Lambda's configured level: `level: process.env.AWS_LAMBDA_LOG_LEVEL?.toLowerCase()`.

#### Datadog

`datadogTransport()` posts to `https://http-intake.logs.<site>/api/v2/logs` with `fetch`:

- batches by count (`batchSize`, default 100, max 1000), size (`maxBatchBytes`, 4 MB) and time
  (`flushIntervalMs`, 2 s); gzip-compressed (`compress`);
- retries network errors, 408, 429 (honouring `Retry-After`) and 5xx with exponential backoff
  (`maxRetries` 3, `retryDelayMs` 500); other statuses drop the batch;
- bounded memory (`maxBufferSize`, 10 000 entries, the oldest are dropped); losses are reported to
  `onError(error, dropped)` (default: one line on stderr), never thrown into your code;
- maps entries to Datadog reserved attributes: `message`, `status` (`warn` → `warning`, `fatal` →
  `critical`), `timestamp`, `service`, `hostname`, `ddsource`, `ddtags`, `error.kind` / `error.message`
  / `error.stack` (Error Tracking) and `dd.trace_id` / `dd.span_id` (trace correlation, from the
  OpenTelemetry ids). Entry fields that clash with these attributes are kept, never overwritten: an
  HTTP status code in `status` (the request logs) becomes `http.status_code`; another `status`, a
  `message` field next to the log message and a `timestamp` field next to the log time go under
  `attributes` (`attributes.status`, `attributes.message`, `attributes.timestamp`);
- reads `DD_API_KEY` (required, otherwise `ZNIGHT006`), `DD_SITE`, `DD_SERVICE`, `DD_ENV` and
  `DD_VERSION` (added to `ddtags`).

| Option             | Default                     | Option             | Default                |
| ------------------ | --------------------------- | ------------------ | ---------------------- |
| `apiKey`           | `DD_API_KEY`                | `batchSize`        | `100`                  |
| `site`             | `DD_SITE` / `datadoghq.com` | `maxBatchBytes`    | `4_000_000`            |
| `url`              | intake of `site`            | `flushIntervalMs`  | `2000`                 |
| `service`          | `DD_SERVICE`                | `maxBufferSize`    | `10_000`               |
| `source`           | `nodejs`                    | `maxRetries`       | `3`                    |
| `hostname`         | OS host name                | `retryDelayMs`     | `500`                  |
| `tags`             | `env:`/`version:` from env  | `timeoutMs`        | `10_000`               |
| `traceCorrelation` | `true`                      | `compress`         | `true`                 |
| `level`            | every entry                 | `fetch`, `onError` | global `fetch`, stderr |

The plugin flushes the logger in `onDispose`, and every entry logged afterwards (the framework's
final `Application stopped` or `The application stopped with errors`) is flushed as soon as it is
written: the pending request keeps the process alive until it is delivered. Standalone, call
`await logger.close()` (or `transport.close()`) before exiting.

### Request, message and job logs

The plugin writes one entry per HTTP request (`request completed` / `request failed`), per message
delivery (`message processed`, `message failed, will be retried`, `message dead-lettered`) and per
scheduled run of `@znight/schedule` (`job completed`, `job failed`, `job skipped`, `job not
acquired`):

| Option              | Default | Description                                                                                                                                             |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requests`          | `true`  | `false`, or `{ level?, ignore?(event) }`. 4xx are `warn`, 5xx `error` (with `err`).                                                                     |
| `messages`          | `true`  | `false`, or `{ level?, ignore?(event) }`. Retries are `warn`, dead letters `error`.                                                                     |
| `jobs`              | `true`  | `false`, or `{ level?, ignore?(event) }`. Failed runs are `error` (with `err`), skipped `warn`, not acquired (another instance holds the lock) `debug`. |
| `replaceCoreLogger` | `true`  | Route the framework's own logs (core, plugins) through the logger, with `component: 'znight'`.                                                          |

```ts
ObservabilityPlugin.configure({
  logging: { requests: { ignore: event => event.path === '/health' } },
})
```

Job entries carry `job`, `runId`, `trigger`, `scheduledAt`, plus `durationMs` for executed runs,
`lateMs` (start minus occurrence) for dispatched runs and `aborted` when the run's signal was
aborted. Executed runs are logged inside their span (the entry carries `traceId`). A run vetoed by
a `schedule:run` wrapper that does not call `next()` (feature flag, maintenance window) is `job
skipped` at `warn`, without `durationMs` or `err`, wherever that wrapper sits relative to the
plugin's own.

## Metrics

Metrics are enabled when the optional peer `prom-client` is installed (`metrics: false` disables them,
`metrics: true` or an object requires it). The plugin then:

- provides an injectable `MetricsRegistry`;
- records HTTP and messaging metrics through the hooks;
- serves everything on a dedicated server (default `http://0.0.0.0:9464/metrics`), started in
  `onStart`, closed in `onStop`. It is separate from your API: no auth, middleware or routing
  interference, and it is not exposed through the public load balancer.

### `MetricsRegistry`

```ts
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

`counter`, `gauge`, `histogram` and `summary` are **get-or-create**: asking twice for the same name
returns the same metric, and a conflicting definition (other type or labels) throws a `ZNIGHT005`
error. `metrics()` returns the exposition text, `contentType` its content type, `reset()` resets the
values, `registry` / `client` expose `prom-client`.

### HTTP RED metrics

| Metric                                 | Type      | Labels                      |
| -------------------------------------- | --------- | --------------------------- |
| `http_server_requests_total`           | counter   | `method`, `route`, `status` |
| `http_server_request_duration_seconds` | histogram | `method`, `route`, `status` |
| `http_server_active_requests`          | gauge     | `method`                    |

`route` is the route pattern (`/users/:id`), `unmatched` when no route matched, never the raw path;
unknown methods become `_OTHER`: label cardinality stays bounded. Durations start at the HTTP layer's
`startTime` (routing included). Default buckets: OpenTelemetry's (`0.005` … `10` s).

### Messaging metrics

| Metric                               | Type      | Labels                                 |
| ------------------------------------ | --------- | -------------------------------------- |
| `messaging_messages_processed_total` | counter   | `queue`, `consumer`, `type`, `outcome` |
| `messaging_process_duration_seconds` | histogram | `queue`, `consumer`, `type`, `outcome` |
| `messaging_active_messages`          | gauge     | `queue`                                |

`outcome` is `ack`, `retry`, `dead-letter`, or `error` when the pipeline itself threw. `type` is the
message type when a handler matched, `unmatched` otherwise (never the raw type of an unhandled
delivery: producers choose it); a handler records at most `maxTypesPerHandler` (50) distinct types,
later ones are labelled `_OTHER` (a pattern or default `@OnMessage()` handler receives whatever types
producers send). Label cardinality stays bounded.

### Scheduled job metrics

| Metric                                    | Type      | Labels                                       |
| ----------------------------------------- | --------- | -------------------------------------------- |
| `schedule_runs_total`                     | counter   | `job`, `outcome` (every occurrence)          |
| `schedule_run_duration_seconds`           | histogram | `job`, `outcome` (executed runs)             |
| `schedule_run_lateness_seconds`           | histogram | `job` (start minus occurrence)               |
| `schedule_active_runs`                    | gauge     | `job`                                        |
| `schedule_last_success_timestamp_seconds` | gauge     | `job` (for "has not succeeded since" alerts) |

`outcome` is `completed`, `failed`, `skipped` or `not-acquired`. A run vetoed by a `schedule:run`
wrapper that does not call `next()` is counted as `skipped`, but neither timed nor counted as a
success: a maintenance window that blocks a job keeps its staleness alert firing (the lateness
histogram, the scheduler's dispatch delay, still observes it when the vetoing wrapper is registered
after the plugin). Dynamic job names can be unbounded
(one job per monitor...): at most `maxJobs` (100) distinct names are labelled, later ones are
`_OTHER`.

```yaml
# Prometheus alert: the daily digest has not succeeded for 26 hours
- alert: DigestStale
  expr: time() - znight_schedule_last_success_timestamp_seconds{job="digest.daily"} > 26 * 3600
```

### Metrics options

| Option           | Default        | Description                                                                                                               |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `prefix`         | `''`           | Prefix of every metric name (`myapp_`)                                                                                    |
| `defaultLabels`  | —              | Labels added to every series (`{ service: 'users' }`)                                                                     |
| `defaultMetrics` | `true`         | Process metrics (CPU, memory, event loop lag, GC...), or `{ prefix?, gcDurationBuckets?, eventLoopMonitoringPrecision? }` |
| `server`         | `true`         | `false`, or `{ port: 9464, host?, path: '/metrics' }` (`port: 0` picks a free port)                                       |
| `http`           | `true`         | `false`, or `{ buckets?, ignore?(event) }`                                                                                |
| `messaging`      | `true`         | `false`, or `{ buckets?, ignore?(event), maxTypesPerHandler? }`                                                           |
| `schedule`       | `true`         | `false`, or `{ buckets?, latenessBuckets?, ignore?(event), maxJobs? }`                                                    |
| `registry`       | a new registry | An existing `prom-client` registry (e.g. `client.register`, the global one)                                               |
| `client`         | loaded lazily  | The `prom-client` module, for exotic bundling setups                                                                      |

The default metrics are process-wide: `prom-client` never releases their collectors (GC observer,
event loop delay monitor), so they are collected once per configuration (prefix, buckets, precision)
and shared by every registry of the process (each with its own `defaultLabels`). A disposed
application's registry is garbage collected, and `reset()` also resets those shared values.

## Tracing

Znight only uses the OpenTelemetry **API**: register any SDK and spans are exported; without SDK,
spans are no-ops, but incoming trace ids still reach the logs, the `traceresponse` header and the
messages published while handling the request. For example, with the Node SDK loaded before the
application (`node --import ./src/instrumentation.ts`):

```ts
// src/instrumentation.ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

new NodeSDK({ serviceName: 'users-api', traceExporter: new OTLPTraceExporter() }).start()
```

> Nesting spans and correlating logs and published messages need a context manager. The SDKs register
> one; when nothing did by the time a context is first activated (first request, delivery, publish
> or `withSpan()`), Znight registers a minimal `AsyncLocalStorage` one. Register your SDK (or
> `AsyncLocalStorageContextManager` from `@opentelemetry/context-async-hooks`, with a bare
> `BasicTracerProvider`) before the application handles its first request: a context manager
> registered later is refused by the OpenTelemetry API.

### HTTP server spans

One `SERVER` span per request, named `GET /users/:id` (`GET` when no route matched), child of the
`traceparent` / `tracestate` request headers, active while the request is handled:

- attributes (stable HTTP semantic conventions): `http.request.method` (+ `http.request.method_original`
  for unknown methods), `url.path`, `http.route`, `http.response.status_code`, `user_agent.original`,
  `server.address` / `server.port` (`Host` / `X-Forwarded-Host`), `url.scheme` (`X-Forwarded-Proto`),
  `client.address` (`X-Forwarded-For`), `znight.request.id`;
- 5xx and unhandled errors set the status to `ERROR`, record the exception and `error.type`; 4xx leave
  it unset (client errors, as the conventions require);
- the response carries `traceresponse: 00-<trace-id>-<span-id>-<flags>` (W3C Trace Context level 2)
  so clients can find the trace (`responseHeader: 'x-trace-id'` renames it, `false` disables it).

### Consumer spans

One `CONSUMER` span per delivery, named `process <queue>`, child of the trace context found in the
message headers (case-insensitive): `messaging.operation.name` / `.type` (`process`),
`messaging.destination.name`, `messaging.message.id`, `messaging.system` (option `system`),
`znight.messaging.consumer`, `.handler`, `.message.type`, `.message.attempt`, `.outcome`. Retries,
dead letters and errors set the status to `ERROR`.

### Producer spans

Messages published with `MessageBroker.publish()` of `@znight/messaging` (its `messaging:publish`
hook) get a `PRODUCER` span named `send <queue>` (`messaging.operation.name` / `.type` = `send`,
`messaging.destination.name`, `messaging.message.id`), child of the active context (the HTTP request
that published it, for example), and its trace context is written into the message headers: the
consumer span continues the same trace across services.

For other outgoing calls (HTTP clients, custom brokers), inject the context into their headers
yourself: `tracer.inject(headers)`.

### Scheduled run spans

One `INTERNAL` span per executed run of `@znight/schedule`, named `schedule <job>`: the root of a new
trace (a scheduled run is its own unit of work), except for manual runs (`registry.trigger()`), which
are children of the caller (an admin request, for example). Attributes: `znight.schedule.job`,
`.kind`, `.trigger`, `.run_id`, `.scheduled_at`, `.outcome`, `.aborted`, `code.function.name`
(`DigestJobs.sendDaily`). A failed run sets the status to `ERROR` and records the exception.
Occurrences that did not run (skipped, not acquired) get no span, except a run vetoed by a
`schedule:run` wrapper registered after the plugin: its span is already open, and ends with the
outcome `skipped`.

### The `Tracer`

```ts
@Injectable()
export class PaymentService {
  constructor(private readonly tracer: Tracer) {}

  capture(order: Order) {
    return this.tracer.withSpan('payment.capture', async span => {
      span.setAttribute('payment.provider', 'stripe')
      return this.gateway.capture(order) // errors are recorded and rethrown, the span always ends
    })
  }
}
```

| Member                                | Description                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `withSpan(name, fn, options?)`        | Runs `fn` in an active span; ends it when `fn` returns or its promise settles; records errors. Sync stays sync. |
| `startSpan(name, options?, context?)` | A span you end yourself                                                                                         |
| `activeSpan()` / `traceContext()`     | The active span / `{ traceId, spanId, traceFlags, sampled }`                                                    |
| `inject(carrier, context?)`           | Writes `traceparent` / `tracestate` into headers                                                                |
| `extract(headers, context?)`          | Reads a remote parent from headers                                                                              |
| `withContext(context, fn)`            | Runs `fn` with a context active                                                                                 |
| `forceFlush()`                        | Exports buffered spans (called by the plugin in `onDispose`)                                                    |
| `otel`                                | The underlying OpenTelemetry tracer                                                                             |

### Tracing options

| Option           | Default                   | Description                                       |
| ---------------- | ------------------------- | ------------------------------------------------- |
| `tracerProvider` | the global one            | A specific `TracerProvider`                       |
| `propagator`     | global, else built-in W3C | `TextMapPropagator` used for `inject` / `extract` |
| `name`/`version` | `@znight/observability`   | Instrumentation scope                             |
| `http`           | `true`                    | `false`, or `{ ignore?(event), responseHeader? }` |
| `messaging`      | `true`                    | `false`, or `{ ignore?(event), system? }`         |
| `publish`        | `true`                    | `false`, or `{ ignore?(event), system? }`         |
| `schedule`       | `true`                    | `false`, or `{ ignore?(event) }`                  |

`tracing: false` disables the automatic spans; the injectable `Tracer` and `@Traced()` keep working.

## Decorators

Like every Znight decorator, they are compile-time markers: the compiler binds them to their
interceptor (a method wrapper installed on the instance, no Proxy). Options must be literals or
exported constants. Invalid options fail `Application.create()` with `ZNIGHT005`, naming the method.
Synchronous methods stay synchronous; async methods are measured until their promise settles.

### `@Logged(options?)`

One entry per call: `class`, `method`, `durationMs` (`<Class>.<method>() completed`), or `err` on failure
(`… failed`). Free when both levels are disabled.

| Option       | Default              | Description                                      |
| ------------ | -------------------- | ------------------------------------------------ |
| `level`      | `'debug'`            | Level of the success entry                       |
| `errorLevel` | `'error'`            | Level of the failure entry                       |
| `args`       | `false`              | Log the arguments (`args`), subject to redaction |
| `result`     | `false`              | Log the returned (resolved) value (`result`)     |
| `message`    | `<Class>.<method>()` | Message prefix                                   |

### `@Traced(options?)`

Runs the method in a child span of the active context (`code.function.name` attribute), active during
the call; errors are recorded.

| Option       | Default            | Description                                            |
| ------------ | ------------------ | ------------------------------------------------------ |
| `name`       | `<Class>.<method>` | Span name                                              |
| `attributes` | —                  | Static attributes                                      |
| `kind`       | `'internal'`       | `internal`, `server`, `client`, `producer`, `consumer` |

### `@Metric(options?)`

Records each call with the labels `class`, `method`, `outcome` (`success` / `error`).

| Option    | Default                                          | Description                                                            |
| --------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `type`    | `'histogram'`                                    | `histogram` (durations in seconds; `_count` counts calls) or `counter` |
| `name`    | `method_duration_seconds` / `method_calls_total` | Shared by every `@Metric()` method by default                          |
| `help`    | generic                                          | `# HELP` text                                                          |
| `labels`  | —                                                | Static labels (`{ tier: 'gold' }`)                                     |
| `buckets` | `prom-client`'s                                  | Histogram buckets                                                      |

Without metrics (`metrics: false` or no `prom-client`), `@Metric()` methods run unmeasured. A
conflicting metric definition is reported once through the logger and the method keeps working.

## The plugin

`ObservabilityPlugin.configure(options)` (name `observability`):

| Hook          | What happens                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`    | Validates decorator options, creates the logger, tracer and registry (object options), replaces the core logger, provides the externals, wraps `http:request`, `messaging:message` and `schedule:run` (spans → metrics → logs) and `messaging:publish` (producer spans), listens to `schedule:run` (run counters, logs of runs that did not execute) |
| `onBootstrap` | Evaluates function options if nothing did yet                                                                                                                                                                                                                                                                                                        |
| `onStart`     | Starts the `/metrics` server                                                                                                                                                                                                                                                                                                                         |
| `onStop`      | Closes the `/metrics` server                                                                                                                                                                                                                                                                                                                         |
| `onDispose`   | Removes the hook wrappers, flushes the tracer provider (`forceFlush`) and the logger transports; entries logged afterwards are flushed as soon as they are written                                                                                                                                                                                   |

Options may be computed from the container, e.g. from a config class:

```ts
ObservabilityPlugin.configure(container => ({
  logging: { level: container.get(AppConfig).logLevel },
}))
```

They are evaluated when the first observability provider is injected during `container.init()` (or in
`onBootstrap`), so the function may only use synchronous providers that do not themselves depend on
observability providers (typically config classes). The plugin instance exposes
`logger`, `tracer`, `metrics` and `metricsServer` (`app.getPlugin<ObservabilityPluginInstance>('observability')`).
Create one plugin per application.

### Without the plugin

Every piece works standalone:

```ts
const logger = new Logger({ level: 'debug' })
const tracer = new Tracer()
const metrics = new MetricsRegistry()

app.hooks.wrap('http:request', traceHttpRequests(tracer))
app.hooks.wrap('http:request', measureHttpRequests(metrics))
app.hooks.wrap('http:request', logHttpRequests(logger))
app.setLogger(toCoreLogger(logger))
await new MetricsServer(metrics, { port: 9464 }).listen()
```

`traceMessages`, `measureMessages` and `logMessages` do the same for `messaging:message`, and
`traceMessagePublish` for `messaging:publish`. For `schedule:run`, `traceJobs(tracer)` is a wrapper,
while `measureJobs(metrics)` and `logJobs(logger)` return `{ wrap, listen }`: install both (`listen`
sees the occurrences that did not run).

```ts
const jobs = logJobs(logger)
if (jobs.wrap) app.hooks.wrap('schedule:run', jobs.wrap)
if (jobs.listen) app.hooks.on('schedule:run', jobs.listen)
```

## Testing

- Capture logs with `destination`: `logging: { destination: { write: line => lines.push(JSON.parse(line)) } }`.
- Record spans with `@opentelemetry/sdk-trace-base`'s `InMemorySpanExporter`:
  `tracing: { tracerProvider: new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }) }`
  (plus an `AsyncLocalStorageContextManager` for nesting).
- Use `metrics: { defaultMetrics: false, server: { port: 0 } }` (or `server: false`) and read
  `await registry.metrics()`.

## Compiler contract

This package has **no compiler extension** and the generated code calls **no helper** from it. The
compiler only needs the manifest (`package.json#znight`, spec §7):

```jsonc
"znight": {
  "apiVersion": 1,
  "provides": [
    { "export": "Logger", "plugin": "ObservabilityPlugin", "scope": "singleton" },
    { "export": "MetricsRegistry", "plugin": "ObservabilityPlugin", "scope": "singleton" },
    { "export": "Tracer", "plugin": "ObservabilityPlugin", "scope": "singleton" },
    { "export": "LoggedInterceptor", "plugin": "ObservabilityPlugin", "scope": "singleton" },
    { "export": "TracedInterceptor", "plugin": "ObservabilityPlugin", "scope": "singleton" },
    { "export": "MetricInterceptor", "plugin": "ObservabilityPlugin", "scope": "singleton" }
  ],
  "interceptors": [
    { "decorator": "Logged", "interceptor": "LoggedInterceptor" },
    { "decorator": "Traced", "interceptor": "TracedInterceptor" },
    { "decorator": "Metric", "interceptor": "MetricInterceptor" }
  ]
}
```

What the compiler emits, and what the runtime relies on:

1. **Externals**: an injection point typed `Logger`, `Tracer`, `MetricsRegistry` (or one of the
   interceptors) binds to the token `@znight/observability#<Export>` (`ObservabilityTokens`), declared
   in `metadata.externals` with `providedBy: 'ObservabilityPlugin'`. The plugin registers all six in
   `register()`.
2. **Interceptors**: `@Logged(opts)` / `@Traced(opts)` / `@Metric(opts)` on a method add the interceptor
   external to the provider's `deps` and a binding `{ dep: <index of that token in deps>, options: <opts
   literal> }` to `interceptors[method].chain` (top-most decorator first), with
   `async: true` for `async` / `Promise`-returning methods. Without arguments, `options` is omitted
   (`undefined`).
3. **Options**: emitted as literals (`value` arguments, spec §4.6) of the shapes `LoggedOptions`,
   `TracedOptions` and `MetricOptions`. They are validated at boot by the plugin (`ZNIGHT005`).
   `@Traced({ attributes })` values must be strings, numbers, booleans or arrays of them.

```ts
['src/users/user.service.ts#UserService']: {
  scope: 'singleton',
  class: UserService,
  deps: ['src/users/user.repository.ts#UserRepository', '@znight/observability#Logger', '@znight/observability#LoggedInterceptor', '@znight/observability#TracedInterceptor'],
  factory: d => new UserService(d[0], d[1]),
  interceptors: {
    findById: { async: true, chain: [{ dep: 2, options: { level: 'debug', args: true } }, { dep: 3 }] },
  },
},
```

## Errors

| Code        | When                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZNIGHT001` | An optional peer (`prom-client`, `pino-pretty`) is required but not installed; `MetricsRegistry` injected while metrics are unavailable (wrapped in `ZNIGHT015`) |
| `ZNIGHT004` | The same plugin instance is used by two running applications                                                                                                     |
| `ZNIGHT005` | Invalid option (level, decorator options, metric conflict, port...)                                                                                              |
| `ZNIGHT006` | `datadogTransport()` without API key                                                                                                                             |

Instrumentation never changes the outcome of your code: a failing log destination, metric or span is
reported once (process warning) and the request, message or method proceeds normally.
