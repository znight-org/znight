# RFC 0009: GraphQL drivers (`@znight/graphql`)

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status   | Accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Date     | 2026-11-04                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Affects  | `@znight/graphql` (a public `GraphQLEngine`, a `GraphQLDriver` contract, a `driver` plugin option, the built-in transport moved behind the contract, subpath exports `/yoga` and `/apollo` with their servers as optional peers); `@znight/core` (`GraphQLOperationEvent.driver`); `@znight/observability` (one span attribute); docs and specification §8.3, §9.7. No compiler, metadata or generated code change. No new error code (ZNIGHT066 reused). Amends RFC 0005 decision D3 and its open question Q2                                                                                                                        |
| Decision | **Znight stays the engine, a driver owns the transport.** The engine (schema built at boot from compiled metadata, compiled resolvers, per-field guards, loaders, `GraphQLContext` and request scope, result mappers and error masking, limits, the `graphql:operation` hook) is exposed to drivers as graphql-js-shaped `parse` / `validate` / `execute` / `subscribe` functions. A driver (GraphQL Yoga, Apollo Server, later Mercurius) owns the protocol, its plugins and its subscription transport, and is mounted as plugin routes of `HttpPlugin`, so the HTTP pipeline (request scope, hooks, guards, CORS, drain) still wraps it. The built-in transport stays the default and keeps its direct, fastest path. GraphQL Yoga 6 is the first driver; Apollo Server follows once it accepts graphql-js 17 (Apollo Server 5 requires graphql 16); Mercurius only on demand |

**Owner decisions (2026-11-04).** Accepted for implementation on 2026-11-04. Q1: engine API first, then GraphQL Yoga as a driver package, then
Apollo Server once it accepts graphql-js 17. Q2: resolvers keep `GraphQLContext`; the server's
context is reachable as `GraphQLContext.serverContext`. Q3: the engine parses and validates when
the server allows it (Yoga), the server does with the engine's rules otherwise (Apollo), never
both. Q8: no Mercurius driver is planned. Q12: graphql-js 17 only; the Apollo driver waits for
Apollo Server. The other open questions keep their recommended answers until the owner settles
them.

## 1. Summary

Today `@znight/graphql` serves its schema with its own GraphQL-over-HTTP and SSE transport (RFC 0005
decision D3). It is small, conformant (the `graphql-http` audits run in the tests) and fast, but it
is the only way in: an application that needs an Apollo Server plugin, Apollo usage reporting, an
Envelop plugin of the Yoga ecosystem, automatic persisted queries or a GraphQL IDE other than
GraphiQL has nowhere to plug it, except the guide's Yoga recipe, copied into the application
(§2.3). NestJS users are used to choosing (`driver: ApolloDriver`,
`MercuriusDriver`, `YogaDriver`) and will look for the same switch.

This RFC adds that switch without giving away what makes Znight's GraphQL Znight's:

```ts
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'
import { GraphQLPlugin } from '@znight/graphql'
import { yogaDriver } from '@znight/graphql/yoga'
import { useResponseCache } from '@graphql-yoga/plugin-response-cache'

await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    HttpPlugin.configure({ adapter: honoAdapter() }),
    GraphQLPlugin.configure({
      guards: [AccessGuard],
      resultMappers: [Rejections],
      driver: yogaDriver({ plugins: [useResponseCache({ session: () => null })] }),
    }),
  ],
})
```

The resolvers, guards, loaders, result mappers, request-scoped providers and tests of the
application do not change: the same compiled schema runs under Yoga. Yoga parses the request,
negotiates the response, runs its Envelop plugins and streams subscriptions; when it executes, it
calls Znight's engine, which builds the `GraphQLContext` in the request scope that `HttpPlugin`
opened, runs graphql-js and formats the errors.

The split is deliberate. What users ask a "driver" for falls in three groups (§2.3): **transport**
features (persisted queries, IDEs, `graphql-ws`, multipart), **ecosystem** features (Apollo plugins
and usage reporting, Envelop plugins) and **engine** features (federation, `@defer` / `@stream`,
cost analysis, JIT). A driver brings the first two. The third needs the engine in any case, so it
is planned engine-side, for every driver and for the built-in transport at once.

## 2. Context and motivation

### 2.1 What NestJS drivers give their users

`@nestjs/graphql` builds the schema (code-first from decorators or schema-first from SDL files),
then hands it to a driver package, chosen in `GraphQLModule.forRoot<ApolloDriverConfig>({ driver:
ApolloDriver, ... })`:

| Driver                                     | Package                         | What users get from it                                                                                                                                                       |
| ------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ApolloDriver`                             | `@nestjs/apollo`, Apollo Server | Apollo Server plugins (lifecycle hooks), Apollo Sandbox / Explorer landing page, usage reporting to GraphOS Studio, automatic persisted queries, `formatError`, CSRF guard  |
| `ApolloFederationDriver`                   | `@nestjs/apollo`                | A federation subgraph (`@key`, `_entities`, `_service`, `@ResolveReference()`), built with `@apollo/subgraph`                                                                 |
| `ApolloGatewayDriver`                      | `@nestjs/apollo`                | An Apollo Gateway (supergraph router in Node.js) inside the Nest application                                                                                                 |
| `MercuriusDriver`                          | `@nestjs/mercurius`, Mercurius  | Fastify-native GraphQL: `graphql-jit` compilation, Mercurius loaders, built-in WebSocket subscriptions, persisted queries, Mercurius hooks                                    |
| `MercuriusFederationDriver`                | `@nestjs/mercurius`             | A Mercurius federation subgraph (`@mercuriusjs/federation`)                                                                                                                  |
| `YogaDriver`, `YogaFederationDriver`       | `@graphql-yoga/nestjs` (The Guild) | GraphQL Yoga: Fetch API server, Envelop plugins (response cache, rate limit, Hive, OpenTelemetry...), GraphiQL, SSE and `graphql-ws` subscriptions, `@defer` / `@stream` |

How the abstraction works (`@nestjs/graphql` 14.1, Nest 12): a driver implements `GraphQLDriver`
(`start(options)`, `stop()`), usually by extending `AbstractGraphQLDriver`, which injects
`HttpAdapterHost` and offers `mergeDefaultOptions()` (default path `/graphql`, global prefix),
`generateSchema()` and `subscriptionWithFilter()`. In `GraphQLModule.onModuleInit`, **Nest builds
the `GraphQLSchema` itself** and calls `driver.start({ ...options, schema })`; the driver mounts its
server on the Nest HTTP adapter (Apollo through `@as-integrations/express5` or
`@as-integrations/fastify`, Yoga through `handleNodeRequestAndResponse`, Mercurius as a Fastify
plugin). Drivers wrap the user's `context` and always add `req`; Nest's guards, interceptors and
filters run in Nest's own resolver wrappers (`fieldResolverEnhancers`), not in the driver. Since
v14, `graphql-ws` is the only subscription protocol (`subscriptions-transport-ws` and GraphQL
Playground were removed). Two details matter for Znight: the Yoga driver never calls
`yoga.dispose()`, and the Mercurius driver's `stop()` does nothing.

This is already the split this RFC proposes: the framework owns the schema and the resolver
pipeline, the driver owns the transport. Znight goes one step further and keeps the execution too
(§2.4).

The current versions, the hooks each server offers to replace its execution and the details are in
§5 and in the appendix (§15).

### 2.2 What Znight's built-in transport covers today

Checked against `packages/graphql/src/transport/` and `execution.ts`:

| Area           | Built-in transport                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol       | GraphQL over HTTP (draft): `POST` JSON, `GET` queries, `application/graphql-response+json` and `application/json`, 405/406/413/415 answers, no batching                                                      |
| Subscriptions  | GraphQL over SSE, distinct connections mode (`HttpResponse.sse()`, heartbeat, `maxDuration`, `maxActive`, jittered `retry` on shutdown)                                                                        |
| IDE            | GraphiQL on `GET path` with `accept: text/html` (`graphiql`, on in development)                                                                                                                                 |
| Execution      | Document cache (LRU by query text), `maxTokens` / depth / aliases / directives limits, introspection switch (suggestions hidden with it), graphql-js 17 `execute` and `createSourceEventStream`, abort signals |
| Errors         | Error mappers, result mappers (RFC 0008), masking (`exposeErrors`), `extensions.code`                                                                                                                           |
| Integration    | Plugin routes of `HttpPlugin` (RFC 0002 H1): request scope, `http:request` hooks, global and endpoint guards, route decisions (ZNIGHT023), CORS, security headers, drain, every adapter, Node.js and Bun          |
| Observability  | `graphql:operation` hook: one span and two metrics per operation (`@znight/observability`)                                                                                                                      |
| Escape hatches | `http: false` + `plugin.schema`; `plugin.execute()` / `plugin.subscribe()` taking a query text                                                                                                                  |

Missing (README "Limitations"): `graphql-ws`, `@defer` / `@stream`, persisted or trusted documents,
query cost analysis, response cache, federation, multipart uploads, operation batching, resolver
level spans.

### 2.3 What is lost without drivers, sorted by where it can live

| Need                                                              | Where it belongs | Why                                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apollo Server plugins, GraphOS usage reporting, Apollo Sandbox    | Driver           | They are Apollo Server's lifecycle (`requestDidStart`, `willSendResponse`...), only Apollo Server runs them                                                                  |
| Envelop plugins (response cache, rate limit, Hive, armor, auth)   | Driver           | They wrap Yoga's (Envelop's) phases                                                                                                                                         |
| Automatic persisted queries (APQ), persisted / trusted operations | Driver first     | A request protocol (`extensions.persistedQuery`); every server above has one. A build-time trusted documents check stays an engine follow-up (roadmap)                       |
| `graphql-ws` (WebSocket subscriptions)                            | Neither alone    | A protocol over a WebSocket server. `graphql-ws` only needs `execute` / `subscribe` / `context`, so it plugs into the engine directly once `@znight/websocket` (RFC 0003, accepted, in project) gives Znight its own WebSocket support (§4.9) |
| Multipart uploads, operation batching                             | Driver           | Request protocols. Znight's answer stays "an HTTP upload route"; drivers that support them may expose them                                                                   |
| Federation subgraph (`@key`, `_entities`, `_service`)             | **Engine**       | It changes the schema and adds resolvers (reference resolvers). A router (Apollo Router, Hive Gateway) calls a subgraph over plain GraphQL over HTTP, so the built-in transport serves it as well. The JavaScript federation libraries (`@apollo/subgraph`, `@mercuriusjs/federation`) require graphql 16, so the engine would implement the subgraph specification itself |
| `@defer` / `@stream`                                              | **Engine** + transport | graphql-js 17 `experimentalExecuteIncrementally` runs in the engine; the driver (or the built-in transport) frames the incremental payloads                           |
| Query cost analysis, depth limits                                 | **Engine**       | Validation rules, the same for every transport (Znight already has depth, aliases, directives and tokens limits)                                                            |
| `graphql-jit` (Mercurius)                                         | **Engine**       | It replaces `execute`; Znight's resolvers, guards and loaders are wired into graphql-js resolve functions, so JIT is an engine decision, measured separately (RFC 0005 §8.12) |

Today's escape hatch is the "Serve the schema with GraphQL Yoga" recipe of the GraphQL guide
(`docs/guide/graphql.md#yoga`, tested by `packages/graphql/test/recipes/yoga.controller.ts`): with
`http: false`, a controller hands its requests to Yoga, and a Yoga plugin (`onExecute` /
`onSubscribe`, `setExecuteFn` / `setSubscribeFn`) sends every operation back to `plugin.execute()` /
`plugin.subscribe()` with the query text from Yoga's params. Executing `plugin.schema` directly with
the server's `execute` does not work: the resolvers expect Znight's `GraphQLContext` as
`contextValue` (`ctx.loader()`, `ctx.signal`, `@Ctx()`), the request scope entry the executor sets,
and its masking. The recipe keeps all of that, and shows the direction is sound, but each
application has to copy it and it pays for being built on an API meant for direct calls:

