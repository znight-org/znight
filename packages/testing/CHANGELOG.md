# @znight/testing

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

- Updated dependencies [1ecae4f]
  - @znight/core@0.2.1

## 0.2.0

### Patch Changes

- @znight/core@0.2.0

## 0.1.4

### Patch Changes

- c21ef01: `TestApp` boots GraphQL resolvers, their guards and loaders by default.
- Updated dependencies [c21ef01]
  - @znight/core@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [39f7f5f]
  - @znight/core@0.1.3

## 0.1.2

### Patch Changes

- @znight/core@0.1.2

## 0.1.1

### Patch Changes

- @znight/core@0.1.1

## 0.1.0

### Initial release

- First public release of `@znight/testing`. Znight testing utilities: TestBed with auto-mocking and TestApp for end-to-end tests.
