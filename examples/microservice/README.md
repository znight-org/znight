# Orders microservice

An event-driven **orders** service built with [Znight](../../README.md): an HTTP API on
[Hono](https://hono.dev) that stores orders and publishes an `OrderCreated` event, and a message
consumer that charges them asynchronously — with retries, dead letters, configuration, structured
logs, metrics and distributed tracing across HTTP and messaging.

As everywhere in Znight, the dependency injection container is **generated at build time**: no
`reflect-metadata`, no runtime scanning, and a missing provider or an invalid consumer is a compile
error with its location.

```
POST /orders ──► OrderController ──► OrderService ──► OrderRepository (in memory)
                                          │
                                          └─► MessageBroker.publish('orders.created', OrderCreated)
                                                    │  traceparent header (W3C trace context)
                                                    ▼
                         OrderCreatedConsumer ◄── orders.created ──(4 attempts failed / invalid)──► orders.created.dlq
                                │   @Retry exponential: 200 ms, 400 ms, 800 ms
                                ▼
                         PaymentGateway.charge ──► pending → confirmed | rejected | failed
GET /orders/:id ──► the order and its status
```

## What it shows

| Feature                                                                                                                                                | Where                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap, plugins, graceful shutdown (`SIGTERM` / `SIGINT`)                                                                                           | [`src/main.ts`](src/main.ts)                                                                                                                                          |
| HTTP on the **Hono** adapter, zod validation (`@Body`, `@Param` schemas), `201` + `location`, 404                                                      | [`src/orders/order.controller.ts`](src/orders/order.controller.ts), [`order.schemas.ts`](src/orders/order.schemas.ts)                                                 |
| Injection of an abstract class (port / adapter), runtime externals (`MessageBroker`, `Logger`, `Application`)                                          | [`order.service.ts`](src/orders/order.service.ts), [`order.repository.ts`](src/orders/order.repository.ts), [`health.controller.ts`](src/health/health.controller.ts) |
| Publishing an event through the injected `MessageBroker`                                                                                               | [`OrderService.create()`](src/orders/order.service.ts)                                                                                                                |
| `@Consumer`, `@OnMessage` with a validated `@Message(schema)`, `@Retry` (exponential), `NonRetryableError`, `@OnError`, dead-letter queue, idempotency | [`src/orders/order-created.consumer.ts`](src/orders/order-created.consumer.ts)                                                                                        |
| Broker chosen by configuration: in-memory by default, **RabbitMQ** with `RABBITMQ_URL`                                                                 | [`src/messaging/messaging.options.ts`](src/messaging/messaging.options.ts)                                                                                            |
| Typed, validated configuration classes (`@Config`, `@Env`, `@Secret`)                                                                                  | [`src/config/`](src/config)                                                                                                                                           |
| Structured logs with `requestId` / `traceId` / `spanId`, Prometheus metrics, `@Metric`, `@Traced`                                                      | [`src/observability/observability.options.ts`](src/observability/observability.options.ts), [`payment.gateway.ts`](src/payments/payment.gateway.ts)                   |
| OpenTelemetry: context propagation HTTP → publish → consume, spans kept in memory                                                                      | [`src/observability/tracing.ts`](src/observability/tracing.ts)                                                                                                        |
| A custom plugin (`tracing`), lifecycle / disposal hooks                                                                                                | [`tracing.ts`](src/observability/tracing.ts), [`InMemoryOrderRepository`](src/orders/order.repository.ts)                                                             |
| Readiness probe reading the consumers' state                                                                                                           | [`src/health/health.controller.ts`](src/health/health.controller.ts)                                                                                                  |
| Unit tests (`TestBed`), in-memory application tests (`TestApp`), end-to-end tests                                                                      | [`test/`](test)                                                                                                                                                       |

## Project layout

```txt
src/
├─ main.ts                          # Application.create() with the plugins, then start()
├─ .znight/                         # generated DI container (git-ignored)
├─ config/                          # @Config classes: HTTP, messaging, observability
├─ health/health.controller.ts      # GET /health (readiness)
├─ messaging/messaging.options.ts   # memory or RabbitMQ driver, from the configuration
├─ observability/                   # ObservabilityPlugin options, OpenTelemetry setup
├─ orders/                          # controller, service, repository, schemas, events, consumer
└─ payments/payment.gateway.ts      # simulated payment provider (test payment methods)
test/                               # TestBed, TestApp and end-to-end tests
vite.config.ts                      # znight() Vite plugin: dev, build
znight.config.ts                    # compiler options shared by Vite and the Bun preload
bunfig.toml                         # bun test: the preload regenerates the container
```

## Running it

In this repository, install once and build the framework packages (the `znight` CLI and the built
service run from their `dist`):

```sh
bun install                 # at the repository root
bun run build               # at the repository root
cd examples/microservice
```

| Bun                 | npm / Node.js       | What it does                                                                |
| ------------------- | ------------------- | --------------------------------------------------------------------------- |
| `bun run dev`       | `npm run dev`       | Build in watch mode, restart the service on every change (`znight dev`)     |
| `bun run build`     | `npm run build`     | Production build: `dist/main.js` (`znight build`)                           |
| `bun run start`     | `npm run start`     | Run the build on Node.js (`znight start`; `--runtime bun` to run it on Bun) |
| `bun run test`      | `npm test`          | Unit and application tests (`bun test`: Bun is required to run the tests)   |
| `bun run test:e2e`  | `npm run test:e2e`  | Build, start on Node.js and on Bun, test over HTTP, stop with `SIGTERM`     |
| `bun run typecheck` | `npm run typecheck` | Generate the container, then `tsc --noEmit`                                 |
| `bun run generate`  | `npm run generate`  | Generate `src/.znight/container.generated.ts` (`--check` in CI)             |

The service listens on `http://localhost:3000` and serves its metrics on
`http://localhost:9464/metrics`. The built file also runs directly: `node dist/main.js` or
`bun dist/main.js`.

### Configuration

Every setting is validated at startup (a wrong value stops the service with every problem listed),
from the environment or from `.env` / `.env.local` / `.env.<NODE_ENV>` files:

| Variable                | Default   | Description                                                              |
| ----------------------- | --------- | ------------------------------------------------------------------------ |
| `PORT`                  | `3000`    | HTTP port (`0`: a free port)                                             |
| `HTTP_HOST`             | `0.0.0.0` | Interface to bind                                                        |
| `HTTP_EXPOSE_ERRORS`    | `false`   | Error messages in 500 responses (development only)                       |
| `RABBITMQ_URL`          | —         | Use RabbitMQ (`amqp://user:pass@host:5672`); unset: the in-memory broker |
| `MESSAGING_CONCURRENCY` | `4`       | Messages handled concurrently by each consumer                           |
| `MESSAGING_QUEUE_TYPE`  | `quorum`  | `quorum` or `classic` queues on RabbitMQ                                 |
| `LOG_LEVEL`             | `info`    | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`           |
| `METRICS_PORT`          | `9464`    | Port of the Prometheus `/metrics` server (`0`: a free port)              |
| `SERVICE_NAME`          | `orders`  | `name` of the log entries, `service` label of the metrics                |

## Try it

```sh
# readiness: 200 once the consumers are subscribed, 503 while shutting down
curl localhost:3000/health

# create an order: 201 Created, status "pending", location: /orders/<id>
curl -i localhost:3000/orders -H 'content-type: application/json' \
  -d '{"customerId":"c-42","paymentMethod":"pm_card_visa","lines":[{"sku":"BOOK-42","quantity":2,"unitPrice":1250}]}'

# a few milliseconds later: "confirmed", with its paymentId
curl localhost:3000/orders/<id>
```

The simulated payment gateway has **test payment methods**, one per processing outcome:

| `paymentMethod`       | What happens                                                                                           | Final status |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ------------ |
| `pm_card_visa`        | charged at the first attempt                                                                           | `confirmed`  |
| `pm_card_declined`    | `PaymentDeclinedError` (a `NonRetryableError`): no retry, `@OnError` rejects the order and acks        | `rejected`   |
| `pm_card_flaky`       | the gateway times out twice: retried after 200 ms, then 400 ms, charged at the third attempt           | `confirmed`  |
| `pm_card_unavailable` | the gateway always fails: 4 attempts, then `@OnError` fails the order and the message is dead-lettered | `failed`     |

```sh
# invalid input: 400 with every issue, nothing stored nor published
curl localhost:3000/orders -H 'content-type: application/json' -d '{"customerId":"","lines":[]}'
# {"statusCode":400,"error":"Bad Request","message":"Invalid body","details":[{"path":"customerId",...},...]}

curl localhost:3000/orders/42          # 400: invalid param "id" (not a UUID)

# metrics: HTTP RED, messaging (processed / retried / dead-lettered, durations), business, process
curl -s localhost:9464/metrics | grep -E '^(messaging_|orders_|payment_)'
```

### Distributed tracing

Every request gets a `SERVER` span; publishing the event creates a `PRODUCER` span whose context is
written into the message headers (`traceparent`); the consumer continues the same trace in a
`CONSUMER` span, and `@Traced()` adds a `payment.charge` span. Every log line carries the
`traceId` / `spanId` of the active span, so one `traceId` follows the order from the HTTP request to
the payment. Send your own trace context to see it propagate, and read the trace id of any request
in the `traceresponse` response header:

```sh
curl -i localhost:3000/orders -H 'content-type: application/json' \
  -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -d '{"customerId":"c-42","paymentMethod":"pm_card_flaky","lines":[{"sku":"BOOK-42","quantity":1,"unitPrice":990}]}'
```

```json
{"level":30,"name":"orders","requestId":"a1b2…","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"e387…","orderId":"2908…","amount":990,"msg":"Order created"}
{"level":40,"name":"orders","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"1a48…","queue":"orders.created","attempt":1,"outcome":"retry","msg":"message failed, will be retried"}
{"level":30,"name":"orders","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"caea…","orderId":"2908…","paymentId":"pay_…","attempt":3,"msg":"Order confirmed"}
```

Spans are kept in memory by the tracer provider of [`tracing.ts`](src/observability/tracing.ts)
(the tests read them). In production, export them instead, e.g. with
`@opentelemetry/exporter-trace-otlp-http`:
`new BasicTracerProvider({ spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] })`.

### With RabbitMQ

```sh
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:4.1-management-alpine

RABBITMQ_URL=amqp://guest:guest@localhost:5672 bun run start    # or npm run start
```

At startup the driver declares the queues (quorum queues by default): `orders.created` and its
dead-letter queue `orders.created.dlq`. Retries shorter than 5 s are waited in-process, then the
message is republished through RabbitMQ with its attempt number (`x-znight-attempt`); longer delays
would use per-delay queues. Publications are confirmed by the broker. Open the management UI
(`http://localhost:15672`, guest / guest) after a `pm_card_unavailable` order: the dead-lettered
message waits in `orders.created.dlq`, with the `x-znight-dead-letter-reason`, `x-znight-error` and
`x-znight-attempts` headers telling an operator why.

`RABBITMQ_URL` is a `@Secret`: it never appears in logs or error messages. Nothing else changes in
the code: consumers and publishers do not know which broker they use.

## Tests

```sh
bun run test         # unit + application tests, a few seconds
bun run test:e2e     # end-to-end, ~10 s
ZNIGHT_INTEGRATION=1 bun run test:e2e   # also against RabbitMQ (Docker required)
```

- **Unit tests** ([`order.service.test.ts`](test/order.service.test.ts),
  [`order-created.consumer.test.ts`](test/order-created.consumer.test.ts),
  [`payment.gateway.test.ts`](test/payment.gateway.test.ts)): `TestBed.create(Class, { metadata })`
  builds a provider with its generated factory and auto-mocks its dependencies, including the
  runtime ones (`MessageBroker`, `Logger`) and the abstract `OrderRepository`.
- **Application tests** ([`orders.app.test.ts`](test/orders.app.test.ts)): `TestApp` starts the
  real application in memory — real plugins, in-memory broker, captured logs, recorded spans — and
  `app.inject()` sends HTTP requests without network. They cover every processing outcome, the
  dead-letter queue (`driver.deadLetters()`), an invalid payload sent by another producer
  (`driver.send()`), the span tree of a trace, the metrics and the disposal hooks.
- **End-to-end test** ([`e2e.test.ts`](test/e2e.test.ts), opt-in with `ZNIGHT_E2E=1`): runs
  `znight build`, starts `dist/main.js` with `znight start` on **Node.js and on Bun** (free ports read
  from the logs), runs the scenarios over HTTP, checks the trace ids in the logs and the metrics, then
  sends `SIGTERM` and expects exit code `0` after the shutdown hooks ran.

`bun test` regenerates the container first: `bunfig.toml` preloads `@znight/compiler/bun`, which reads
[`znight.config.ts`](znight.config.ts).

## Notes

- **Graceful shutdown.** On `SIGTERM` the plugins stop in reverse order: the HTTP server stops
  accepting connections and drains the requests in flight (the readiness probe answers `503` from
  then on), the consumers stop receiving and finish the messages in progress (in-process retry waits
  are aborted: those messages go back to the broker, never lost), then the providers are disposed
  (`InMemoryOrderRepository`) and the plugins release their resources (the `tracing` plugin shuts
  the tracer provider down). The process exits with code `0` (`1` if a step failed).
- **At-least-once delivery.** The consumer is idempotent (only `pending` orders are charged; the
  payment uses the order id as idempotency key), and the order id is the message id.
- **Type-only imports.** Constructor dependencies can be imported with `import type`: the compiler
  reads the types, and the generated container imports the classes itself.
- **Not production-ready on purpose**: the orders live in memory (use a database, and a
  transactional outbox to store the order and its event atomically), and the payment gateway is
  simulated.
- **In-repo specifics** (not needed in your own project): `tsconfig.json` resolves the workspace
  packages to their sources (`customConditions`, `allowImportingTsExtensions`); `vite.config.ts`
  keeps the workspace `@znight/*` packages external (`ssr.external`). The OpenTelemetry packages
  (`@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/context-async-hooks`) and
  `prom-client` are not dependencies of this workspace yet: they are resolved from the copies
  installed for `@znight/observability` (`paths` in `tsconfig.json`, `resolve.alias` in
  `vite.config.ts`). In your project, add them to your dependencies and drop those settings.