- every operation is parsed and validated twice, by Yoga and again by `GraphQLPlugin` (its
  document cache only makes repeated texts cheap);
- the hook reports `transport: 'direct'`, so observability cannot tell the server's traffic apart;
- `plugin.execute()` returns plain formatted errors, enough for Yoga's JSON but not for servers that
  require `GraphQLError` instances (Apollo Server wraps anything else);
- the `GraphQLRequest` is rebuilt from the server's params, so a plugin that changed the parsed
  document (persisted operations resolved to a document, a rewriting plugin) is not what runs;
- Yoga is created lazily in the controller, never disposed on shutdown, and the engine does not end
  the subscriptions it serves to Yoga when the application stops;
- the controller copies headers and buffers the body into a new `Request` on every adapter, even
  Hono's, whose native request is already one.

A public engine API (§4.2) taking the parsed document removes the double work and the mismatches,
and driver packages remove the copying.

### 2.4 Why keep Znight's engine

The opposite design, the driver owning the schema and its execution (NestJS's model), would throw
away what RFC 0005 is built on: the schema derived at build time, resolvers bound and checked at
build time, per-field guards with route decisions checked at boot (ZNIGHT023), loaders per
execution, request-scoped providers instead of a context bag, errors as data, masking defaults and
one observability hook. It would also make every guarantee depend on the driver. Keeping the engine
makes a driver a thin piece: protocol and ecosystem on top, the same application underneath.

## 3. Goals and non-goals

Goals:

- a public, graphql-js-shaped `GraphQLEngine` that any GraphQL server can call, keeping guards,
  loaders, the request scope, result mappers, masking, limits and the hook;
- a `GraphQLDriver` contract and a `driver` option, the built-in transport being the default;
- first-party drivers for GraphQL Yoga, then Apollo Server, as subpath exports with optional peers;
- every driver on every `HttpPlugin` adapter it can run on, on Node.js and Bun, inside the HTTP
  pipeline (scope, hooks, guards, CORS, drain);
- code-first and schema-first alike; `@znight/graphql/testing` unchanged for users;
- **the default path pays nothing**: an application without `driver` runs exactly today's code
  (§6);
- every driver measured against the built-in transport in the planned GraphQL benchmark.

Non-goals:

- letting a driver build or transform the schema (`transformSchema`, `buildSchemaOptions`);
- an Apollo Gateway or a supergraph router inside a Znight application (run Apollo Router or Hive
  Gateway in front);
- federation, `@defer` / `@stream`, `graphql-ws` and JIT in this RFC: they are engine work, planned
  as follow-ups that every driver inherits (§10 Q5 to Q7, §14);
- Envelop plugins on the built-in transport (§9, A6).

## 4. Design

### 4.1 User-facing API

```ts
GraphQLPlugin.configure({
  // engine options, unchanged and honoured by every driver
  guards: [AccessGuard],
  errorMappers: [DomainErrors],
  resultMappers: [Rejections],
  exposeErrors: false,
  introspection: false,
  limits: { maxDepth: 10 },
  // transport
  path: '/graphql',
  http: { meta: [Public.meta()], bodyLimit: '1mb' },
  graphiql: true, // "serve the driver's IDE": GraphiQL for Yoga, Apollo Sandbox for Apollo Server
  driver: yogaDriver({ plugins: [usePersistedOperations({ getPersistedOperation: id => store.get(id) })] }),
})
```

`driver` absent is the built-in transport. A driver is created by a factory of its subpath
(`yogaDriver()`, `apolloDriver()`), whose options are the server's own options minus what the
engine owns (§4.6). A driver instance serves one application at a time, like the plugin.

### 4.2 The engine (normative)

`GraphQLPlugin.engine` (after bootstrap) and the first argument of `GraphQLDriver.start()`:

```ts
export interface GraphQLEngine {
  /** The executable schema (resolvers are Znight's pipelines). */
  readonly schema: GraphQLSchema
  /** Engine options a server needs to configure itself (resolved, read-only). */
  readonly settings: GraphQLEngineSettings

  /**
   * graphql-js `parse` through the document cache: `maxTokens`, then the depth, aliases and
   * directives limits. Throws a `GraphQLError` (`GRAPHQL_PARSE_FAILED` or the limit's code), like
   * graphql-js. The same text returns the same `DocumentNode`.
   */
  parse(source: string | Source): DocumentNode
  /**
   * graphql-js `validate` with `rules` (default: graphql-js `specifiedRules`; Envelop passes them
   * plus the rules its plugins add), to which the engine always adds its own (`rules` below), with
   * `hideSuggestions` when introspection is off. Cached per document (the `DocumentNode` of
   * `parse`) when `rules` is the default list.
   */
  validate(schema: GraphQLSchema, document: DocumentNode, rules?: readonly ValidationRule[]): readonly GraphQLError[]
  /** The engine's extra rules (limits, introspection), for servers that validate themselves. */
  readonly rules: readonly ValidationRule[]

  /** Executes a validated query or mutation (see the execution rules below). */
  execute(args: ExecutionArgs, options?: EngineExecuteOptions): PromiseOrValue<ExecutionResult>
  /** Starts a validated subscription: a stream of results, or a single error result. */
  subscribe(
    args: ExecutionArgs,
    options?: EngineExecuteOptions,
  ): PromiseOrValue<AsyncGenerator<ExecutionResult, void, void> | ExecutionResult>
}

export interface EngineExecuteOptions {
  /** `GraphQLOperationEvent.transport`: `'http'` (default), `'sse'`, `'ws'`. */
  readonly transport?: 'http' | 'sse' | 'ws'
  /** Cancels the execution (graphql-js `abortSignal`, `GraphQLContext.signal`). Default: `HttpContext.signal`. */
  readonly signal?: AbortSignal
  /** Default: the request id of the HTTP request of the scope. */
  readonly requestId?: string
}

export interface GraphQLEngineSettings {
  readonly path: string // the endpoint path, prefix included
  readonly introspection: boolean
  readonly ide: boolean // the `graphiql` option
  readonly exposeErrors: boolean
  readonly maxTokens: number | undefined
  readonly subscriptions: false | { readonly maxActive: number }
  readonly http: false | { readonly get: boolean; readonly bodyLimit: ByteSize }
}
```

Execution rules (`execute` and `subscribe`):

1. **Scope.** When a request scope is active (the HTTP scope opened by `HttpPlugin` around the
   driver's route, see §4.4), the operation runs in it: `GraphQLTokens.Context` is set there, so
   request-scoped providers, guards and resolvers see the same `CurrentUser` as HTTP guards. Without
   a scope (a server outside the HTTP pipeline), the engine opens one per operation (per
   subscription for its whole life), like `plugin.execute()` does today.
2. **Context.** The engine builds the `GraphQLContext` (`OperationContext`) of the operation and
   passes it to graphql-js as `contextValue`. The driver's own context (`args.contextValue`: Yoga's
   initial context, Apollo's context value) is not given to resolvers; it is reachable as
   `GraphQLContext.serverContext` (§10, Q2). `GraphQLContext.http` is the `HttpContext` of the
   scope, `transport` comes from `options.transport`, `signal` from `options.signal` or the HTTP
   request.
3. **Pipeline.** Unchanged: resolver pipelines built at boot (guards, Standard Schema arguments,
   loaders, result mappers) run as with the built-in transport. Loaders are per execution, renewed
   per subscription event.
4. **Document.** The document is trusted to be valid against `schema` (the driver validated it with
   `validate` or with `rules`). `args.schema` must be the engine's schema (else ZNIGHT066, checked
   once per document). `documentId` (SHA-256 of the query text) is computed lazily from the text
   seen by `parse`, or from `document.loc.source.body`.
5. **Result.** Without errors, the result as graphql-js returned it. With errors, every error goes
   through the error mappers and masking (§4.8), and the result carries **`GraphQLError`
   instances** holding the formatted message, `locations`, `path` and `extensions`, without
   `originalError`: servers such as Apollo Server wrap anything that is not an `Error`, so plain
   formatted objects (what the built-in transport serialises) are not enough.
6. **Hook.** `graphql:operation` is produced once per operation (once per subscription), with
   `driver` set (§4.11), at the same cost rules as today (built only with wrappers or listeners).
   Requests rejected by the driver before `execute` (parse or validation errors of a server that
   validates itself) are observed only if they went through `engine.parse` / `engine.validate`.
7. **Subscriptions.** `subscriptions.maxActive` applies to every transport (a result with a
   `SERVICE_UNAVAILABLE` error beyond it). The engine tracks every stream it returned and ends them
   in `GraphQLPlugin.onStop` (§4.10). `subscriptions: false` answers a subscription with a
   `BAD_REQUEST` error result.

The engine is a layer over the existing `GraphQLExecutor`, which keeps its internal API for the
built-in transport and `plugin.execute()`. Its signatures are graphql-js's, so they fit Envelop's
`useEngine`, `graphql-ws`'s `execute` / `subscribe` options, `graphql-sse` and `graphql-http`
handlers without adapters.

### 4.3 The driver contract (normative)

```ts
export interface GraphQLDriver {
  /** `yoga`, `apollo`, `mercurius`... (`builtin` is reserved). `GraphQLOperationEvent.driver`. */
  readonly name: string
  /**
   * The routes `HttpPlugin` serves for the driver (`GraphQLPlugin.httpRoutes()` returns them, with
   * the `http` option's meta, guards and body limit applied). Called once per application, possibly
   * before `start()`: handlers MUST NOT use the engine before the first request.
   */
  routes?(context: GraphQLDriverRoutesContext): readonly GraphQLDriverRoute[]
  /** Called in `GraphQLPlugin.onBootstrap`, once the engine is built: create the server. */
  start(engine: GraphQLEngine, context: GraphQLDriverContext): void | Promise<void>
  /** Called in `GraphQLPlugin.onStop`, after the engine ended its subscriptions: drain, stop the server. */
  stop?(): void | Promise<void>
}

export interface GraphQLDriverRoutesContext {
  readonly path: string // relative to the HttpPlugin prefix
  readonly endpoint: string // absolute
}

/** A plugin route without `meta` / `guards` / `bodyLimit`: the plugin adds them from the `http` option. */
export type GraphQLDriverRoute = Pick<PluginRoute, 'method' | 'path' | 'name' | 'handler'>

export interface GraphQLDriverContext {
  readonly logger: CoreLogger
  readonly container: Container
  /** The `HttpPlugin` of the application, when registered (its adapter, for server-mounted drivers). */
  readonly http: HttpPlugin | undefined
}
```

What Znight provides to a driver: the schema, the engine functions (`parse`, `validate`, `rules`,
`execute`, `subscribe`), the resolved settings (path, introspection, IDE, limits, subscriptions),
the request scope and `HttpContext` (because its routes run in `HttpPlugin`'s pipeline), error
formatting, the hook, and its lifecycle (`start` in `onBootstrap`, `stop` in `onStop`).

What the driver owns: its routes or its integration with the server, the protocol (request parsing,
content negotiation, status codes, batching, persisted queries), its plugins and their lifecycle,
its IDE or landing page, its subscription transports (SSE framing, `graphql-ws` when the server
handles WebSocket itself), incremental delivery framing, and its own shutdown.

Plugin-side rules:

- `GraphQLPlugin.register` resolves nothing of the driver; `httpRoutes()` returns the driver's
  routes, or `[]` with `http: false` (then the driver must mount itself, see §5.3).
- `onBootstrap` builds the engine, then awaits `driver.start(engine, context)`. A driver that throws
  fails the boot with its error wrapped in ZNIGHT066 (`GraphQLPlugin: the yoga driver failed to
  start`), the original as `cause`.
- `onStop` ends the engine's subscriptions, then awaits `driver.stop()`.
- The `driver` option is validated at boot: an object with `name` and `start` (ZNIGHT066 otherwise).

### 4.4 Mounting: routes in the HTTP pipeline

The first-party drivers are **route-mounted**: their handlers are plugin routes (`PluginRoute`,
RFC 0002 H1, nothing new in `@znight/http`), so a request to the endpoint goes through
`HttpPlugin`'s pipeline exactly like the built-in transport's: request id, request scope with
`HttpContext`, `http:request` hooks (HTTP span, access log, metrics), global guards, the endpoint's
`http.guards` and route decisions (ZNIGHT023), exception mappers, CORS, security headers, and the
drain on shutdown. Inside, the driver's server handles the request and calls the engine, in the same
async context, so the engine finds the scope (rule 1 of §4.2).

Two facts of `@znight/http` make this work without a change, both checked in the code:

- a handler may return a **Web `Response`**, sent as is (status, headers, body) by the serialiser
  (`serialize.ts`), streamed bodies included; a streamed body is pulled in the request's async
  context and keeps the scope until it is sent or abandoned (`trackStream`), and a client abort
  aborts `ctx.signal`;
- `HttpContext.request` is the native request: a Web `Request` on `honoAdapter()` (Bun, and Node.js
  through `@hono/node-server`), an `IncomingMessage` / `FastifyRequest` / Express `Request`
  otherwise; `ctx.bodyStream()` reads the body as a Web stream under the route's body limit.

The bridge to a Fetch server is therefore an internal helper of `@znight/graphql` (`fetchRequest(ctx)`):
the native `Request` itself when the adapter has one and its body was not read, otherwise a
`Request` built from `ctx.method`, the URL, `ctx.headers` and `ctx.bodyStream()` (`duplex: 'half'`).

| Driver           | Server API used                                         | `node` / `fastify` / `express` (Node.js, Bun)  | `hono` (Bun, Node.js)        |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| Built-in         | `GraphQLExecutor` (internal)                            | yes                                            | yes                          |
| Yoga             | `yoga.fetch(request, serverContext)`                    | yes, a `Request` built per call                | yes, the native `Request`    |
| Apollo Server    | `server.executeHTTPGraphQLRequest({ httpGraphQLRequest, context })` | yes, an `HTTPGraphQLRequest` built from `HttpContext` (no Fetch objects) | yes (Apollo has no Hono or Bun integration of its own; this bridge needs none) |
| Mercurius        | Fastify plugin on the adapter's instance                | `fastifyAdapter()` only (§5.3)                 | no                           |

A driver may also be **server-mounted**: no routes, `start()` attaches it to the adapter's native
server (`context.http.adapter`). It then runs outside `HttpPlugin`'s pipeline (no `http:request`
hook, no HTTP guards, no CORS from `HttpPlugin`), and the engine opens a scope per operation without
`HttpContext`. This is allowed by the contract but no first-party driver uses it in the first
milestones (§5.3, Q8).

### 4.5 Engine side, driver side

| Feature                                                 | Owner                     | With a driver                                                                                                                         |
| ------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Schema (code-first or schema-first), resolvers          | Engine                    | Unchanged. The driver receives `engine.schema` and never builds one                                                                   |
| Field guards, global guards, route decisions on fields  | Engine                    | Unchanged (they are inside the resolve functions)                                                                                     |
| HTTP guards on the endpoint (`http.guards`, `http.meta`) | `HttpPlugin`             | Unchanged for route-mounted drivers                                                                                                   |
| Loaders, `GraphQLContext`, request scope                | Engine                    | Unchanged (§4.2 rules 1 to 3)                                                                                                         |
| Error mappers, result mappers, masking, `exposeErrors`  | Engine                    | Done once by the engine; the driver's own masking is turned off by the driver factory (§4.8)                                          |
| Introspection switch, suggestions                       | Engine                    | Through `validate` / `rules`; the driver's own switch (Apollo `introspection`) is set from `settings.introspection`                  |
| Limits (`maxTokens`, depth, aliases, directives)        | Engine                    | Through `parse` / `rules`; Apollo gets `parseOptions.maxTokens` and `validationRules`                                                 |
| Document cache                                          | Engine or driver          | Engine when the server lets it parse (Yoga `useEngine`); the server's own cache otherwise (Apollo `documentStore`), never both        |
| Protocol, content negotiation, status codes            | Driver                    | The driver's (Yoga and Apollo follow the GraphQL-over-HTTP draft, with their own choices)                                             |
| IDE                                                     | Driver                    | `graphiql: true` serves the driver's IDE: GraphiQL (Yoga), Apollo Sandbox landing page (Apollo Server), GraphiQL (Mercurius)         |
| Subscriptions over SSE                                  | Driver framing, engine streams | Yoga's SSE (and its other modes); the engine provides the stream, the cap and the shutdown                                     |
| `graphql-ws`                                            | Engine add-on (§4.9)      | Through `@znight/websocket` (RFC 0003, accepted, in project) for every driver, or a driver's own WebSocket support where the server has one |
| Persisted queries, response cache, rate limits, usage reporting | Driver            | The server's plugins                                                                                                                  |
| `@defer` / `@stream`, federation, cost analysis, JIT    | Engine (follow-ups)       | Out of this RFC (§14); the contract reserves `executeIncrementally` for incremental delivery                                          |
| `graphql:operation` hook, spans, metrics                | Engine                    | Unchanged, with `driver` on the event                                                                                                 |

### 4.6 Options with a driver

The engine options apply to every driver: `guards`, `errorMappers`, `resultMappers`,
`exposeErrors`, `introspection`, `limits`, `documentCache` (when the engine parses), `subscriptions:
false`, `subscriptions.maxActive`, `subscriptions.bufferSize`, `pubsub`, `enforcement`. The
transport options:

| Option                                  | Built-in   | Route-mounted driver                                                                     |
| --------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `path`                                  | yes        | yes: the routes' path and the server's endpoint (`graphqlEndpoint`, Apollo's `path`)    |
| `http: false`                           | no routes  | no routes (a route-mounted driver then fails at boot: ZNIGHT066)                         |
| `http.meta`, `http.guards`, `http.bodyLimit` | yes   | yes, applied to the driver's routes by the plugin                                        |
| `http.get`                              | yes        | passed in `settings`; the driver maps it (Yoga: `GET` handling, Apollo: its CSRF prevention stays on) |
| `graphiql`                              | GraphiQL   | the driver's IDE                                                                         |
| `subscriptions.heartbeat`, `.maxDuration` | SSE options | ZNIGHT066 at boot: the driver's own keep-alive options apply (Yoga's `keepAlive`...)    |

The factory options of a driver are the server's options minus what the engine owns: no `schema`,
`typeDefs`, `resolvers`, `context`, `maskedErrors` / `formatError` replacing masking (Apollo's
`formatError` stays available and receives masked errors), `introspection`, `graphqlEndpoint` /
`path`. Passing one of them is a type error, and ZNIGHT066 at boot for untyped callers.

### 4.7 Context, request scope, guards and loaders

Nothing changes for application code: resolvers keep `@Ctx() ctx: GraphQLContext`, guards keep
`canResolve(ctx: ResolverContext)`, loaders keep `@Loader()`, and request-scoped providers keep
being created once per HTTP request. With a route-mounted driver the order per request is:

```text
adapter → HttpPlugin pipeline
  runInScope({ HttpContext, RequestId })
  → hooks.run('http:request') → global HTTP guards → http.guards
  → driver handler: yoga.fetch(fetchRequest(ctx)) | apollo.executeHTTPGraphQLRequest(...)
      driver: parse the request, its plugins, persisted queries...
      → engine.parse / engine.validate (or the server's, with engine.rules)
      → engine.execute(args)
          seed GraphQLContext into the current scope
          → hooks.run('graphql:operation')
              → graphql-js execute → resolver pipelines (guards, args, loaders, result mappers)
              → error mappers, masking → ExecutionResult with GraphQLError instances
      driver: its plugins, response formatting
  → Web Response → HttpPlugin serialiser → adapter
```

One HTTP request may carry several operations with a driver that batches (Apollo's
`allowBatchedHttpRequests`): they would share the request scope, so request-scoped providers would
be shared between them, which is what NestJS does too. But the scope also holds the operation's
`GraphQLContext`: each operation of a batch would replace the other's, and a request-scoped provider
injecting it would see another operation's name, signal and document. Amended on 2026-11-05 (review
of milestone 2): first-party drivers refuse batching (Yoga's `batching` option is ZNIGHT066, a type
error first), so a request scope carries exactly one operation with every driver. A child scope per
operation of a batch would lift that; it is not planned.

