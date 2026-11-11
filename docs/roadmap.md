---
description: What each Znight release brought (0.1 to 0.6, from the first packages to GraphQL, custom parameter decorators, application events and WebSocket gateways), what is planned without a date (a cache package, the Apollo Server driver, new messaging drivers), what is being considered, and what is deliberately not planned.
---

# Roadmap

Znight is published on npm, every `@znight/*` package under one version. Significant features are
designed in public, as RFCs in the [`rfcs/`](https://github.com/znight-org/znight/tree/main/rfcs)
folder of the repository, before they are implemented. This page summarises where each one stands
and the release that brought it. Until 1.0, minor versions may change APIs; each package's
`CHANGELOG.md` lists every change.

| RFC                                                                                             | Title                                     | Status                                                                              |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| [0001](https://github.com/znight-org/znight/blob/main/rfcs/0001-security.md)                    | Security (route decisions, CORS, headers) | Implemented (0.1.0)                                                                 |
| [0002](https://github.com/znight-org/znight/blob/main/rfcs/0002-openapi.md)                     | `@znight/openapi`                         | Implemented (0.1.0)                                                                 |
| [0003](https://github.com/znight-org/znight/blob/main/rfcs/0003-websocket.md)                   | `@znight/websocket`                       | Implemented (0.6.0)                                                                 |
| [0004](https://github.com/znight-org/znight/blob/main/rfcs/0004-schedule.md)                    | `@znight/schedule`                        | Implemented (0.1.0)                                                                 |
| [0005](https://github.com/znight-org/znight/blob/main/rfcs/0005-graphql.md)                     | `@znight/graphql`                         | Implemented (0.2.0)                                                                 |
| [0006](https://github.com/znight-org/znight/blob/main/rfcs/0006-http-cookies-sse.md)            | HTTP cookies and Server-Sent Events       | Implemented (0.1.0)                                                                 |
| [0007](https://github.com/znight-org/znight/blob/main/rfcs/0007-graphql-schema-first.md)        | Schema-first GraphQL                      | Implemented (0.2.1)                                                                 |
| [0008](https://github.com/znight-org/znight/blob/main/rfcs/0008-graphql-errors-as-data.md)      | Errors as data in `@znight/graphql`       | Implemented (0.2.1)                                                                 |
| [0009](https://github.com/znight-org/znight/blob/main/rfcs/0009-graphql-drivers.md)             | GraphQL drivers (`@znight/graphql`)       | M1–M2 implemented (0.3.0), M3 planned                                               |
| [0010](https://github.com/znight-org/znight/blob/main/rfcs/0010-custom-parameter-decorators.md) | Custom parameter decorators               | Implemented (0.4.0)                                                                 |
| [0011](https://github.com/znight-org/znight/blob/main/rfcs/0011-application-events.md)          | Application events (`@znight/events`)     | Implemented (0.5.0)                                                                 |
| [0012](https://github.com/znight-org/znight/blob/main/rfcs/0012-messaging-pubsub.md)            | Pub/Sub driver (`@znight/messaging`)      | Accepted (implemented, unreleased)                                                  |
| [0014](https://github.com/znight-org/znight/blob/main/rfcs/0014-messaging-drivers.md)           | Messaging drivers (`@znight/messaging`)   | Accepted (M1, NATS JetStream and Azure Service Bus drivers implemented, unreleased) |

## Released {#released}

### 0.1: the first release {#v0-1}

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
  example. There is no `@znight/security` package (see [Considered](#considered)).
- **Data access is yours.** Znight provides the wiring (factories, async init, disposal, interfaces)
  and leaves the choice of the database library to you; [Drizzle](https://orm.drizzle.team) is the
  recommended choice for SQL. See [Data access](/guide/data-access).
- **Caching** is a method interceptor today: the [cache recipe](/guide/aop#cache).
- [Example applications](/examples), each with its tests, running on Node.js and Bun.

### 0.2: `@znight/graphql` {#v0-2}

[Package page](/packages/graphql) and [guide](/guide/graphql).

Code-first GraphQL ([RFC 0005](https://github.com/znight-org/znight/blob/main/rfcs/0005-graphql.md)),
in 0.2.0: the TypeScript types are the schema. Resolvers are providers marked with `@Resolver`,
`@Query`, `@Mutation`, `@Subscription` and `@ResolveField`; the compiler derives the schema from
their signatures at build time, with descriptions from JSDoc, and reports schema mistakes as
diagnostics ([`ZNIGHT060`](/reference/error-codes#znight060)–[`ZNIGHT065`](/reference/error-codes#znight065)),
with setup problems at boot as [`ZNIGHT066`](/reference/error-codes#znight066).
It runs on graphql-js 17, served over HTTP by `HttpPlugin` on every adapter, with subscriptions
over Server-Sent Events, batching with loaders, access control with the same route decorators and
guards as HTTP, and the `graphql:operation` hook.

In 0.2.1:

- **Schema-first** ([RFC 0007](https://github.com/znight-org/znight/blob/main/rfcs/0007-graphql-schema-first.md)):
  with `graphql.configure({ schema })`, the `.graphql` files are the schema, resolvers are bound by
  name as in NestJS, and the compiler checks the coverage of the SDL and the conformance of every
  resolver signature at build time
  ([`ZNIGHT067`](/reference/error-codes#znight067)–[`ZNIGHT068`](/reference/error-codes#znight068));
  interfaces are supported in this mode.
- **Errors as data** ([RFC 0008](https://github.com/znight-org/znight/blob/main/rfcs/0008-graphql-errors-as-data.md)):
  result mappers turn the errors of guards, argument validation and resolvers into values of the
  field's union.

### 0.3: GraphQL drivers {#v0-3}

[RFC 0009](https://github.com/znight-org/znight/blob/main/rfcs/0009-graphql-drivers.md), milestones
1 and 2: `GraphQLEngine` runs the schema with its guards, loaders, request scope and hook behind
graphql-js-shaped `parse`, `validate`, `execute` and `subscribe`, and `@znight/graphql/yoga` serves
it with GraphQL Yoga on every adapter, on Node.js and Bun. The built-in transport stays the default.
`HttpPlugin` gains `onHttpDrain()` so plugins serving routes end their streams on shutdown. The
Apollo Server driver (milestone 3) waits for Apollo Server to accept graphql-js 17.

### 0.4: custom parameter decorators {#v0-4}

[RFC 0010](https://github.com/znight-org/znight/blob/main/rfcs/0010-custom-parameter-decorators.md),
[guide](/guide/custom-parameters): a `@CurrentUser()` of your own, defined once with
`createParamDecorator` from `@znight/core` and usable on HTTP routes, GraphQL fields and message
handlers. Its target, data argument and value type are checked at build time, resolvers may be
providers in any scope, and the generated code calls them directly: handlers without custom
parameters are unchanged.

### 0.5: `@znight/events` {#v0-5}

[Package page](/packages/events) and [guide](/guide/events).

Application events ([RFC 0011](https://github.com/znight-org/znight/blob/main/rfcs/0011-application-events.md)),
in the spirit of Spring and Micronaut: events are classes, listeners are provider methods marked
`@OnEvent()` whose parameter type is the event, found and checked at build time
([`ZNIGHT070`](/reference/error-codes#znight070)). Inline listeners run in the publisher's request
scope and their errors reach the publisher; detached ones run after the publication, in their own
scope, with errors reported. It covers what `@nestjs/cqrs`'s `EventBus` and `@nestjs/event-emitter`
are used for; `@znight/messaging` stays the tool for durable, out-of-process delivery. Later, on
demand: a transaction port (`phase: 'after-commit'`), `@Externalized` events relayed to a broker, a
concurrency limit for detached listeners.

### 0.6: `@znight/websocket` {#v0-6}

[Package page](/packages/websocket), [WebSockets guide](/guide/websockets) and the
[`realtime-chat`](/examples#realtime-chat) example
([RFC 0003](https://github.com/znight-org/znight/blob/main/rfcs/0003-websocket.md)). Gateways are
providers decorated with `@Gateway(path)` whose methods handle connections and events, resolved and
checked at build time like the rest of the graph. The handshake is an HTTP request served by
`HttpPlugin`'s server, so it goes through the same request scope, hooks, guards, CORS and proxy
settings and access decisions as any route. Payloads are validated with Standard Schemas, with
replies, rooms, broadcasts, backpressure, rate limits, heartbeats and a graceful shutdown. The
transport is `ws` on Node.js and `Bun.serve()` natively on Bun; `TestApp.connect()` opens
connections in memory, and `@znight/observability` traces, measures and logs every message. Error
codes: [`ZNIGHT050`](/reference/error-codes#znight050) and [`ZNIGHT051`](/reference/error-codes#znight051),
in the `ZNIGHT050`–`059` block reserved for the package.

## Planned, without a date {#planned}

### `@znight/cache`

A first-party cache package: method results cached with shared stores, built on the interceptor
mechanism. Its design has not been written yet. Until it lands, the
[cache recipe](/guide/aop#cache) is the recommended way to cache method results, and its
`CacheStore` interface lets you plug Redis in.

### Apollo Server driver

Milestone 3 of [RFC 0009](https://github.com/znight-org/znight/blob/main/rfcs/0009-graphql-drivers.md):
`@znight/graphql/apollo`, serving the engine with Apollo Server, once Apollo Server accepts
graphql-js 17. The engine and the GraphQL Yoga driver are in place.

### Messaging drivers

Milestone 2 of [RFC 0014](https://github.com/znight-org/znight/blob/main/rfcs/0014-messaging-drivers.md):
a first-party Redis Streams driver (`@znight/messaging/redis`), checked by the conformance kit,
and session receivers (ordered processing) for the Azure Service Bus driver. The public driver
contract, the kit (`@znight/messaging/testing`), the NATS JetStream driver (`@znight/messaging/nats`)
and the Azure Service Bus driver (`@znight/messaging/azure-service-bus`) are in place (unreleased);
OCI Streaming and Azure Event Hubs already work through the Kafka driver, and OCI Queue is left to a
third-party driver.

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

- **HTTP**: a `znight routes` command listing every route with its decision and guards; encrypted
  cookies; a hook measuring the lifetime of event streams; fan-out of events across instances.
- **WebSocket follow-ups**: rooms shared across instances, a typed client generated from the
  metadata, an AsyncAPI document.
- **GraphQL follow-ups**: GraphQL interfaces in code-first, `__resolveType` methods and custom
  directives in schema-first, `graphql-ws` subscriptions, `@defer` / `@stream`,
  trusted documents checked at build time, query cost analysis, federation, resolver-level spans
  in `@znight/observability`.

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
