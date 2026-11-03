# @znight/graphql

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