### 4.8 Errors and masking

The engine formats errors once, with the same rules as today (error mappers, `HttpException`
statuses, masking unless `exposeErrors`, logging of unexpected errors once). The driver factories
turn the server's own masking off so that nothing is masked twice and no original error leaks
through a server's development mode:

- Yoga: the engine's errors (`GraphQLError`s without `originalError`) and `GraphQLError`s thrown on
  purpose are kept as they are by Yoga's `maskError`; any other error, thrown outside the engine (an
  Envelop plugin's hook, Yoga itself), is masked like the engine masks one (`Unexpected error.`,
  its message with `exposeErrors`) and logged once. Amended on 2026-11-05: `maskedErrors: false`
  let such errors reach clients with their raw message;
- Apollo Server: `includeStacktraceInErrorResponses: false`, user `formatError` kept (it receives
  `GraphQLError`s whose message is already masked and which carry no `originalError`).

Request errors raised by the driver itself (malformed JSON, missing query, a persisted query not
found) are the driver's, with its codes and statuses: the engine never sees them. The documentation
lists the differences per driver.

### 4.9 Subscriptions

With Yoga, subscriptions arrive over Yoga's SSE (Yoga calls `engine.subscribe`). The engine keeps
what it guarantees today: the `maxActive` cap across transports, `GraphQLContext.signal` aborted at
the end of the stream, loaders renewed per event, one `graphql:operation` event for the whole
subscription, and the end of every stream on shutdown. The request scope lives as long as the
response body (`trackStream`).

