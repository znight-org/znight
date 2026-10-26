# Worker example

A background worker built with [Znight](../../README.md): **no HTTP server**, only message consumers.
It sends templated emails and generates reports from two queues, with typed payloads, retries,
dead letters, per-message context and a graceful shutdown that drains in-flight messages.

Like every Znight application, its dependency injection container is **generated at build time**
from the decorators (`src/.znight/container.generated.ts`): no `reflect-metadata`, no module to
declare, and a wiring mistake is a build error with its location.

## What it shows

| Feature                                                                               | Where                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Consumer` with `concurrency`, a custom `deadLetter` queue                           | [`email.consumer.ts`](src/emails/email.consumer.ts), [`report.consumer.ts`](src/reports/report.consumer.ts)                                                               |
| Typed payloads validated by Zod: `@Message(schema)`                                   | [`email.jobs.ts`](src/emails/email.jobs.ts), [`report.jobs.ts`](src/reports/report.jobs.ts)                                                                               |
| `@Retry` (exponential and fixed backoff), `NonRetryableError`                         | consumers, [`smtp.client.ts`](src/emails/smtp.client.ts), [`email.renderer.ts`](src/emails/email.renderer.ts)                                                             |
| `@OnError`: acknowledge expected failures, dead-letter the rest                       | [`email.consumer.ts`](src/emails/email.consumer.ts)                                                                                                                       |
| Request scope: one `JobContext` per message                                           | [`job-context.ts`](src/messaging/job-context.ts) (`scope: 'request'`), `Lazy<JobContext>` in [`email.service.ts`](src/emails/email.service.ts), a request-scoped consumer |
| `@Factory` / async `@Provides` with `dispose`                                         | [`smtp.factory.ts`](src/emails/smtp.factory.ts): a fake SMTP client, connected at boot, closed on shutdown                                                                |
| An abstract class as an injectable port                                               | `SmtpClient` in [`smtp.client.ts`](src/emails/smtp.client.ts)                                                                                                             |
| Publishing from a consumer: `MessageBroker`                                           | `ReportConsumer` emails the requester through the `emails.send` queue                                                                                                     |
| `@Config` classes, `@Env`, `@Secret`, `.env` files                                    | [`worker.config.ts`](src/worker.config.ts), [`smtp.config.ts`](src/emails/smtp.config.ts), [`reports.config.ts`](src/reports/reports.config.ts)                           |
| Structured JSON logs (pino), one entry per message                                    | `ObservabilityPlugin` in [`main.ts`](src/main.ts), `JobContext.logger`                                                                                                    |
| Memory broker by default, RabbitMQ when `RABBITMQ_URL` is set                         | [`driver.ts`](src/messaging/driver.ts)                                                                                                                                    |
| Custom plugins (an ingress, a keep-alive)                                             | [`stdin-inbox.plugin.ts`](src/messaging/stdin-inbox.plugin.ts), [`keep-alive.plugin.ts`](src/messaging/keep-alive.plugin.ts)                                              |
| Graceful shutdown that drains in-flight messages                                      | [`main.ts`](src/main.ts), proven by [`test/e2e.test.ts`](test/e2e.test.ts)                                                                                                |
| A publish-only Znight process                                                         | [`scripts/publish.ts`](scripts/publish.ts) (`MessagingPlugin` with `consume: false`)                                                                                      |
| Unit tests (`TestBed`), messaging tests (`TestApp` + memory broker), end-to-end tests | [`test/`](test)                                                                                                                                                           |

## Run it

In this repository, install once at the root and build the framework packages (the `znight` CLI and
Vite load them from `dist`):

```sh
bun install
bun run build        # at the repository root
cd examples/worker
```

| Bun                 | npm / Node.js       | What it does                                                                  |
| ------------------- | ------------------- | ----------------------------------------------------------------------------- |
| `bun run dev`       | `npm run dev`       | Build in watch mode, restart the worker on every change                       |
| `bun run build`     | `npm run build`     | Production build: `src/main.ts` → `dist/main.js`                              |
| `bun run start`     | `npm start`         | Run the build (`znight start --runtime bun` / `node` to pick the runtime)     |
| `bun run typecheck` | `npm run typecheck` | Generate the container, then `tsc --noEmit`                                   |
| `bun run generate`  | `npm run generate`  | Generate `src/.znight/container.generated.ts` (git-ignored)                   |
| `bun run test`      | `npm test`          | Unit and messaging tests (`bun test`: Bun is required to run the tests)       |
| `bun run test:e2e`  | `npm run test:e2e`  | Build, then run `dist/main.js` with Node.js **and** Bun (see [Tests](#tests)) |

The build runs as is on both runtimes: `node dist/main.js` or `bun dist/main.js`.

### Send jobs

There is no HTTP endpoint (so no `curl`): jobs arrive through the broker.

**With the in-memory broker** (default), messages live in the process. To feed it from outside, enable
the stdin inbox and write one JSON object per line. `scripts/publish.ts` prints such lines when
`RABBITMQ_URL` is not set:

```sh
bun run build
bun scripts/publish.ts demo | WORKER_STDIN_INBOX=true bun run start      # Ctrl+C to stop
node scripts/publish.ts demo | WORKER_STDIN_INBOX=true npm start         # the same with Node.js

