# @znight/core

## 0.9.1

No changes in this release.

## 0.9.0

### Minor Changes

- 394c247: Breaking: the `__ZNIGHT_METADATA__` export of the generated module is renamed `metadata` (the compiled graph), with no deprecated alias and no default export, and the module also exports `createApplication(options)`, which is `Application.create({ ...options, metadata })`: `main.ts` becomes `const app = await createApplication({ plugins: [...] })` and tests pass `{ metadata }` (RFC 0015). `@znight/core` exports the `CreateApplicationOptions` type (`ApplicationOptions` without `metadata`). The error module exports the same two names, and the ZNIGHT020 diagnostic hints at editor auto-imports of `metadata` and `createApplication`. To migrate: `sed -i '' -e 's/__ZNIGHT_METADATA__ as metadata/metadata/g; s/metadata: __ZNIGHT_METADATA__/metadata/g; s/__ZNIGHT_METADATA__/metadata/g' src/main.ts test/**/*.ts`, then optionally switch `main.ts` to `createApplication`.

## 0.8.0

No changes in this release.

## 0.7.3

### Patch Changes

- bb1c8f1: New `error:report` hook: one event per error the framework turns into a failure (5xx, failed delivery or run, detached listener, lifecycle failure), for Sentry-style reporters; core reports lifecycle failures.

## 0.7.2

No changes in this release.

## 0.7.1

### Patch Changes

- 3cbfd77: The `homepage` of every package points to its page of the documentation site.

## 0.7.0

No changes in this release.

## 0.6.6

No changes in this release.

## 0.6.5

No changes in this release.

## 0.6.4

### Patch Changes

- 74b6b04: Stop and dispose a plugin or provider whose `onStart` settles after `stop()` stopped waiting for it, instead of leaking what it opened.

## 0.6.3

### Patch Changes

- dede0c2: Bound the wait of `stop()` for a hanging start, report a re-entrant request-scoped or transient creation as ZNIGHT002, dispose an instance whose interceptors fail, and close a scope synchronously when nothing in it is disposable.

## 0.6.2

No changes in this release.

## 0.6.1

No changes in this release.

## 0.6.0

### Minor Changes

- f6cbef6: Upgrade routes for plugins (RFC 0003 groundwork): `PluginHttpUpgrades`, the adapters' upgrade capability, `HttpPlugin.upgradeInMemory()`, the `websocket:*` hook types and the ZNIGHT050/051 codes.

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
