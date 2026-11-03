# @znight/graphql

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
