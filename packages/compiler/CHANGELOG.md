# @znight/compiler

## 0.6.1

### Patch Changes

- @znight/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [f6cbef6]
  - @znight/core@0.6.0

## 0.5.1

### Patch Changes

- @znight/core@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [469d6bf]
  - @znight/core@0.5.0

## 0.4.0

### Minor Changes

- 3bb4597: Custom parameter decorators (RFC 0010): `createParamDecorator<T, D>({ http, graphql, messaging })` defines a `@CurrentUser()` of your own, checked at build time (target, transport, data argument, value type) and called directly by the generated `invoke` of routes, GraphQL fields and message handlers; resolvers are functions or `ParamResolver` providers in any scope. The compiler adds `AnalyzeContext.paramDecorator` and `TypeHelpers.assignable` to the extension API; `TestApp` instantiates parameter resolvers with the controllers, resolvers and consumers.

### Patch Changes

- Updated dependencies [3bb4597]
  - @znight/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [75f4b8c]
  - @znight/core@0.3.0

## 0.2.2

### Patch Changes

- @znight/core@0.2.2

## 0.2.1

### Patch Changes

- 1ecae4f: Schema-first GraphQL (RFC 0007): `graphql.configure({ schema: 'src/**/*.graphql' })` makes the SDL files the schema, binds resolvers by name (`@Resolver('Type')`, `@ResolveField()`), checks coverage and type conformance at build time (ZNIGHT067, ZNIGHT068) and supports GraphQL interfaces; the compiler gains `ValidateContext.inputFiles()`.
- Updated dependencies [1ecae4f]
  - @znight/core@0.2.1

## 0.2.0

### Patch Changes

- b6119e6: `NamedShape.literals` also lists the literals of an alias whose union holds `null` or `undefined` (`type Sort = 'title' | 'newest' | null` gives `['title', 'newest']`), so a nullable literal union keeps its source order.
- @znight/core@0.2.0

## 0.1.4

### Patch Changes

- c21ef01: Type shapes gain instance members (getters, visibility), enum members and literal order; extensions can declare lazy edges and emit extra files, which `znight generate --check` reports when stale.
- Updated dependencies [c21ef01]
  - @znight/core@0.1.4

## 0.1.3

### Patch Changes

- 39f7f5f: Faster validated routes: the generated `invoke` of a route validating arguments with schemas stays synchronous while the schemas validate synchronously (no promise and no `await` per request), and falls back to awaiting them, in parameter order, for asynchronous schemas. `coerce.number`, `coerce.integer` and `coerce.boolean` read plain values without a regular expression, `validate` reads `~standard` once, `isThenable` is exported for the generated code, and code generators get the `block` builder.
- Updated dependencies [39f7f5f]
  - @znight/core@0.1.3

## 0.1.2

### Patch Changes

- @znight/core@0.1.2

## 0.1.1

### Patch Changes

- dc8ac11: Depend on `oxc-parser` 0.156 (`^0.156.0`): the 0.1.0 range (`^0.155.0`) kept applications on 0.155.x.
- @znight/core@0.1.1

## 0.1.0

### Initial release

- First public release of `@znight/compiler`. Znight compiler: Vite plugin that analyzes your code and generates the DI container at build time.