# or by hand
echo '{"queue":"emails.send","type":"email.send","payload":{"to":"ada@example.com","template":"welcome","data":{"name":"Ada"}}}' \
  | WORKER_STDIN_INBOX=true node dist/main.js
```

(Do not enable the stdin inbox under `znight dev`: the application runs in a background process
group there and must not read the terminal.)

**With RabbitMQ**, start the worker first (it declares its queues), then publish:

```sh
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:4-management-alpine
echo 'RABBITMQ_URL=amqp://guest:guest@localhost:5672' > .env.local    # git-ignored

bun run dev                                    # terminal 1 (or: bun run build && bun run start)
bun scripts/publish.ts demo                    # terminal 2: every delivery path below
bun scripts/publish.ts email ada@example.com password-reset
bun scripts/publish.ts report q1 2026-01-01 2026-03-31 ada@example.com
bun scripts/publish.ts report yearly 2025-01-01 2025-12-31   # ~2 s: press Ctrl+C in terminal 1 meanwhile
```

The management UI (<http://localhost:15672>, guest / guest) shows the quorum queues the driver
declared: `emails.send`, `emails.send.dlq`, `reports.generate`, `reports.failed`.

`demo` publishes one job per delivery path. The fake SMTP server decides by recipient domain:

| Job                           | What happens                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| email to `ada@example.com`    | sent, acknowledged                                                                                   |
| email to `grace@flaky.test`   | SMTP 421 on the first attempt, retried 250 ms later, sent                                            |
| email to `ghost@bounce.test`  | SMTP 550 (`NonRetryableError`): `@OnError` suppresses the address and acknowledges the message       |
| email to `ops@down.test`      | SMTP 421 every time: 4 attempts (250 ms, 500 ms, 1 s apart), then `emails.send.dlq` (`max-attempts`) |
| email with an invalid address | rejected by the Zod schema: straight to `emails.send.dlq` (`validation`), the handler never runs     |
| report with `notify`          | CSV written to `REPORTS_OUTPUT_DIR`, then a `report-ready` email published to `emails.send`          |

## Configuration

`ConfigPlugin` loads `.env`, `.env.local`, `.env.<NODE_ENV>`, `.env.<NODE_ENV>.local`, then the
environment (which wins), and validates every `@Config` class before anything starts: a missing or
malformed value stops the boot with every problem listed. See [`.env.example`](.env.example).

| Variable                     | Default                                | Config class                                 |
| ---------------------------- | -------------------------------------- | -------------------------------------------- |
| `LOG_LEVEL`                  | `info`                                 | `WorkerConfig.logLevel`                      |
| `RABBITMQ_URL`               | — (memory broker)                      | `WorkerConfig.rabbitmqUrl` (secret, a `URL`) |
| `WORKER_STDIN_INBOX`         | `false`                                | `WorkerConfig.stdinInbox`                    |
| `SMTP_HOST`, `SMTP_PORT`     | `localhost`, `587`                     | `SmtpConfig`                                 |
| `SMTP_USER`, `SMTP_PASSWORD` | —                                      | `SmtpConfig` (`SMTP_PASSWORD` is a secret)   |
| `SMTP_FROM`                  | `Znight Worker <no-reply@example.com>` | `SmtpConfig.from`                            |
| `SMTP_LATENCY_MS`            | `20`                                   | `SmtpConfig.latencyMs` (fake server)         |
| `REPORTS_OUTPUT_DIR`         | `<tmp>/znight-worker/reports`          | `ReportsConfig.outputDir`                    |
| `REPORTS_MS_PER_DAY`         | `5`                                    | `ReportsConfig.msPerDay` (simulated cost)    |

Secrets are masked wherever the config is printed (`[REDACTED]`), including error messages.

## Architecture

```txt
src/
├─ main.ts                    # Application.create(): plugins, shutdown deadlines, start()
├─ worker.config.ts           # @Config('worker'): LOG_LEVEL, RABBITMQ_URL, WORKER_STDIN_INBOX
├─ .znight/                   # generated DI container (git-ignored)
├─ messaging/
│  ├─ driver.ts               # memory() or rabbitmq()
│  ├─ job-context.ts          # @Injectable({ scope: 'request' }): one per message
│  ├─ stdin-inbox.plugin.ts   # custom plugin: jobs from stdin → MessageBroker
│  └─ keep-alive.plugin.ts    # custom plugin: workaround, see Known limitations
├─ emails/
│  ├─ email.jobs.ts           # queue, type, Zod schema (shared with scripts/publish.ts)
│  ├─ email.consumer.ts       # @Consumer('emails.send'): @OnMessage, @Retry, @OnError
│  ├─ email.service.ts        # renders + sends, Lazy<JobContext>
│  ├─ email.renderer.ts       # templates (en, fr)
│  ├─ suppression.list.ts     # hard-bounced addresses
│  ├─ smtp.client.ts          # SmtpClient port + FakeSmtpClient
│  ├─ smtp.factory.ts         # @Factory: async @Provides({ dispose: 'close' })
│  └─ smtp.config.ts          # @Config('smtp')
└─ reports/
   ├─ report.jobs.ts          # queues, type, Zod schema
   ├─ report.consumer.ts      # @Consumer({ scope: 'request', deadLetter: 'reports.failed' })
   ├─ report.generator.ts     # builds CSV / JSON (simulated cost)
   ├─ report.store.ts         # atomic writes, idempotency on reportId
   └─ reports.config.ts       # @Config('reports')
