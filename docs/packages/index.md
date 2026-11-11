---
description: The Znight packages - core runtime, compiler, HTTP, OpenAPI, GraphQL, WebSocket, messaging, events, scheduling, config, observability, testing and CLI - and how they fit together.
---

# Packages

Znight is split into small packages, versioned together (all `@znight/*` packages share the same
version; a mismatch is reported as [`ZNIGHT018`](/reference/error-codes#znight018)). Install only
what you use.

| Package                                    | What it gives you                                                                                                 | Install as    | Status                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------- |
| [`@znight/core`](./core)                   | Container, application lifecycle, plugins, hooks, AOP, marker decorators                                          | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/compiler`](./compiler)           | Vite plugin, CLI/Bun integration: analysis, validation, code generation                                           | devDependency | <Badge type="tip" text="available" /> |
| [`@znight/http`](./http)                   | Controllers, validation, guards, access decisions, files, cookies, SSE, CORS; `node:http`, Fastify, Express, Hono | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/openapi`](./openapi)             | OpenAPI 3.1 documents generated at build time; Scalar or Swagger UI                                               | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/graphql`](./graphql)             | GraphQL: schema from TypeScript types or SDL files checked at build time, loaders, subscriptions over SSE         | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/websocket`](./websocket)         | WebSocket gateways on the HTTP server: validated events, replies, rooms, backpressure                             | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/events`](./events)               | In-process application events: `@OnEvent` listeners checked at build time, inline or detached dispatch            | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/messaging`](./messaging)         | Consumers, retries, dead-letter queues; RabbitMQ, SQS, Kafka, Pub/Sub, NATS, Service Bus, Redis, in-memory        | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/schedule`](./schedule)           | Cron, interval and timeout jobs checked at build time; locks across instances                                     | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/config`](./config)               | Typed config classes from env, `.env`, JSON/YAML, Vault, AWS/GCP/Azure/OCI secrets                                | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/observability`](./observability) | Pino logger, Prometheus metrics, OpenTelemetry tracing                                                            | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/testing`](./testing)             | `TestBed` with auto-mocks, `TestApp` for in-memory end-to-end tests                                               | devDependency | <Badge type="tip" text="available" /> |
| [`@znight/cli`](./cli)                     | `znight new`, `generate`, `dev`, `build`, `start`, `openapi`, code generators                                     | devDependency | <Badge type="tip" text="available" /> |

## Guides and reference

Package pages are the reference (install, options, decorators, exports, the compiler contract,
limitations); the guide explains how to use them.

| Package                 | Guide                                                                                                                                                  | Reference                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `@znight/core`          | [Dependency injection](/guide/dependency-injection), [Lifecycle](/guide/lifecycle), [Plugins](/guide/plugins), [AOP](/guide/aop)                       | [core](./core)                   |
| `@znight/compiler`      | [Automatic wiring](/guide/automatic-wiring), [The compiler](/guide/compiler)                                                                           | [compiler](./compiler)           |
| `@znight/http`          | [Controllers and routes](/guide/http), [Validation](/guide/validation), [Files and streaming](/guide/files-and-streaming), [Security](/guide/security) | [http](./http)                   |
| `@znight/openapi`       | [OpenAPI](/guide/openapi)                                                                                                                              | [openapi](./openapi)             |
| `@znight/graphql`       | [GraphQL](/guide/graphql)                                                                                                                              | [graphql](./graphql)             |
| `@znight/websocket`     | [WebSockets](/guide/websockets)                                                                                                                        | [websocket](./websocket)         |
| `@znight/events`        | [Application events](/guide/events)                                                                                                                    | [events](./events)               |
| `@znight/messaging`     | [Messaging](/guide/messaging)                                                                                                                          | [messaging](./messaging)         |
| `@znight/schedule`      | [Scheduling](/guide/scheduling)                                                                                                                        | [schedule](./schedule)           |
| `@znight/config`        | [Configuration](/guide/configuration)                                                                                                                  | [config](./config)               |
| `@znight/observability` | [Observability](/guide/observability)                                                                                                                  | [observability](./observability) |
| `@znight/testing`       | [Testing](/guide/testing)                                                                                                                              | [testing](./testing)             |
| `@znight/cli`           | [Getting started](/guide/getting-started), [Deployment](/guide/deployment)                                                                             | [cli](./cli)                     |

## Not a package (on purpose)

| You need...        | In Znight                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security           | Built into [`@znight/http`](./http): access decisions checked at build time and at boot, CORS, security headers, trusted proxies; recipes in the [Security guide](/guide/security) |
| A database, an ORM | The client of your choice, provided by a `@Factory()`; Drizzle recommended for SQL ([Data access](/guide/data-access))                                                             |
| Caching            | A method interceptor ([recipe](/guide/aop#cache)); `@znight/cache` is on the [roadmap](/roadmap#znight-cache)                                                                      |

## How a feature package is built

Every feature package follows the same three-part shape, here `@znight/http`:

![Anatomy of a feature package: the decorators (@Controller, @Get, @Body) are markers in your code; the compiler extension @znight/http/compiler analyses the controllers at build time and emits extensions.http in the generated metadata; the runtime plugin HttpPlugin.configure() reads it and serves the requests](/diagrams/feature-package.svg)

- The **decorators** are imported by your code. They do nothing at runtime and are stripped from the
  bundle.
- The **compiler extension** is discovered through the package's manifest (`package.json#znight`)
  when the package is installed: no configuration needed.
- The **runtime plugin** is added to `Application.create({ plugins })`. It reads its section of the
  generated metadata and supplies the values it provides at runtime (`HttpContext`, `Logger`,
  `MessageBroker`...).

Third-party integrations (Fastify, amqplib, prom-client...) are **optional peer dependencies**: you install
the ones you use, and adapters or drivers live in subpath exports so unused ones are never loaded.

## Requirements

- Node.js 24+ or Bun 1.3+, ESM only.
- TypeScript with `experimentalDecorators` enabled (for parameter decorators).
- Vite 8 for the compiler's Vite plugin and the `znight dev` / `znight build` commands (not needed
  when you only use `znight generate` or the Bun preload).
