---
description: The Znight packages - core runtime, compiler, HTTP, messaging, config, observability, testing and CLI - and how they fit together.
---

# Packages

Znight is split into small packages, versioned together (all `@znight/*` packages share the same
version). Install only what you use.

| Package                                    | What it gives you                                                              | Install as    | Status                                |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ------------- | ------------------------------------- |
| [`@znight/core`](./core)                   | Container, application lifecycle, plugins, hooks, AOP, marker decorators       | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/compiler`](./compiler)           | Vite plugin, CLI/Bun integration: analysis, validation, code generation        | devDependency | <Badge type="tip" text="available" /> |
| [`@znight/http`](./http)                   | Controllers, routing, validation, guards, interceptors; Fastify, Express, Hono | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/messaging`](./messaging)         | Consumers, retries, dead-letter queues; RabbitMQ, SQS, Kafka, in-memory        | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/config`](./config)               | Typed config classes from env, `.env`, JSON/YAML, Vault, AWS Secrets Manager   | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/observability`](./observability) | Pino logger, Prometheus metrics, OpenTelemetry tracing                         | dependency    | <Badge type="tip" text="available" /> |
| [`@znight/testing`](./testing)             | `TestBed` with auto-mocks, `TestApp` for in-memory end-to-end tests            | devDependency | <Badge type="tip" text="available" /> |
| [`@znight/cli`](./cli)                     | `znight new`, `generate`, `dev`, `build`, `start`, code generators             | devDependency | <Badge type="tip" text="available" /> |

## How a feature package is built

Every feature package follows the same three-part shape:

```txt
@znight/http
├─ decorators          @Controller, @Get, @Body...   markers read by the compiler, no-ops at runtime
├─ compiler extension  @znight/http/compiler          analyses controllers, emits extensions.http
└─ runtime plugin      HttpPlugin.configure()         reads extensions.http, serves requests
```

- The **decorators** are imported by your code. They do nothing at runtime and are stripped from the
  bundle.
- The **compiler extension** is discovered through the package's manifest (`package.json#znight`)
  when the package is installed: no configuration needed.
- The **runtime plugin** is added to `Application.create({ plugins })`. It reads its section of the
  generated metadata and supplies the values it provides at runtime (`HttpContext`, `Logger`,
  `MessageBroker`...).

Third-party integrations (Fastify, amqplib, pino...) are **optional peer dependencies**: you install
the ones you use, and adapters or drivers live in subpath exports so unused ones are never loaded.

## Requirements

- Node.js 24+ or Bun 1.3+, ESM only.
- TypeScript with `experimentalDecorators` enabled (for parameter decorators).
- Vite 8 for the compiler's Vite plugin and the `znight dev` / `znight build` commands (not needed
  when you only use `znight generate` or the Bun preload).