`graphql-ws` is not tied to a driver: its server (`makeServer` / `useServer`) takes `execute`,
`subscribe` and `context` functions, which the engine is. The plan is an engine add-on on top of
`@znight/websocket` (RFC 0003, accepted, in project), whose upgrade routes run the handshake through
the HTTP pipeline: one `graphql-ws` endpoint for the built-in transport and every route-mounted
driver. Until then, a driver that handles WebSocket itself (Mercurius) may offer it, and Yoga users
may follow Yoga's `graphql-ws` recipe on the adapter's server (server-mounted, outside the pipeline,
documented as such).

### 4.10 Lifecycle and graceful shutdown

Amended on 2026-11-05 (review of milestone 2): plugins stop in reverse order, so the steps below
used to depend on it. With `GraphQLPlugin` first, `HttpPlugin`'s drain waited `drainTimeoutMs` for
the driver's event streams; with `HttpPlugin` first, the driver was disposed while `HttpPlugin`
still accepted requests (a 500). The order is now irrelevant:

1. `HttpPlugin.onStop` (the RFC 0006 sequence) calls `onHttpDrain()` on the plugins serving routes
   (a new optional member of `PluginHttpRoutes`) once it started draining. `GraphQLPlugin` ends there
   the subscriptions of the engine (their source is returned, `GraphQLContext.signal` aborts): a
   driver's event stream is a plain streamed body, not a session, and ends with its source.
   `HttpResponse.sse()` sessions get the jittered `retry`. Clients of a driver's SSE see an ordinary
   end of stream (Yoga sends `complete`), not a retry hint: documented as a difference with the
   built-in transport.
