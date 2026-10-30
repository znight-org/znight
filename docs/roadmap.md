---
description: What Znight v0.1 contains, what is planned for v0.2 (WebSocket gateways, GraphQL) and after (a cache package), what is being considered, and what is deliberately not planned.
---

# Roadmap

Znight is preparing its first release, **v0.1**. Significant features are designed in public, as
RFCs in the [`rfcs/`](https://github.com/znight-org/znight/tree/main/rfcs) folder of the repository,
before they are implemented. This page summarises where each one stands. Until 1.0, minor versions
may change APIs.

| RFC                                                                                  | Title                                     | Status           |
| ------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------- |
| [0001](https://github.com/znight-org/znight/blob/main/rfcs/0001-security.md)         | Security (route decisions, CORS, headers) | Accepted (v0.1)  |
| [0002](https://github.com/znight-org/znight/blob/main/rfcs/0002-openapi.md)          | `@znight/openapi`                         | Accepted (v0.1)  |
| [0003](https://github.com/znight-org/znight/blob/main/rfcs/0003-websocket.md)        | `@znight/websocket`                       | Deferred to v0.2 |
| [0004](https://github.com/znight-org/znight/blob/main/rfcs/0004-schedule.md)         | `@znight/schedule`                        | Accepted (v0.1)  |
| [0005](https://github.com/znight-org/znight/blob/main/rfcs/0005-graphql.md)          | `@znight/graphql`                         | Deferred to v0.2 |
| [0006](https://github.com/znight-org/znight/blob/main/rfcs/0006-http-cookies-sse.md) | HTTP cookies and Server-Sent Events       | Accepted (v0.1)  |

## v0.1: the first release {#v0-1}

Ten packages, released together under one version, running on Node.js 24+ and Bun 1.3+:

| Package                                            | What it brings                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`@znight/core`](/packages/core)                   | The container, scopes, lifecycle, plugins and hooks, method interceptors (AOP)                    |
| [`@znight/compiler`](/packages/compiler)           | Analysis, validation and code generation: Vite plugin, Bun preload, programmatic API              |
| [`@znight/http`](/packages/http)                   | Controllers, validation, guards, files, cookies, Server-Sent Events; node, Fastify, Express, Hono |
| [`@znight/openapi`](/packages/openapi)             | OpenAPI 3.1 documents generated and checked at build time, Scalar or Swagger UI                   |
| [`@znight/messaging`](/packages/messaging)         | Consumers, retries and dead letters on RabbitMQ, SQS, Kafka or in memory                          |
| [`@znight/schedule`](/packages/schedule)           | Cron, interval and timeout jobs checked at build time, one runner across instances                |
| [`@znight/config`](/packages/config)               | Typed configuration classes, validated at boot                                                    |
| [`@znight/observability`](/packages/observability) | Structured logs (Pino), Prometheus metrics, OpenTelemetry traces                                  |
| [`@znight/testing`](/packages/testing)             | `TestBed` with auto-mocks, `TestApp` for in-memory application tests                              |
| [`@znight/cli`](/packages/cli)                     | `znight new`, code generators, `generate`, `dev`, `build`, `start`, `openapi`                     |

And around them:

- **Security lives in `@znight/http`** ([RFC 0001](https://github.com/znight-org/znight/blob/main/rfcs/0001-security.md)):
  access decision groups checked at build time ([`ZNIGHT023`](/reference/error-codes#znight023)) and
  at boot, CORS, security headers on by default and trusted proxies. Authentication and
  authorization are recipes of the [Security guide](/guide/security), tested in the `secure-api`
  example. There is no `@znight/security` package in v0.1.
- **Data access is yours.** Znight provides the wiring (factories, async init, disposal, interfaces)
  and leaves the choice of the database library to you; [Drizzle](https://orm.drizzle.team) is the
  recommended choice for SQL. See [Data access](/guide/data-access).
- **Caching** is a method interceptor today: the [cache recipe](/guide/aop#cache).
- Seven [example applications](/examples), each with its tests, running on Node.js and Bun.

## v0.2: planned {#v0-2}

### `@znight/websocket`

WebSocket **gateways** ([RFC 0003](https://github.com/znight-org/znight/blob/main/rfcs/0003-websocket.md)):
providers decorated with `@Gateway(path)` whose methods handle connections and events, resolved and
checked at build time like the rest of the graph. The handshake is an HTTP request served by
`HttpPlugin`'s server, so it goes through the same request scope, hooks, guards, CORS and proxy
settings and access decisions as any route. Payloads are validated with Standard Schemas, with
acknowledgements, rooms, broadcasts, backpressure, heartbeats and a graceful shutdown. The transport
is `ws` on Node.js and Bun, and `Bun.serve()` natively with the Hono adapter on Bun. Error codes
`ZNIGHT050`–`ZNIGHT059` are reserved for it.

Until then, [Server-Sent Events](/packages/http#server-sent-events) cover server-to-client streams.

### `@znight/graphql`

Code-first GraphQL ([RFC 0005](https://github.com/znight-org/znight/blob/main/rfcs/0005-graphql.md)):
the TypeScript types are the schema. Resolvers are providers marked with `@Resolver`, `@Query`,
`@Mutation`, `@Subscription` and `@ResolveField`; the compiler derives the schema from their
signatures at build time, with descriptions from JSDoc, and reports schema mistakes as diagnostics.
It runs on graphql-js, served over HTTP by `HttpPlugin`, with subscriptions over Server-Sent Events,
batching with loaders, and access control with the same route decorators and guards as HTTP. Error
codes `ZNIGHT060`–`ZNIGHT069` are reserved for it.

## Planned, without a date {#planned}

### `@znight/cache`

A first-party cache package: method results cached with shared stores, built on the interceptor
mechanism. Its design has not been written yet. Until it lands, the
[cache recipe](/guide/aop#cache) is the recommended way to cache method results, and its
`CacheStore` interface lets you plug Redis in.

## Considered, not scheduled {#considered}

These are tracked in the RFCs as follow-ups. None has a date.

- **`@znight/security`.** The [security RFC](https://github.com/znight-org/znight/blob/main/rfcs/0001-security.md#8-when-to-reconsider-znightsecurity-v02-or-later)
  opens a package RFC when **two** of these hold:
  - three or more real applications (examples excluded) carry the same authenticator and guard code
    copied from the Security guide;
  - users ask for features that need types owned by the framework: a principal propagated to message
    consumers, an `@Authorize` whose method signatures are validated at build time, OIDC login with
    sessions;
  - a security policy exists: `SECURITY.md`, private advisories enabled, a second maintainer able to
    triage.

  The package would then ship decisions of the `access` group, a guard that enforces them, a JWT
  authenticator and a password hasher extracted from the guide's recipes, with no change to the
  route decision API.

- **HTTP**: a `znight routes` command listing every route with its decision and guards; a generic
  parameter decorator factory (a `@CurrentUser()` of your own); encrypted cookies; a hook measuring
  the lifetime of event streams; fan-out of events across instances.
- **WebSocket follow-ups**: rooms shared across instances, a typed client generated from the
  metadata, an AsyncAPI document.
- **GraphQL follow-ups**: `graphql-ws` subscriptions, trusted documents checked at build time,
  query cost analysis, federation.

Interested in one of them? Say so in an issue or a discussion on
[GitHub](https://github.com/znight-org/znight): real use cases are what moves an item up.

## Not planned {#not-planned}

Some things are left out on purpose.

- **SQL helper decorators and a built-in ORM.** Znight will not add entity, column, repository or
  query decorators (`@Entity()`, `@Column()`, SQL strings in decorators of repository methods...).
  Decorators in Znight describe wiring and transport; the schema and the queries belong to the data
  library you choose ([Data access](/guide/data-access)).
- **Sessions and MVC.** Server-side session stores, a `@Session()` decorator, flash messages and view
  rendering are out of scope. Signed cookies are an integrity primitive, not a session system; the
  [Security guide](/guide/security#csrf) shows cookie sessions for a web front-end.
- **Runtime reflection and modules.** No `reflect-metadata`, no module system: the dependency graph is
  resolved by the compiler, in one flat container. This is the design, not a gap.