```

**A delivery.** For each message, `MessagingPlugin` waits for a concurrency slot of the consumer
(`emails.send`: 4, `reports.generate`: 2), opens a request scope seeded with the `InboundMessage`,
runs it through the `messaging:message` hook (ObservabilityPlugin writes one log entry per
delivery), validates the payload with the handler's Zod schema and calls the handler. Then:

- success → acknowledged;
- a retryable error with attempts left → redelivered after the backoff (waited in-process when the
  driver allows it: 1 s with the memory driver, 5 s with RabbitMQ; otherwise a native delayed
  redelivery, e.g. RabbitMQ delay queues);
- a `NonRetryableError`, an invalid payload, an unknown type or the last attempt → `@OnError` →
  acknowledged when it returns `'ack'`, otherwise published to the dead-letter queue, then
  acknowledged.

**At-least-once.** A message can be delivered twice (crash, lost ack, redelivery), so handlers are
idempotent: emails carry a Message-ID derived from the job id (the server ignores a duplicate),
reports are keyed by `reportId` (an existing file is not generated again), and the report-ready
notification has a deterministic message id (`report-ready-<reportId>`).

**Scopes.** Consumers, services, config classes and the SMTP client are singletons, created once at
boot (the async SMTP factory is awaited before anything starts). `JobContext` is request-scoped: a
new one per message, built from the `InboundMessage`, with a logger bound to the job id, queue,
attempt and correlation id. `ReportConsumer` is itself request-scoped and injects it directly;
`EmailService`, a singleton, injects `Lazy<JobContext>` (injecting it directly would be the build
error ZNIGHT003, scope mismatch).

**Plugins**, in order: `ObservabilityPlugin` (first, so that its hooks wrap everything),
`ConfigPlugin`, `MessagingPlugin` (options computed from `WorkerConfig`), `StdinInboxPlugin`,
`KeepAlivePlugin`. Plugins start in that order and stop in reverse order.

**Graceful shutdown** (SIGTERM / SIGINT; a second signal forces the exit):

1. the stdin inbox stops reading (ingress first);
2. consumers stop receiving, `message.signal` is aborted (`ReportConsumer` logs it), and the
   in-flight messages run to completion — within `shutdown.hookTimeoutMs` (15 s here);
3. providers are disposed in reverse order: `SmtpClient.close()` (`@Provides({ dispose: 'close' })`);
4. the broker connection is closed, logs are flushed, the process exits with code 0.

A run, abridged (`time`, `pid`, `hostname` removed):

```json
{"level":30,"component":"smtp","host":"localhost","port":587,"msg":"SMTP connection opened"}
{"level":30,"component":"znight","queues":["emails.send","reports.generate"],"msg":"Messaging: 2 consumer(s) subscribed with the rabbitmq driver"}
{"level":30,"jobId":"c102e94f-…","queue":"reports.generate","attempt":1,"correlationId":"report-q1","reportId":"q1","kind":"sales","from":"2026-01-01","to":"2026-03-31","msg":"Generating report"}
{"level":40,"queue":"emails.send","type":"email.send","messageId":"71cb5a57-…","attempt":1,"consumer":"EmailConsumer","handler":"send","outcome":"retry","durationMs":21.4,"err":{"type":"SmtpUnavailableError","message":"421 localhost: too many connections, try again later"},"msg":"message failed, will be retried"}
{"level":30,"jobId":"71cb5a57-…","queue":"emails.send","attempt":2,"correlationId":"71cb5a57-…","to":"grace@flaky.test","template":"welcome","msg":"Email sent"}
{"level":30,"jobId":"c102e94f-…","queue":"reports.generate","attempt":1,"correlationId":"report-q1","reportId":"q1","rows":90,"location":"/tmp/znight-worker/reports/q1.csv","msg":"Report generated"}
{"level":30,"jobId":"report-ready-q1","queue":"emails.send","attempt":1,"correlationId":"report-q1","to":"ada@example.com","template":"report-ready","msg":"Email sent"}
{"level":30,"component":"znight","msg":"Received SIGTERM: shutting down gracefully"}
{"level":30,"jobId":"a2197f7f-…","queue":"reports.generate","attempt":1,"correlationId":"report-yearly","reportId":"yearly","msg":"Shutdown requested: finishing the report first"}
{"level":30,"jobId":"a2197f7f-…","queue":"reports.generate","attempt":1,"correlationId":"report-yearly","reportId":"yearly","rows":365,"location":"/tmp/znight-worker/reports/yearly.csv","msg":"Report generated"}
{"level":30,"component":"smtp","sent":3,"msg":"SMTP connection closed"}
{"level":30,"component":"znight","msg":"Application stopped"}
```

The report job and the email it triggered share a correlation id: one `grep` follows an operation
across queues.

## Tests

```sh
bun run test                   # unit + messaging tests
bun run test:e2e               # end-to-end: Node.js and Bun, memory broker
ZNIGHT_E2E_RABBITMQ_URL=amqp://guest:guest@localhost:5672 bun run test:e2e   # + RabbitMQ
```

`bunfig.toml` preloads `@znight/compiler/bun`: the container is regenerated (with the options of
`znight.config.ts`, shared with `vite.config.ts`) before the tests import it.

- **Unit tests** ([`email.service.test.ts`](test/email.service.test.ts),
  [`report.consumer.test.ts`](test/report.consumer.test.ts)...) use `TestBed`: the provider is built
  with its generated factory, its direct dependencies are auto-mocked (`mocks.get(SmtpClient)`),
  config classes are real instances (`config: { smtp: { from: '…' } }`), and a request-scoped
  `JobContext` can be provided.
- **Messaging tests** ([`worker.test.ts`](test/worker.test.ts)) start the whole worker with `TestApp`
  and the memory driver, then publish messages (`driver.send()` as an external producer,
  `MessageBroker.publish()` as the application) and assert the settlements, dead letters, files,
  sent emails and logs: retries, `@OnError`, validation, idempotency, request scope and the drain on
  `app.close()`.
- **End-to-end** ([`e2e.test.ts`](test/e2e.test.ts), skipped unless `ZNIGHT_E2E=1`): runs
  `znight build`, starts `dist/main.js` with `node` and with `bun`, writes jobs to the stdin inbox
  (or publishes them with `node scripts/publish.ts` to RabbitMQ when `ZNIGHT_E2E_RABBITMQ_URL` is
  set), waits for their outcomes in the JSON logs, then sends SIGTERM while a yearly report is
  being generated and asserts that it completes, that the SMTP client is closed afterwards and that
  the process exits with code 0.

## Known limitations

- **Memory broker**: messages are lost when the process exits (a job published during the shutdown,
  like a report-ready email, is never consumed). Use RabbitMQ for durability.
- **Keep-alive**: the memory driver holds no connection open, so without `KeepAlivePlugin` a worker
  consuming it with no other activity would exit right after starting, skipping its graceful
  shutdown. The plugin is a workaround, enabled only with the memory driver.
- **Duplicate deliveries handled concurrently** (two copies of one report at the same time) are not
  deduplicated: the store only skips reports that already exist. A lock (database row, Redis) would
  be needed for that.

## In this repository

The example is a workspace of the Znight monorepo, set up like a project created by `znight new`,
with two additions so that the framework is used from its TypeScript sources:

- `tsconfig.json`: `"customConditions": ["@znight/source"]`;
- the `test` scripts pass `--conditions=@znight/source` (Bun has no `bunfig.toml` setting for it).

`znight build` / `znight dev` bundle the workspace packages from their `dist` (run `bun run build` at
the root after changing them).