2. `GraphQLPlugin.onStop`: aborts the engine's stop signal, ends every subscription the plugin
   owns (direct and engine ones), and stops a server-mounted driver. From step 1 or 2 on, the engine
   answers a new subscription with a `SERVICE_UNAVAILABLE` result.
3. Providers stop and are disposed; `GraphQLPlugin.onDispose` awaits `driver.stop()` for a
   route-mounted driver (Yoga: `yoga.dispose()`; Apollo Server: `server.stop()`), after every
   `onStop`, so the requests of the drain are served; a request reaching the stopped driver gets a
   503. Then it releases the engine.

### 4.11 The built-in transport as the default driver

The built-in transport becomes an implementation of `GraphQLDriver` (`name: 'builtin'`, two routes,
`start` storing the executor), so the plugin has one code path for routes and lifecycle. It keeps
its privileged access to the internal `GraphQLExecutor` (status codes, `FormattedExecutionResult`
with plain error objects, SSE sessions, the memoised negotiation): it does **not** go through the
public engine functions, and none of its per-request code changes. No public `builtinDriver()`
factory is needed (`driver` absent), see Q9.

`@znight/core` gains one field:

```ts
export interface GraphQLOperationEvent {
  // ...
  readonly transport: 'http' | 'sse' | 'ws' | 'direct' // 'ws' reserved for graphql-ws
  /** The driver that received the operation: 'builtin', 'yoga', 'apollo'...; 'direct' calls: 'builtin'. */
  readonly driver: string
}
```

### 4.12 Code-first and schema-first

Both produce the same `metadata.extensions.graphql` (RFC 0007) and the same runtime schema, so a
driver cannot tell them apart: it receives `engine.schema`. Schema-first SDL files are not given to
the driver (it never builds a schema). Nothing changes at build time; the SDL artifact
(`graphql.configure({ sdl })`) stays the schema served, whatever the driver.

### 4.13 Testing

- `executeOperation(app, op)` already goes through `app.inject()` to the endpoint path: with a
  route-mounted driver it reaches the driver's routes, on every adapter, with the same assertions
  (`status`, `data`, `errors`). The default `accept` header is accepted by Yoga and Apollo Server.
- `subscribeOperation(app, op)` reads GraphQL over SSE (`next` / `complete` events, distinct
  connections): it works with Yoga's SSE; with a driver that has no SSE (Apollo Server), it falls
  back to `GraphQLPlugin.subscribe()` as it does today without HTTP transport.
- `TestApp` creates the providers of `initRoots()` unchanged; the driver is started like in
  production (no mock server).
- A conformance suite in `packages/graphql/test/drivers/` runs the same scenarios against the
  built-in transport and every driver (§12).

### 4.14 Observability

`@znight/observability` keeps one span per operation (child of the HTTP span, which the pipeline
still creates for route-mounted drivers) and adds the attribute `znight.graphql.driver` when the
driver is not the built-in one. Metrics are unchanged (no `driver` label: one driver per
application). Server-side tracing plugins (Yoga's OpenTelemetry plugin, Apollo's tracing) would
duplicate the spans: the documentation recommends Znight's, and the driver factories do not install
them.

### 4.15 Packaging

| Entry                         | Exports                                         | Peers (optional)                        |
| ----------------------------- | ----------------------------------------------- | --------------------------------------- |
| `@znight/graphql`             | `GraphQLEngine`, `GraphQLDriver` and their types; `plugin.engine` | `@znight/http` (as today), `graphql` |
| `@znight/graphql/yoga`        | `yogaDriver(options?)`, `YogaDriverOptions`, `yogaContext(ctx)` | `graphql-yoga`                    |
| `@znight/graphql/apollo`      | `apolloDriver(options?)`, `ApolloDriverOptions`, `apolloContext(ctx)` | `@apollo/server`            |
| `@znight/graphql/mercurius` (only if Q8 changes) | `mercuriusDriver(options?)`                | `mercurius`, `fastify`                  |

Rules (CLAUDE.md): each entry in `tsdown.config.ts` and `package.json#exports` with the
`@znight/source` / `types` / `default` triple; servers are optional peer dependencies with caret
ranges and exact devDependencies for the tests; the root entry never imports a driver entry (a new
case in `tests/boundaries.test.ts`), so an application without a driver never loads Yoga or Apollo.
A driver entry imports its server statically (it is only loaded when imported). The compiler entry
is unchanged.

## 5. Drivers

### 5.1 GraphQL Yoga (`@znight/graphql/yoga`, first)

```ts
export function yogaDriver(options?: YogaDriverOptions): GraphQLDriver
```

- Target: `graphql-yoga` 6 (6.0.0 released 2026-10-22: Node.js >= 22.15, graphql `^16 || ^17`,
  Envelop 6 in the same repository), optional peer `graphql-yoga: ^6.0.0`.
