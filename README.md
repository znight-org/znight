<p align="center">
  <img src="./docs/public/logo.svg" alt="Znight" width="420" />
</p>

<h1 align="center">Znight</h1>

<p align="center">
  <strong>Compile-time dependency injection framework for TypeScript</strong>
</p>

<p align="center">
  No reflect-metadata • A generated, readable container • Wiring errors at build time
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick start</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#packages">Packages</a> •
  <a href="#contributing">Contributing</a>
</p>

---

Znight is a backend framework for TypeScript in the spirit of NestJS and Spring Boot: you write
**providers** (services, repositories, controllers, message consumers...) and a container wires them
together. The difference is _when_ the wiring happens: a compiler (a Vite plugin, also usable from
the CLI and Bun) reads your sources, binds every constructor parameter to a provider, validates the
whole graph and generates a plain TypeScript module. At runtime, the container only calls the
generated factories, in an order computed ahead of time.

It is the approach of [Micronaut](https://micronaut.io/) and [Dagger](https://dagger.dev/), brought
to TypeScript. Znight runs on Node.js 24+ and Bun 1.3+ (ESM only).

> [!NOTE]
> Znight is preparing its first release (`v0.1`). Every package below is implemented and tested on
> Node.js 24 and Bun, with runnable [example applications](#examples). Until 1.0, minor versions may
> still change APIs.

## Why Znight?

|                       | Runtime DI (NestJS, InversifyJS, tsyringe)   | Znight                                                    |
| --------------------- | -------------------------------------------- | --------------------------------------------------------- |
| Dependency resolution | Reflection at boot (`emitDecoratorMetadata`) | Static analysis at build time                             |
| Wiring mistakes       | Crash at startup, or on the first request    | Build error with a code, a location and a hint            |
| What runs in prod     | Decorators, metadata maps, resolution logic  | Generated factories called in a precomputed order         |
| Interfaces as tokens  | Erased at runtime: string tokens + `@Inject` | Injected by type, implementation found by the compiler    |
| Structure             | Modules, imports/exports, `forwardRef`       | One flat container, providers discovered by scanning      |
| Cold start            | Graph discovered and sorted on every boot    | Only your constructors run: the graph was solved at build |
| Debugging             | Framework internals                          | A readable `container.generated.ts` you can step through  |

## Features

- **Compile-time DI**: classes and interfaces (bound through `implements`), qualifiers, factories,
  optional, lazy and multi dependencies; `singleton`, `request` and `transient` scopes; lifecycle
  hooks; AOP interceptors.
- **Errors at build time**: missing providers, cycles, scope mismatches, ambiguous injections...
  fail the build with a `ZNIGHTxxx` code, a code frame and a hint.
- **HTTP**: controllers, Standard Schema validation (Zod, Valibot...), guards, interceptors, uploads
  and streams, cookies (signed, with secure defaults) and Server-Sent Events, on the built-in
  `node:http` server, Fastify, Express or Hono.
- **Security**: access decisions on every route, checked at build time and at boot, CORS, security
  headers on by default and trusted proxies; recipes for JWT, API keys, rate limiting and more in
  the [security guide](./docs/guide/security.md).
- **OpenAPI**: an OpenAPI 3.1 document generated from your controllers at build time, served with
  Scalar or Swagger UI, or emitted as `openapi.json` for CI.
- **Scheduling**: `@Cron`, `@Interval` and `@Timeout` jobs validated at build time, with time zones
  and one runner across instances.
- **Messaging**: consumers with retries and dead-letter queues on RabbitMQ, Amazon SQS, Kafka or in
  memory.
- **Configuration**: typed config classes loaded from environment variables, `.env`, JSON/YAML
  files, Vault or AWS Secrets Manager, validated at boot.
- **Observability**: Pino logging, Prometheus metrics and OpenTelemetry tracing, wired into every
  HTTP request, message delivery and scheduled run.
- **Testing**: `TestBed` with auto-mocked dependencies, `TestApp` for in-memory end-to-end tests
  (Vitest, Jest or `bun:test`).
- **CLI**: `znight new`, code generators, `znight dev` / `build` / `start`.

## Installation

Create a project with the CLI (it asks for the package manager, the HTTP adapter and the features):

```sh
npx @znight/cli new my-service   # or: bunx @znight/cli new my-service
```

Or add Znight to an existing project:

```sh
npm install @znight/core @znight/http
npm install -D @znight/compiler @znight/cli vite typescript @types/node
```

## Quick start

### 1. Configure TypeScript and Vite

Znight decorators use TypeScript's `experimentalDecorators`. You do **not** need
`emitDecoratorMetadata` nor `reflect-metadata`.

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "ESNext.Disposable"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "experimentalDecorators": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

The compiler is a Vite plugin. With its defaults, it builds a server application: entry
`src/main.ts`, output `dist/`, target `node24`.

```ts
// vite.config.ts
import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [znight()],
})
```

### 2. Write providers

A provider is any class the container creates for you: mark it with `@Injectable()` and declare its
dependencies as constructor parameters. Interfaces work too: the compiler binds them to their
implementation.

```ts
// src/users/user.repository.ts
import { Injectable } from '@znight/core'

export interface User {
  id: number
  name: string
}

export interface UserRepository {
  findById(id: number): Promise<User | undefined>
}

@Injectable()
export class InMemoryUserRepository implements UserRepository {
  readonly #users = new Map<number, User>([[1, { id: 1, name: 'Ada Lovelace' }]])

  async findById(id: number): Promise<User | undefined> {
    return this.#users.get(id)
  }
}
```

```ts
// src/users/user.service.ts
import { Injectable } from '@znight/core'
import type { User, UserRepository } from './user.repository.js'

@Injectable()
export class UserService {
  // An interface: the compiler binds it to InMemoryUserRepository, its only implementation
  constructor(private readonly users: UserRepository) {}

  findById(id: number): Promise<User | undefined> {
    return this.users.findById(id)
  }
}
```

### 3. Add a controller

Route parameters are extracted and coerced for you: `id` arrives as a `number`, and an invalid value
is answered with `400 Bad Request`.

```ts
// src/users/user.controller.ts
import { Controller, Get, NotFoundException, Param } from '@znight/http'
import type { User } from './user.repository.js'
import { UserService } from './user.service.js'

@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('/:id')
  async getUser(@Param('id') id: number): Promise<User> {
    const user = await this.users.findById(id)
    if (user === undefined) throw new NotFoundException(`User ${id} not found`)
    return user
  }
}
```

### 4. Bootstrap

`main.ts` imports the metadata generated by the compiler and creates the application with its
plugins:

```ts
// src/main.ts
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000 })], // built-in node:http server
})

await app.start() // Ctrl+C (SIGINT) or SIGTERM stops it gracefully
```

The generated container (`src/.znight/container.generated.ts`) is rebuilt from your sources every
time: add `.znight` to your `.gitignore`.

### 5. Build and run

```sh
npx vite build      # compiles the container, bundles to dist/
node dist/main.js   # or: bun dist/main.js

curl http://localhost:3000/users/1
# {"id":1,"name":"Ada Lovelace"}
```

During development, `npx znight dev` rebuilds in watch mode and restarts the process after every
successful build. Bun can also run the sources directly with the compiler's Bun preload:
`bun --preload @znight/compiler/bun src/main.ts`.

**That's it.** No modules to declare, no metadata to emit: open `src/.znight/container.generated.ts`
to see the plain TypeScript the compiler wrote, with `UserRepository` bound to
`InMemoryUserRepository`.

## Errors at build time

Comment out `@Injectable()` on `InMemoryUserRepository` and the build fails, before anything is
deployed:

```txt
$ npx znight generate

✗ ZNIGHT001: Missing provider for 'UserRepository' required by UserService
 --> src/users/user.service.ts:7:39
  |
7 |   constructor(private readonly users: UserRepository) {}
  |                                       ^^^^^^^^^^^^^^
  = hint: InMemoryUserRepository (src/users/user.repository.ts:13) implements UserRepository but is not a provider: add @Injectable()

✗ Generation failed with 1 error
```

Missing providers, cycles, scope mismatches, ambiguous injections, invalid routes or consumers:
every diagnostic has a stable code explained in the [error reference](./docs/reference/error-codes.md).

## Adapters and drivers

Integrations live in subpath exports and are optional peer dependencies: install the ones you use,
unused ones are never loaded.

### HTTP adapters

Without `adapter`, `HttpPlugin` serves requests with the built-in `node:http` server. Every adapter
behaves the same, on Node.js and Bun.

```ts
import { HttpPlugin } from '@znight/http'
import { fastifyAdapter } from '@znight/http/fastify'
// or: expressAdapter from '@znight/http/express', honoAdapter from '@znight/http/hono'

HttpPlugin.configure({ adapter: fastifyAdapter(), port: 3000 })
```

### Messaging drivers

```ts
// src/main.ts
import { Application } from '@znight/core'
import { MessagingPlugin } from '@znight/messaging'
import { rabbitmq } from '@znight/messaging/rabbitmq'
// or: sqs from '@znight/messaging/sqs', kafka from '@znight/messaging/kafka', memory from '@znight/messaging/memory'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [MessagingPlugin.configure({ driver: rabbitmq({ url: 'amqp://localhost' }) })],
})
await app.start()
```

Consumers are providers too; the compiler checks their handlers and retry policies:

```ts
// src/orders/order.consumer.ts
import { Consumer, Message, OnMessage, Retry } from '@znight/messaging'
import { z } from 'zod'
import { OrderService } from './order.service.js'

export const OrderCreatedSchema = z.object({ orderId: z.string(), total: z.number() })
export type OrderCreated = z.output<typeof OrderCreatedSchema>

@Consumer('orders')
export class OrderConsumer {
  constructor(private readonly orders: OrderService) {}

  @OnMessage('order.created')
  @Retry({ attempts: 5, backoff: 'exponential' }) // then the dead-letter queue
  async onCreated(@Message(OrderCreatedSchema) event: OrderCreated) {
    await this.orders.process(event)
  }
}
```

## Packages

All `@znight/*` packages are versioned together. Install only what you use.

| Package                                             | What it gives you                                                                          | Install as    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| [`@znight/core`](./packages/core)                   | Container, application lifecycle, plugins, hooks, AOP, marker decorators                   | dependency    |
| [`@znight/compiler`](./packages/compiler)           | Vite plugin, CLI/Bun integration: analysis, validation, code generation                    | devDependency |
| [`@znight/http`](./packages/http)                   | Controllers, validation, guards, cookies, Server-Sent Events, CORS; Fastify, Express, Hono | dependency    |
| [`@znight/messaging`](./packages/messaging)         | Consumers, retries, dead-letter queues; RabbitMQ, SQS, Kafka, in-memory                    | dependency    |
| [`@znight/config`](./packages/config)               | Typed config classes from env, `.env`, JSON/YAML, Vault, AWS Secrets Manager               | dependency    |
| [`@znight/observability`](./packages/observability) | Pino logger, Prometheus metrics, OpenTelemetry tracing                                     | dependency    |
| [`@znight/testing`](./packages/testing)             | `TestBed` with auto-mocks, `TestApp` for in-memory end-to-end tests                        | devDependency |
| [`@znight/cli`](./packages/cli)                     | `znight new`, `generate`, `dev`, `build`, `start`, `openapi`, code generators              | devDependency |
| [`@znight/openapi`](./packages/openapi)             | OpenAPI 3.1 document generated at build time, served with Scalar or Swagger UI             | dependency    |
| [`@znight/schedule`](./packages/schedule)           | `@Cron`, `@Interval`, `@Timeout` jobs validated at build time, distributed locks           | dependency    |

## How it fits together

```txt
 your code (src/**/*.ts)                      build time
 ─────────────────────────────────────────────────────────────────────────
  @Injectable() classes       ┌──────────────────────────────────────┐
  @Controller() classes  ───▶ │ @znight/compiler (Vite plugin / CLI) │
  @Consumer(), @Config()...   │  scan → analyse → bind → validate    │
                              └──────────────────┬───────────────────┘
                                                 │ generates
                                                 ▼
                              src/.znight/container.generated.ts
                                (__ZNIGHT_METADATA__)
 ─────────────────────────────────────────────────────────────────────────
                                                 │ imported by main.ts   run time
                                                 ▼
                              Application.create({ metadata, plugins })
                                @znight/core container + lifecycle
                                + HttpPlugin, MessagingPlugin, ConfigPlugin...
```

Each feature package (HTTP, messaging, config, observability) brings marker decorators (no-ops at
runtime, stripped from the bundle), a compiler extension discovered automatically, and a runtime
plugin you add to the `plugins` of `Application.create()`.

## Examples

Runnable applications, with their tests, in [`examples/`](./examples):

| Example                                   | What it shows                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`rest-api`](./examples/rest-api)         | A production-shaped REST API: Fastify, PostgreSQL through Drizzle ORM, configuration, API keys       |
| [`microservice`](./examples/microservice) | An event-driven service: Hono HTTP API, messaging with retries and dead letters, logs/metrics/traces |
| [`worker`](./examples/worker)             | A background worker without HTTP server: message consumers and a graceful shutdown                   |
| [`monorepo`](./examples/monorepo)         | Services sharing providers through a library package of the monorepo                                 |

## Documentation

The documentation site lives in [`docs/`](./docs) (`bun run docs:dev` to browse it locally):

- [Introduction](./docs/guide/introduction.md) and [Getting started](./docs/guide/getting-started.md)
- Guides: [dependency injection](./docs/guide/dependency-injection.md), [scopes](./docs/guide/scopes.md),
  [lifecycle](./docs/guide/lifecycle.md), [the compiler](./docs/guide/compiler.md),
  [testing](./docs/guide/testing.md), [security](./docs/guide/security.md),
  [deployment](./docs/guide/deployment.md), [migrating from NestJS](./docs/guide/migrating-from-nestjs.md)
- Reference: [packages](./docs/packages/index.md), [decorators](./docs/reference/decorators.md),
  [error codes](./docs/reference/error-codes.md)
- Specification: [architecture](./docs/internals/architecture.md), the contract between the compiler
  and the runtime packages

## Contributing

Issues, discussions and pull requests are welcome. Read the
[contributing guide](./docs/contributing/index.md) for the repository layout and conventions.

The repository is a [Bun](https://bun.sh) workspace (Bun 1.3+ and Node.js 24+):

```sh
git clone https://github.com/znight-org/znight.git
cd Znight
bun install

bun run test            # packages, docs and repository tests (packages used from source)
bun run test:examples   # the tests of every example application
bun run typecheck       # tsc --noEmit for every workspace
bun run check           # Biome lint + format check
bun run build           # build every package with tsdown
bun run docs:dev        # documentation site in development mode
```

## License

[MIT](./LICENSE)
