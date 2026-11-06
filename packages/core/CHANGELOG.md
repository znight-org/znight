# @znight/core

## 0.5.1

No changes in this release.

## 0.5.0

### Minor Changes

- 469d6bf: New `@znight/events` package (RFC 0011): in-process application events, `@OnEvent` listeners found and checked at build time, `EventPublisher` with inline and detached dispatch, `recordEvents()` for tests; core gains the `events:publish` and `events:listener` hooks and ZNIGHT070.

## 0.4.0

### Minor Changes

- 3bb4597: Custom parameter decorators (RFC 0010): `createParamDecorator<T, D>({ http, graphql, messaging })` defines a `@CurrentUser()` of your own, checked at build time (target, transport, data argument, value type) and called directly by the generated `invoke` of routes, GraphQL fields and message handlers; resolvers are functions or `ParamResolver` providers in any scope. The compiler adds `AnalyzeContext.paramDecorator` and `TypeHelpers.assignable` to the extension API; `TestApp` instantiates parameter resolvers with the controllers, resolvers and consumers.

## 0.3.0

### Minor Changes

- 75f4b8c: `GraphQLOperationEvent.driver`: the GraphQL driver that received the operation (`builtin` for the built-in transport and direct calls), and the `ws` transport reserved for `graphql-ws` (RFC 0009).

## 0.2.2

No changes in this release.

## 0.2.1

### Patch Changes

- 1ecae4f: Schema-first GraphQL (RFC 0007): `graphql.configure({ schema: 'src/**/*.graphql' })` makes the SDL files the schema, binds resolvers by name (`@Resolver('Type')`, `@ResolveField()`), checks coverage and type conformance at build time (ZNIGHT067, ZNIGHT068) and supports GraphQL interfaces; the compiler gains `ValidateContext.inputFiles()`.

## 0.2.0

No changes in this release.

## 0.1.4

### Patch Changes

- c21ef01: GraphQL error codes ZNIGHT060–066 and the `graphql:operation` hook with its `GraphQLOperationEvent` (RFC 0005).

## 0.1.3

### Patch Changes

- 39f7f5f: A fast lane for simple routes: a synchronous handler returning JSON is served without promises and its headers come from a template computed at boot; `container.openScope()` opens a request scope without a callback.

## 0.1.2

No changes in this release.

## 0.1.1

No changes in this release.

## 0.1.0

### Initial release

- First public release of `@znight/core`. Znight core runtime: compile-time DI container, lifecycle, plugins and marker decorators.
