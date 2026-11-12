# @znight/graphql

## 0.9.1

### Patch Changes

- 5e828fc: Schema-first: the `ignoredDirectives` compiler option lists the custom directives kept in the SDL for other tools (graphql-codegen transforms...), left out of the served schema without the ZNIGHT067 warning.
- Updated dependencies [5e828fc]
  - @znight/compiler@0.9.1
  - @znight/http@0.9.1
  - @znight/core@0.9.1
  - @znight/testing@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [394c247]
- Updated dependencies [394c247]
  - @znight/compiler@0.9.0
  - @znight/core@0.9.0
  - @znight/testing@0.9.0
  - @znight/http@0.9.0

## 0.8.0

### Patch Changes

- @znight/compiler@0.8.0
  - @znight/core@0.8.0
  - @znight/http@0.8.0
  - @znight/testing@0.8.0

## 0.7.3

### Patch Changes

- bb1c8f1: Report unexpected resolver errors (and the causes of shown `GraphQLException`s) on the `error:report` hook, with the operation context.
- Updated dependencies [bb1c8f1]
- Updated dependencies [0804801]
- Updated dependencies [bb1c8f1]
  - @znight/core@0.7.3
  - @znight/http@0.7.3
  - @znight/compiler@0.7.3
  - @znight/testing@0.7.3

## 0.7.2

### Patch Changes

- @znight/compiler@0.7.2
  - @znight/core@0.7.2
  - @znight/http@0.7.2
  - @znight/testing@0.7.2

## 0.7.1

### Patch Changes

- 3cbfd77: The `homepage` of every package points to its page of the documentation site.
- Updated dependencies [3cbfd77]
  - @znight/compiler@0.7.1
  - @znight/core@0.7.1
  - @znight/http@0.7.1
  - @znight/testing@0.7.1

## 0.7.0

### Patch Changes

- @znight/compiler@0.7.0
  - @znight/core@0.7.0
  - @znight/http@0.7.0
  - @znight/testing@0.7.0

## 0.6.6

### Patch Changes

- Updated dependencies [d85b11b]
  - @znight/compiler@0.6.6
  - @znight/http@0.6.6
  - @znight/core@0.6.6
  - @znight/testing@0.6.6

## 0.6.5

### Patch Changes

- Updated dependencies [1a2b15c]
- Updated dependencies [ad31655]
  - @znight/http@0.6.5
  - @znight/compiler@0.6.5
  - @znight/core@0.6.5
  - @znight/testing@0.6.5

## 0.6.4

### Patch Changes

- 74b6b04: Migration note for the ZNIGHT023 boot check shipped in 0.6.3: a field decision of a group that an application guard enforces (`static enforces`, even an HTTP-only guard) is reported at boot when no guard of the field's GraphQL chain enforces it. An application or a resolver `TestApp` that booted on 0.6.2 without that guard in `GraphQLPlugin.configure({ guards })` fails to boot: register the guard there, or set `enforcement: 'warn'` where it is intended.
- 74b6b04: The document cache keeps query texts up to 128 KiB (1/64 of its 8 MiB budget) instead of 16 KiB, so large pretty-printed or fragment-heavy operations are cached again.
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
  - @znight/compiler@0.6.4
  - @znight/core@0.6.4
  - @znight/http@0.6.4
  - @znight/testing@0.6.4

## 0.6.3

### Patch Changes

- 364e495: Fix audit findings: linear SDL comment check, ZNIGHT023 for decisions only an HTTP-only guard enforces, a size-bounded document cache, abort signal listeners that no longer leak and follow delayed executions, ZNIGHT060 for alias cycles, and a per-principal response cache example.
- Updated dependencies [0eeac37]
- Updated dependencies [dede0c2]
- Updated dependencies [dc4be25]
  - @znight/compiler@0.6.3
  - @znight/core@0.6.3
  - @znight/http@0.6.3
  - @znight/testing@0.6.3

## 0.6.2

### Patch Changes

- 0fd25f5: The Yoga driver is about twice as fast on Node.js: Yoga keeps its default Fetch API (the `@whatwg-node` ponyfills, instead of undici), its responses are converted for `HttpPlugin` (a JSON body sent as text with its length, an event stream still streamed), and request bodies are no longer piped through Yoga's own size limit (the route's body limit already applies).
- @znight/compiler@0.6.2
  - @znight/core@0.6.2
  - @znight/http@0.6.2
  - @znight/testing@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [3785557]
  - @znight/http@0.6.1
  - @znight/compiler@0.6.1
  - @znight/core@0.6.1
  - @znight/testing@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [f6cbef6]
- Updated dependencies [f6cbef6]
  - @znight/http@0.6.0
  - @znight/core@0.6.0
  - @znight/testing@0.6.0
  - @znight/compiler@0.6.0

## 0.5.1

### Patch Changes