- `start`: `createYoga({ ...options, schema: engine.schema, graphqlEndpoint: settings.path,
  graphiql: settings.ide, maskedErrors: false, landingPage: false, maxRequestBodySize: <the
  endpoint's body limit>, plugins: [useEngine({ parse, validate, execute, subscribe,
  specifiedRules }), useZnightContext(), ...options.plugins] })`, with the engine's functions
  wrapped to pass `transport` (`'sse'` for Yoga's event streams) and the request signal. Yoga's
  default engine is `@graphql-tools/executor`'s `normalizedExecutor`, not graphql-js `execute`:
  `useEngine` (a supported Envelop plugin) replaces it with Znight's, so resolvers run exactly as
  with the built-in transport. Yoga 6's `requestId` option is fed from `HttpContext.requestId`, so
  logs of both sides share one id.
- Routes: `GET` and `POST` on `path` (plus `OPTIONS` handled by `HttpPlugin`'s CORS), each calling
  `yoga.fetch(fetchRequest(ctx), { znight: ctx })` and returning the `Response`. Amended on
  2026-11-05: a `POST` body is JSON only, the built-in transport's 415 otherwise, before Yoga parses
  it (Yoga's form-urlencoded and multipart parsers would run a mutation sent by a cross-site form:
  CSRF); Yoga's `multipart` option is refused (ZNIGHT066).
- Why first: Fetch-based (no Node.js-only integration), the closest protocol to Znight's (GraphQL
  over HTTP, SSE subscriptions), Envelop plugins are the largest plugin ecosystem, `useEngine` lets
  Znight keep parse, validate and its document cache, and The Guild maintains NestJS's Yoga driver,
  so its users know it.
- What Yoga users keep: Envelop plugins (`usePersistedOperations`, `useResponseCache`, rate limits,
  armor, Hive usage reporting...), GraphiQL, the SSE single connection mode (`useGraphQLSSE`), the
  `@defer` / `@stream` framing of `useDeferStream` once the engine executes incrementally
  (follow-up). Plugins that replace the engine (`useGraphQlJit`) are refused at boot (ZNIGHT066): the
  engine is Znight's.
- `stop`: `await yoga.dispose()` (runs the plugins' `onDispose`), which NestJS's Yoga driver skips.

### 5.2 Apollo Server (`@znight/graphql/apollo`, second)

```ts
export function apolloDriver(options?: ApolloDriverOptions): GraphQLDriver
```

- **Blocked today**: Apollo Server 5 (5.5.1) declares `graphql: ^16.11.0` as its peer and its
  issue "Support GraphQL v17" (apollographql/apollo-server#8220) has been open since 2026-06-17
  without a date; Znight requires graphql-js 17 (RFC 0005 Q1). Installing both would mean a second
  copy of graphql-js, which breaks `instanceof` checks between the schema and the server. M3 starts
  when Apollo Server accepts graphql 17 (Q12). Apollo Server 4 reached its end of life on
  2026-01-26, so only 5 or later is in scope.
- `start`: `new ApolloServer({ ...options, gateway: znightGateway(engine), introspection:
  settings.introspection, includeStacktraceInErrorResponses: false, parseOptions: { maxTokens },
  validationRules: engine.rules, plugins: [landing page from settings.ide, ...options.plugins] })`,
  then `await server.start()`. The `gateway` option is Apollo Server's supported way to supply a
  schema and an executor built elsewhere (`GatewayInterface.load()` returns `{ schema, executor }`,
  the executor receives the request context with the parsed document): the executor calls
  `engine.execute`. Apollo Server has no `execute` option; the other interception point, the
  `responseForOperation` plugin hook, would bypass Apollo's own execution plugins, so the gateway
  interface is preferred. Apollo Server keeps its own parsing, validation and document store. A
  gateway executor returns a single result, so `@defer` / `@stream` would not flow through it.
- Apollo's defaults are kept unless they clash with the engine: `csrfPrevention` and APQ
  (`persistedQueries`) stay on, `allowBatchedHttpRequests` stays off,
  `includeStacktraceInErrorResponses` is forced off (the engine masks).
- Routes: `GET` and `POST` on `path`, building an `HTTPGraphQLRequest` (`method`, `headers` as a
  `HeaderMap`, `search`, parsed JSON `body`) from `HttpContext`, calling
  `server.executeHTTPGraphQLRequest({ httpGraphQLRequest, context: async () => ({ znight: ctx }) })`
  and answering an `HttpResponse` with its status, headers and body (`complete` string, or a stream
  for `chunked` bodies). No Fetch objects and no Express integration package are needed.
- What Apollo users keep: Apollo Server plugins, usage reporting, Sandbox / Explorer landing pages,
  APQ, CSRF prevention, `formatError` on masked errors.
- Subscriptions: Apollo Server has none over HTTP; `subscribeOperation` falls back to
  `plugin.subscribe()`; `graphql-ws` comes with the engine add-on (§4.9).

### 5.3 Mercurius (`@znight/graphql/mercurius`, on demand)

Mercurius (16.12, Fastify 5, graphql `^16 || ^17` since 16.11) accepts a prebuilt `GraphQLSchema`,
but it is a poor fit for this contract:

- it is a Fastify plugin registering its own routes on the instance, so it cannot be
  route-mounted. A driver would be server-mounted on `fastifyAdapter().instance`, outside
  `HttpPlugin`'s pipeline: no Znight request scope around it, no `http:request` hook (no HTTP span
  from Znight), no Znight HTTP guards, no CORS from `HttpPlugin`;
- it has **no execute hook**: it calls graphql-js `execute` (or a `graphql-jit` compiled query)
  itself with its own context, and `preExecution` can only swap the schema or the document. The
  resolvers would receive Mercurius's context instead of the `GraphQLContext`, so the engine's
  guarantees (context, loaders, masking, hook) would need every resolve function to look the
  context up in the scope, a cost on the default path that rule 1 of §6 forbids;
- its main assets overlap with or conflict with the engine: `graphql-jit` replaces `execute`
  (Znight's pipelines live in graphql-js resolve functions; JIT is an engine question, §14),
  Mercurius loaders duplicate `@Loader()`, and its federation packages require graphql 16.

What it adds is Fastify-native routing and built-in WebSocket subscriptions, which the built-in
transport on `fastifyAdapter()` and the `graphql-ws` add-on cover. Recommendation: not planned
unless Mercurius gains an execute hook and users ask for it (Q8).

### 5.4 Third-party drivers

The contract is public: a driver for another server (Helix, `graphql-http`'s handlers, a company's
in-house gateway layer) is a package exporting a factory. The first-party conformance suite is
exported from `@znight/graphql/testing` (`describeDriverConformance(driver)`, milestone M2) so third
parties can run it.

## 6. Performance

The built-in transport is the fastest path and stays the default: performance is a first-class
requirement (RFC 0005 §8.12). Rules:

1. **The default path pays nothing.** Without `driver`, the plugin runs today's handlers and
   executor: no driver indirection per request, no `GraphQLError` conversion, no Web `Request`, no
   new branch on the hot path (decided at boot). The micro-benchmarks
   (`packages/graphql/test/bench/http.bench.ts`, `execute.bench.ts`) are run before and after M1 and
   must stay within noise.
2. **Driver code is not loaded unless used.** Driver entries are separate, the root entry never
   imports them (boundaries test).
3. **No double work.** One parse and one validation per document (the engine's cache or the
   server's, never both), masking once, one span per operation.
4. **Bridges allocate lazily.** The native Web `Request` is reused on `honoAdapter()`; a `Request`
   is built only on Node-style adapters; Apollo's bridge builds no Fetch object at all.
5. **Every driver is measured.** The planned GraphQL benchmark runs the same application with the
   built-in transport and each driver, on each adapter and runtime, and the results are published in
   `docs/benchmarks.md` with the HTTP ones, unfavourable numbers included.

Public measurements are old and use trivial schemas: benawad/node-graphql-benchmarks (2024-05)
reports about 8.6k requests/s for `graphql-http`, 4.4k for Mercurius (7.6k with JIT), 3.8k for Yoga
on Node.js and 2.1k to 2.6k for Apollo Server on Express or Fastify; graphql-crystal/benchmarks
(2024-10) has the same order (Mercurius, then Yoga, then Apollo). None covers Yoga 6, Apollo Server
5, Mercurius 16 or graphql-js 17, and none runs inside a framework's pipeline, so they only say where
to expect the overhead. Expected costs, to be measured (no number is claimed here):

| Path                          | Extra work per request compared with the built-in transport                                                                                                                         | Expectation                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Yoga on `honoAdapter()` (Bun) | Yoga's request parsing and Envelop's plugin chain, its result serialisation, a `Response` read back by the serialiser                                                                | the cheapest driver                          |
| Yoga on Node-style adapters   | the above, plus a `Request` built from `HttpContext` (headers copied, body as a stream) and a Web `Response` body piped to a Node.js response                                       | slower than on Hono; how much is the question |
| Apollo Server                 | its request pipeline and plugin lifecycle (several awaits per request), `HeaderMap`, its own parse, validation and document store, the gateway executor indirection                 | the most expensive of the two                |
| Engine functions (any driver) | `GraphQLError` instances for errors (error results only), the `driver` field of the event                                                                                          | negligible on success                        |

The benchmark answers whether a driver is "fast enough" for a given application; the documentation
states the trade-off plainly: drivers buy ecosystem, the built-in transport buys throughput.

## 7. Compatibility and migration

Nothing changes for existing applications: `driver` is a new optional key, the built-in transport is
unchanged, `GraphQLOperationEvent` gains a field (consumers that build events, such as tests, add
`driver`; reading code is unaffected).

From NestJS:

| NestJS (`@nestjs/graphql`)                                                 | Znight                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver })`      | `GraphQLPlugin.configure({ driver: apolloDriver() })`                                                |
| `driver: YogaDriver` (`@graphql-yoga/nestjs`)                              | `driver: yogaDriver()`                                                                               |
| `driver: MercuriusDriver`                                                  | the built-in transport on `fastifyAdapter()` (Mercurius: Q8)            |
| `ApolloFederationDriver`, `YogaFederationDriver`, `MercuriusFederationDriver` | Not yet: engine-level federation follow-up, with any driver                                      |
| `ApolloGatewayDriver`                                                      | Not planned: Apollo Router or Hive Gateway in front of Znight subgraphs                              |
| `plugins: [...]` (Apollo), Envelop `plugins` (Yoga)                         | `apolloDriver({ plugins })`, `yogaDriver({ plugins })`                                               |
| `playground` / `graphiql: true`                                            | `graphiql: true` (the driver's IDE)                                                                  |
| `context: ({ req }) => ({ user: req.user })`                               | Request-scoped providers (RFC 0005 Q9); `GraphQLContext.http`; the server context through `yogaContext(ctx)` / `apolloContext(ctx)` |
| `formatError`                                                              | `errorMappers` (engine); Apollo's `formatError` still runs on masked errors                          |
| `persistedQueries` (Apollo), Yoga persisted operations                      | The driver's option or plugin                                                                       |
| `subscriptions: { 'graphql-ws': true }`                                    | SSE with Yoga or the built-in transport; `graphql-ws` with the `@znight/websocket` add-on            |
| `fieldResolverEnhancers: ['guards']`                                       | Field guards always run on root fields and on field resolvers with metadata (RFC 0005 §5.9)         |
| `autoSchemaFile`, `typePaths`                                              | `graphql.configure({ sdl })` (code-first), `graphql.configure({ schema })` (schema-first)            |
| `transformSchema`, `buildSchemaOptions`                                    | Not supported: the engine owns the schema                                                            |
| `useGlobalPrefix`, `path`                                                  | The `HttpPlugin` prefix always applies; `path`                                                       |
| Mercurius `jit`, `loaders`                                                 | No JIT (engine follow-up, measured first); `@Loader()`                                              |

## 8. Error codes

None. ZNIGHT066 (`InvalidGraphQLSetup`) is the GraphQL catch-all for invalid usage and options, and
covers: an invalid `driver` value, a driver option the engine owns, a route-mounted driver with
`http: false`, a driver on an adapter it does not support (Mercurius without `fastifyAdapter()`),
SSE options with a driver, a driver failing to start (original error as `cause`), and an
`ExecutionArgs.schema` that is not the engine's. A missing optional peer surfaces as the runtime's
module resolution error on `import '@znight/graphql/yoga'`, at the user's import, like every
subpath of Znight. ZNIGHT069 stays free.

## 9. Alternatives considered

| Alternative                                                                                 | Verdict                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1. Status quo plus recipes (the guide's Yoga recipe on `plugin.execute()`)                 | Works for Yoga today, with the costs listed in §2.3 (double parse and validation, `transport: 'direct'`, no `GraphQLError`s, the server's document ignored, no shutdown), and every application copies it. Its smallest improvement is "engine API + recipes, no driver packages": milestone M1 alone. Rejected by the owner (Q1) in favour of driver packages |
| A2. Yoga only                                                                               | Simplest, Fetch-based, closest to Znight's protocol. But Apollo Server is what most NestJS GraphQL applications run, and its plugins and usage reporting have no Yoga equivalent. The contract stays generic; Yoga ships first                                              |
| A3. The driver owns schema and execution (NestJS model)                                     | Rejected (§2.4): loses build-time binding, field guards and ZNIGHT023, loaders per execution, errors as data, masking defaults and the single hook; every guarantee would depend on the driver                                                                               |
| A4. Transport adapters at the HTTP level (a generic `HttpPlugin.mount(path, fetchHandler)`) | Useful beyond GraphQL (an auth library's Fetch handler...), but it does not solve the context bridge, which is the hard part, and plugin routes already accept a Web `Response`. Kept as a possible `@znight/http` follow-up; the GraphQL bridge helper stays internal (Q10) |
| A5. Yoga as the default transport                                                           | Rejected (RFC 0005 Q2 still holds): heavier dependencies, WHATWG conversions on Node.js adapters, slower than the built-in path that most applications need                                                                                                                 |
| A6. Envelop inside the engine (Envelop plugins on the built-in transport, no Yoga)          | Tempting (the plugin ecosystem without the server), but many Envelop plugins depend on Yoga's request phases (`onRequest`, `onResponse`, params), and it adds a plugin layer to the default path. Not now; reconsider after the benchmark                                  |
| A7. Drivers as separate packages (`@znight/graphql-yoga`, `@znight/graphql-apollo`)         | Rejected: Znight's convention is subpath exports with optional peers (`@znight/http/fastify`, `@znight/messaging/kafka`), versioned in lockstep with the engine they depend on                                                                                              |

## 10. Open questions (with recommended answers)

| #   | Question                                                                                     | Recommendation                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Ship driver packages, or only the engine API with recipes?                                  | Decided (2026-11-04): **Engine API (M1), then Yoga (M2) as a package, Apollo (M3) when it accepts graphql 17.** Lifecycle, options mapping, masking, shutdown and adapter coverage are where recipes go wrong; a tested driver is cheaper for users than a recipe they copy |
| Q2  | Do resolvers see the driver's context?                                                       | Decided (2026-11-04): **Not as `contextValue`**: resolvers keep `GraphQLContext`. Expose it as `GraphQLContext.serverContext: unknown`, with typed readers in each entry (`yogaContext(ctx)`, `apolloContext(ctx)`) for the rare resolver that needs it                               |
| Q3  | Who parses and validates with a driver?                                                      | Decided (2026-11-04): **The engine when the server allows it** (Yoga `useEngine`: one cache, same limits, rejections observed by the hook); otherwise the server, with `engine.rules` and `maxTokens` (Apollo). Never both                                                      |
| Q4  | Who masks errors?                                                                            | **The engine, once.** Driver factories turn server masking off; a server's `formatError` sees masked errors                                                                                                                                                  |
| Q5  | Subscriptions and `graphql-ws`?                                                              | **The driver's own transports for now** (Yoga SSE), with the engine's cap and shutdown; `graphql-ws` as an engine add-on on `@znight/websocket` (RFC 0003, accepted, in project), shared by every driver and the built-in transport                       |
| Q6  | `@defer` / `@stream`?                                                                        | **A follow-up RFC**: engine-side `executeIncrementally` (graphql-js 17 `experimentalExecuteIncrementally`) behind an option, framed by drivers that speak incremental delivery and later by the built-in transport. The contract reserves the method name |
| Q7  | Federation?                                                                                  | **A follow-up RFC, engine-side**: `@key` and reference resolvers derived at build time, `_service` / `_entities` added to the schema by the engine (the JavaScript federation libraries require graphql 16), served by any driver including the built-in one. Not a driver feature |
| Q8  | Mercurius?                                                                                   | Decided (2026-11-04): **Not planned for now.** It has no execute hook (resolvers would not get the `GraphQLContext`), it can only be server-mounted outside the HTTP pipeline, and its JIT and loaders overlap with the engine. Reconsider if it gains an execute hook and users ask |
| Q9  | A public `builtinDriver()`?                                                                  | **No.** `driver` absent is the built-in transport; a factory would only add a way to write the default                                                                                                                                                    |
| Q10 | Where does the Fetch bridge (`HttpContext` → Web `Request`) live?                             | **Internal to `@znight/graphql` first**, promoted to `@znight/http` (with A4) when a second user appears                                                                                                                                                   |
| Q11 | A `driver` field on the hook event, or widen `transport`?                                    | **A `driver` field**; `transport` stays the protocol (`http`, `sse`, `ws`, `direct`), so dashboards keep their meaning                                                                                                                                     |
| Q12 | graphql-js versions, and Apollo Server 5 requiring graphql 16?                               | Decided (2026-11-04): **17 only, as today** (RFC 0005 Q1): a driver never brings a second copy of graphql-js. The Apollo driver waits for Apollo Server to accept graphql 17 (apollographql/apollo-server#8220); supporting graphql 16 in the engine for Apollo alone would undo RFC 0005's choices (abort signals, `executeSubscriptionEvent`, `hideSuggestions`) |

## 11. Implementation plan

Milestones (one developer, days):

| Milestone                  | Content                                                                                                                                                                                                                             | Days |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| M1. Engine and contract    | `GraphQLEngine` (`parse`, `validate`, `rules`, `execute`, `subscribe`), `plugin.engine`, `GraphQLDriver`, the `driver` option, the built-in transport behind the contract with no hot path change (benchmarks before and after), `GraphQLOperationEvent.driver` in core, shutdown of every engine stream, a `graphql-http` test driver (its `createHandler` on the engine) running the audits; specification §8.3 and §9.7, README, guide | 4    |
| M2. Yoga                   | `@znight/graphql/yoga`, the Fetch bridge, adapters × runtimes matrix, SSE subscriptions, `executeOperation` / `subscribeOperation`, the `graphql-http` audits through Yoga, conformance suite (exported for third-party drivers), docs (driver page, NestJS mapping; the guide's Yoga recipe becomes `yogaDriver()`), benchmark | 4    |
| M3. Apollo Server (once it accepts graphql 17) | `@znight/graphql/apollo`, the gateway executor, the `HTTPGraphQLRequest` bridge (`complete` and `chunked` bodies), landing pages, drain, docs, benchmark                              | 4    |
| M4. On demand              | Mercurius if Q8 changes; the engine follow-ups that every driver inherits: `graphql-ws` on `@znight/websocket`, incremental delivery, federation (each with its own RFC)                                                                | —    |

Each milestone is a pull request with a changeset (`@znight/graphql` minor for the new API,
`@znight/core` minor for the event field, `@znight/observability` patch).

## 12. Testing plan

- **Engine** (`test/engine.test.ts`): parse cache identity, limits as parse errors and as rules,
  introspection rule, validation cache, execution in an existing scope and in a scope of its own,
  `GraphQLContext` fields (`http`, `transport`, `signal`, `serverContext`), errors as `GraphQLError`
  instances (masked, mapped, result mappers), the hook with `driver`, `maxActive`, the end of
  streams on stop, a foreign schema refused (ZNIGHT066).
- **Conformance suite** (`test/drivers/conformance.ts`), run for `builtin`, `yoga`, `apollo`: the
  `examples/graphql-api` scenarios (queries, mutations, field guards and ZNIGHT023 decisions, HTTP
  guards on the endpoint, loaders batching to one call, request-scoped providers per request,
  result mappers, masking, introspection off, limits), subscriptions where the driver has them
  (start, events, client abort, `maxActive`, shutdown), on `node`, `fastify`, `express` and `hono`,
  on Node.js and Bun (Bun in CI like the other suites).
- **Boundaries**: the root entry never imports `/yoga` or `/apollo`; driver entries never import
  `./compiler`.
- **Performance**: the existing micro-benchmarks unchanged without `driver` (M1); the GraphQL
  benchmark (by hand, like the HTTP one) with each driver.
- **Docs tests**: every `@znight/graphql/yoga` and `/apollo` import of the docs compiles against the
  real API.

## 13. Documentation

Specification §8.3 (the event field) and §9.7 (engine, driver contract, options, lifecycle), the
package README (a "Drivers" section, the options table, the limitations), `docs/guide/graphql.md`
(choosing a driver: the trade-off, the per-driver differences in protocol, IDE and subscriptions),
`docs/guide/migrating-from-nestjs.md` (the mapping of §7), `docs/benchmarks.md` (driver results),
`docs/roadmap.md` (the engine follow-ups), and the error reference (ZNIGHT066 cases).

## 14. Out of scope

- Federation, `@defer` / `@stream`, `graphql-ws`, JIT, query cost analysis, build-time trusted
  documents: engine follow-ups, each with an RFC, inherited by every driver.
- An Apollo Gateway or a router inside the application.
- Driver-specific decorators (an `@ApolloCacheControl`...): server features are configured through
  the driver's options and plugins, never through new markers on resolvers.
- Envelop plugins on the built-in transport (A6).

## 15. Appendix: the servers today

Checked on 2026-11-04 (npm `latest`, the repositories' default branches).

| Package                                       | Version (release)                    | graphql-js peer                       | How Znight's engine plugs in                                                                                                                                              |
| --------------------------------------------- | ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graphql`                                     | 17.0.2 (17.0.0: 2026-06-15)          |                                       | `execute`, `createSourceEventStream`, `executeSubscriptionEvent`; `experimentalExecuteIncrementally` for incremental delivery (follow-up)                                 |
| `@nestjs/graphql`                             | 14.1.2 (14.0.0: 2026-08-27, Nest 12) | `^16.11.0 \|\| ^17.0.0`             | (reference) `GraphQLDriver { start(options), stop() }`, the schema built by Nest                                                                                          |
| `graphql-yoga`                                | 6.0.1 (6.0.0: 2026-10-22)            | `^16 \|\| ^17`                      | `yoga.fetch(request, serverContext)`; Envelop `useEngine({ parse, validate, execute, subscribe, specifiedRules })`; `yoga.dispose()`                                      |
| `@apollo/server`                              | 5.5.1 (5.0.0: 2025-07-17)            | `^16.11.0` (graphql 17: issue #8220)  | `executeHTTPGraphQLRequest({ httpGraphQLRequest, context })` (`complete` or `chunked` body); `gateway: GatewayInterface` (`load()` returns `{ executor }`); `start()`, `stop()` |
| `mercurius`                                   | 16.12.1 (Fastify 5)                  | `^16 \|\| ^17` (since 16.11)        | Fastify plugin, prebuilt schema accepted; hooks `preParsing`, `preValidation`, `preExecution`, `onResolution`; no execute hook                                           |
| `graphql-ws`                                  | 6.4.1                                | `^15.10.1 \|\| ^16 \|\| ^17`      | `makeServer`, `useServer` (`graphql-ws/use/ws`), `graphql-ws/use/bun`; options `execute`, `subscribe`, `context`, `onSubscribe`                                          |
| `graphql-http`, `graphql-sse`                 | 1.23.1, 2.6.3                        | `>=0.11 <=17`                         | `createHandler({ schema, execute, subscribe, context })` (fetch, node, express, fastify): the M1 test driver                                                              |
| `@apollo/subgraph`, `@mercuriusjs/federation` | 2.15.1, 5.1.1                        | graphql 16 only                       | Not usable with graphql-js 17 today (federation is an engine follow-up)                                                                                                  |
| `@graphql-hive/gateway`                       | 2.15.6 (on Yoga 5)                   | `^15.9.0 \|\| ^16.9.0`              | A router in front of Znight subgraphs, not a driver                                                                                                                       |

Notes:

- Apollo Server 5: Node.js >= 20; Apollo Server 4 reached its end of life on 2026-01-26; incremental
  delivery is experimental and only with the pre-release `graphql@17.0.0-alpha.9`; the integrations
  maintained by Apollo are Express 4 and 5 (`@as-integrations/express5`), the others (Fastify, Koa,
  Lambda...) are community packages; there is no Hono or Bun integration.
- Yoga 6: Fetch API server (`@whatwg-node/server`), SSE subscriptions by default (distinct
  connections), `graphql-ws` through `yoga.getEnveloped()`, `maxRequestBodySize` 25 MB by default,
  `requestId` option, `@graphql-hive/logger`. Plugins named in this RFC: `usePersistedOperations`,
  `useResponseCache`, `useDeferStream`, `useGraphQLSSE`, `useGraphQlJit`.
- Mercurius: `jit` bundles `graphql-jit` 0.8.10; `defer` needs graphql 17, excludes `jit` and uses
  `legacyExecuteIncrementally`; WebSocket subscriptions through `@fastify/websocket` (`graphql-ws`
  and `graphql-transport-ws` subprotocols).
