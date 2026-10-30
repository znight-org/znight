---
description: The example applications of the Znight repository - a REST API with Drizzle, a secured API, an OpenAPI storefront, an uptime monitor with scheduled jobs, an event-driven microservice, a worker and a monorepo - what each one shows and how to run it.
---

# Examples

The repository ships seven example applications in
[`examples/`](https://github.com/znight-org/znight/tree/main/examples) (the monorepo one holds two
services and a shared library). They are production-shaped rather than minimal: configuration
validated at boot, structured logs, graceful shutdown, and tests at every level, including
end-to-end tests of the production build on Node.js **and** Bun. Several guides are written from
them: their code samples are files of the examples.

| Example                             | What it shows                                                                      | HTTP adapter |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| [`rest-api`](#rest-api)             | The reference HTTP service: Drizzle on PostgreSQL, API keys, files, observability  | Fastify      |
| [`secure-api`](#secure-api)         | Security end to end: JWT, API keys, cookie sessions, CSRF, rate limiting, webhooks | `node:http`  |
| [`storefront-api`](#storefront-api) | OpenAPI generated from the code, committed, served and checked; a typed client     | Hono         |
| [`uptime-monitor`](#uptime-monitor) | Scheduled and dynamic jobs, one runner across instances, live results over SSE     | Hono         |
| [`microservice`](#microservice)     | HTTP and messaging in one service, retries, dead letters, distributed tracing      | Hono         |
| [`worker`](#worker)                 | Message consumers without HTTP, request scope per message, draining on shutdown    | —            |
| [`monorepo`](#monorepo)             | Two services sharing a provider library, overriding its providers                  | Express      |

## Running an example {#running}

The examples use the framework from the workspace. Clone the repository, install, and build the
packages once (the `znight` CLI and the production builds load their `dist`):

```sh
git clone https://github.com/znight-org/znight.git
cd znight
bun install
bun run build

cd examples/rest-api
bun run dev
```

Every example application has the scripts of a project created by `znight new`, plus `test:e2e`:

| Script      | Does                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| `dev`       | `znight dev`: build in watch mode, restart on every change              |
| `build`     | `znight build`: the production bundle `dist/main.js`                    |
| `start`     | `znight start`: run the bundle (`--runtime node` or `--runtime bun`)    |
| `test`      | Unit and application tests with `bun test`                              |
| `test:e2e`  | Build, then run the bundle on Node.js and Bun and test it over the wire |
| `typecheck` | `znight generate && tsc --noEmit`                                       |
| `generate`  | Write `src/.znight/container.generated.ts` (`--check` in CI)            |

The application itself runs on Node.js 24+ or Bun 1.3+ (`npm run dev` works too); the tests use
`bun:test`. From the repository root, `bun run test:examples` runs the tests of every example. Each
README lists the endpoints with `curl` commands and the configuration variables.

All examples use `@znight/core`, `@znight/config` and `@znight/observability`, with
`@znight/compiler`, `@znight/cli` and `@znight/testing` as development dependencies. The lists below
name the other packages.

## rest-api

**Bookshelf REST API**: books with a cover image each, stored in PostgreSQL through Drizzle ORM. It is
the reference example of a Znight HTTP service and of the [recommended data layer](/guide/data-access).

- Drizzle on [PGlite](https://pglite.dev) (PostgreSQL in WebAssembly, no server needed) provided by a
  `@Factory`: async init, migrations at startup, disposal on shutdown.
- A repository behind an interface, injected by interface; domain errors mapped to `404` / `409`.
- Access decisions (`@Public` / `@Authenticated` / `@Roles`) checked at build time and at boot, API
  keys compared in constant time, the caller in a request-scoped provider read through `Lazy<T>`.
- Zod schemas, coerced query parameters, multipart upload with limits, downloads with `ETag` and
  ranges; CORS, security headers and trusted proxies.
- Logs with request ids, Prometheus metrics, `@Logged` and `@Metric`; graceful shutdown.
- Tests: `TestBed`, repository tests on a fresh migrated database per test, `TestApp`, end to end.

Packages: [`@znight/http`](/packages/http) (`@znight/http/fastify`). Libraries: Drizzle ORM, PGlite,
Zod, Fastify, prom-client.
[Source on GitHub](https://github.com/znight-org/znight/tree/main/examples/rest-api).

## secure-api

**Notes API**: an API secured end to end without any security package. It is the tested source of
the [Security guide](/guide/security): the recipes of the guide are its files, kept in sync by a test.

- One required access decision per route, deny by default, a guard declaring what it enforces
  ([`ZNIGHT023`](/reference/error-codes#znight023) at build time and at boot).
- JWT access tokens of an OIDC provider (pinned algorithm, issuer, audience, remote key set), API
  keys for a machine client, password sign-in with signed `__Host-` session cookies for a web
  front-end; several strategies on the same routes.
- An ownership policy as a guard, scrypt password hashing, CSRF protection, rate limiting as a route
  decision, signed webhooks over the raw body.
- CORS with credentials, security headers, trusted proxies, `@Secret` configuration and redacted
  logs.

Packages: [`@znight/http`](/packages/http) (built-in `node:http` adapter). Libraries: `jose`,
`rate-limiter-flexible`, Zod. Run `bun scripts/dev-token.ts > /dev/null` once before `bun run dev`: it
creates the development key pair.
[Source on GitHub](https://github.com/znight-org/znight/tree/main/examples/secure-api).

## storefront-api

**A small shop**: a public catalogue, carts and orders for customers, a back office. It is the
reference example of [`@znight/openapi`](/packages/openapi).

- The OpenAPI 3.1 document is generated from the code: paths and parameters from the routes, bodies
  from Zod and Valibot schemas, responses from annotated return types, descriptions from JSDoc, all
  checked at build time.
- Discriminated unions, generic responses, uploads and binary downloads, a streamed NDJSON export,
  security schemes per controller and route.
- The document is committed (`openapi.json`), served byte for byte with Scalar on `/docs`, and
  checked in CI (`bun run openapi:check`).
- A typed client generated with `openapi-typescript` drives the end-to-end tests; contract tests
  validate every documented response.

Packages: [`@znight/http`](/packages/http) (`@znight/http/hono`), [`@znight/openapi`](/packages/openapi).
Libraries: Hono, Zod, Valibot, `openapi-typescript`, `openapi-fetch`. The API reference is on
`http://localhost:3000/docs` with `bun run dev`.
[Source on GitHub](https://github.com/znight-org/znight/tree/main/examples/storefront-api).

## uptime-monitor

**An uptime monitor**: endpoints probed on their own schedules, results in PostgreSQL, a weekday
digest at 08:00 Paris time, a nightly purge, and a public status page with live results. It is the
reference example of [`@znight/schedule`](/packages/schedule) and the tested source of the
[Scheduling guide](/guide/scheduling).

- `@Cron` with time zones and `maxDuration`, `@Interval`, `@Timeout`, all checked at build time.
- Dynamic jobs, one per monitor, added and removed through `SchedulerRegistry`, with user schedules
  validated by the scheduler's own parser.
- A Postgres lock store so that each occurrence runs on exactly one instance; a Redis lock store
  recipe tested against a Redis container.
- Abort signals passed to `fetch`, batches that stop on shutdown, an idempotent outbox.
- Live results over Server-Sent Events (`@Sse`, `EventChannel`, replay with `Last-Event-ID`).
- Deterministic tests on a virtual clock: a daylight saving time switch, two instances sharing one
  database, an instance stopping mid-run.

Packages: [`@znight/http`](/packages/http) (`@znight/http/hono`), [`@znight/schedule`](/packages/schedule).
Libraries: Hono, PGlite, Zod; Testcontainers for `bun run test:integration` (Docker).
[Source on GitHub](https://github.com/znight-org/znight/tree/main/examples/uptime-monitor).

## microservice

**Orders microservice**: an HTTP API that stores orders and publishes an `OrderCreated` event, and a
consumer that charges them asynchronously.

- `@Consumer` / `@OnMessage` with validated payloads, `@Retry` with exponential backoff,
  `NonRetryableError`, `@OnError`, a dead-letter queue, idempotent handling.
- The broker chosen by configuration: in memory by default, RabbitMQ with `RABBITMQ_URL`.
- An abstract class as an injectable port, runtime-provided values (`MessageBroker`, `Logger`).
- Logs with request and trace ids, Prometheus metrics, OpenTelemetry context propagated from HTTP to
  the published message and its consumer; a custom plugin; a readiness probe.

Packages: [`@znight/http`](/packages/http) (`@znight/http/hono`), [`@znight/messaging`](/packages/messaging).
Libraries: Hono, Zod, amqplib, OpenTelemetry, prom-client.
[Source on GitHub](https://github.com/znight-org/znight/tree/main/examples/microservice).

## worker

**A background worker**: no HTTP server, only message consumers sending templated e-mails and
generating reports.

- `@Consumer` with concurrency and a custom dead-letter queue, `@Retry` with fixed and exponential
  backoff, `@OnError` to acknowledge expected failures.
- One request scope per message: a `JobContext` provider read through `Lazy<T>`, a request-scoped
  consumer.
- An async `@Factory` with `dispose` (a fake SMTP client connected at boot, closed on shutdown).
- Publishing from a consumer, a publish-only Znight process, custom plugins.
- A graceful shutdown that drains in-flight messages, proven by an end-to-end test.

Packages: [`@znight/messaging`](/packages/messaging). Libraries: Zod, amqplib. Jobs arrive through
the broker: with the in-memory one, `bun scripts/publish.ts demo | WORKER_STDIN_INBOX=true bun run start`
after a build (see the README).
[Source on GitHub](https://github.com/znight-org/znight/tree/main/examples/worker).

## monorepo

**Provider libraries**: two services sharing providers through a package of the monorepo, without any
module to import.

| Workspace                       | Package                                 | What it is                                                     |
| ------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `packages/shared`               | `@znight-examples/shared`               | A source provider library: clock, id generator, user directory |
| `services/users-api`            | `@znight-examples/users-api`            | Users CRUD over HTTP on the Express adapter                    |
| `services/notifications-worker` | `@znight-examples/notifications-worker` | A consumer sending welcome and goodbye notifications           |

What it shows:

- The library opts in from its `package.json` (`"znight": { "library": "source" }`): every service
  depending on it gets its providers, discovered and bound by the compiler.
- Library providers injected by class, interface and abstract class; a service overrides one with
  `@Primary()`, and the override applies inside the library too.
- Request bodies and message payloads validated by the same shared schemas.
- The compiled-library flow: the same library built to JavaScript with its provider manifest, then
  consumed by a copy of users-api.

Packages: [`@znight/http`](/packages/http) (`@znight/http/express`), [`@znight/messaging`](/packages/messaging).
Run each service from its folder (`cd services/users-api && bun run dev`). See
[provider libraries](/guide/compiler#provider-libraries).
[Source on GitHub](https://github.com/znight-org/znight/tree/main/examples/monorepo).

## Start your own

`znight new` creates a smaller application with the same layout and scripts, and the features you
pick (configuration, observability, messaging, scheduling, OpenAPI): see
[Getting started](/guide/getting-started).
