# @znight/compiler

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