- @znight/compiler@0.5.1
  - @znight/core@0.5.1
  - @znight/http@0.5.1
  - @znight/testing@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [469d6bf]
  - @znight/core@0.5.0
  - @znight/compiler@0.5.0
  - @znight/http@0.5.0
  - @znight/testing@0.5.0

## 0.4.0

### Minor Changes

- 3bb4597: Custom parameter decorators (RFC 0010): `createParamDecorator<T, D>({ http, graphql, messaging })` defines a `@CurrentUser()` of your own, checked at build time (target, transport, data argument, value type) and called directly by the generated `invoke` of routes, GraphQL fields and message handlers; resolvers are functions or `ParamResolver` providers in any scope. The compiler adds `AnalyzeContext.paramDecorator` and `TypeHelpers.assignable` to the extension API; `TestApp` instantiates parameter resolvers with the controllers, resolvers and consumers.

### Patch Changes

- Updated dependencies [3bb4597]
  - @znight/core@0.4.0
  - @znight/compiler@0.4.0
  - @znight/http@0.4.0
  - @znight/testing@0.4.0

## 0.3.0

### Minor Changes

- 75f4b8c: `PluginHttpRoutes.onHttpDrain()`: `HttpPlugin` tells the plugins serving routes that it starts draining, whatever the plugin order, so they end the streams it does not know of. The engine's subscriptions end there, and a route-mounted GraphQL driver stops once the drain is over (requests in flight are served, a stopped driver answers 503). The Yoga driver takes `application/json` `POST` bodies only (415 otherwise, like the built-in transport: no CSRF through forms), masks errors thrown outside the engine, and refuses Yoga's `batching` and `multipart` options (ZNIGHT066).
- 75f4b8c: GraphQL drivers, milestone 1 (RFC 0009): `plugin.engine`, a `GraphQLEngine` whose graphql-js-shaped `parse`, `validate`, `execute` and `subscribe` run the schema with its guards, loaders, request scope, error formatting (as `GraphQLError` instances) and hook; the `GraphQLDriver` contract and the `driver` option, whose routes are mounted in the `HttpPlugin` pipeline; `GraphQLContext.serverContext`. The built-in transport stays the default with an unchanged hot path.
- 75f4b8c: GraphQL drivers, milestone 2 (RFC 0009): `@znight/graphql/yoga` serves the schema with GraphQL Yoga 6 (`yogaDriver()`, `yogaContext()`; `graphql-yoga` is an optional peer dependency) on the engine, which parses, validates and executes every operation, on every adapter, on Node.js and Bun; `describeDriverConformance()` in `@znight/graphql/testing` runs the scenarios every driver passes.

### Patch Changes

- Updated dependencies [75f4b8c]
- Updated dependencies [75f4b8c]
  - @znight/core@0.3.0
  - @znight/http@0.3.0
  - @znight/compiler@0.3.0
  - @znight/testing@0.3.0

## 0.2.2

### Patch Changes

- @znight/compiler@0.2.2
  - @znight/core@0.2.2
  - @znight/http@0.2.2
  - @znight/testing@0.2.2

## 0.2.1

### Patch Changes

- c3e6b01: Errors as data (RFC 0008): `resultMappers` turn the errors of guards, argument validation and resolvers into values of the field's union, on the fields whose union holds a type they declare (decided at boot, no cost for the other fields).
- 1ecae4f: Schema-first GraphQL (RFC 0007): `graphql.configure({ schema: 'src/**/*.graphql' })` makes the SDL files the schema, binds resolvers by name (`@Resolver('Type')`, `@ResolveField()`), checks coverage and type conformance at build time (ZNIGHT067, ZNIGHT068) and supports GraphQL interfaces; the compiler gains `ValidateContext.inputFiles()`.
- Updated dependencies [1ecae4f]
  - @znight/compiler@0.2.1
  - @znight/core@0.2.1
  - @znight/http@0.2.1
  - @znight/testing@0.2.1

## 0.2.0

### Minor Changes

- b6119e6: New package `@znight/graphql`: code-first GraphQL whose schema is derived from TypeScript types at build time, served on graphql-js 17 through `HttpPlugin` with loaders, subscriptions over SSE, route decisions and guards (RFC 0005).

### Patch Changes

- 5306d9f: Start a subscription's source before the SSE response starts or `plugin.subscribe()` resolves, so an `async *` resolver has subscribed to the PubSub when `subscribeOperation()` resolves (an event published right after is no longer lost, on every adapter); a subscription's `ctx.signal` now also aborts when its stream ends, and `return()` no longer waits for a source still awaiting an event.
- Updated dependencies [b6119e6]
- Updated dependencies [b6119e6]
  - @znight/compiler@0.2.0
  - @znight/http@0.2.0
  - @znight/core@0.2.0
  - @znight/testing@0.2.0
