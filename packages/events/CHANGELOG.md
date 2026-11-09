# @znight/events

## 0.6.3

### Patch Changes

- a5d31c5: Default `drainTimeoutMs` lowered to 4 000 ms (below the core `hookTimeoutMs`), detached listeners drained before provider disposal when the application never started, async `onError` awaited by `idle()` and the drain, and a late `onDispose` no longer disables a reused plugin instance.
- Updated dependencies [0eeac37]
- Updated dependencies [dede0c2]
  - @znight/compiler@0.6.3
  - @znight/core@0.6.3

## 0.6.2

### Patch Changes

- @znight/compiler@0.6.2
  - @znight/core@0.6.2

## 0.6.1

### Patch Changes

- @znight/compiler@0.6.1
  - @znight/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [f6cbef6]
  - @znight/core@0.6.0
  - @znight/compiler@0.6.0

## 0.5.1

### Patch Changes

- @znight/compiler@0.5.1
  - @znight/core@0.5.1

## 0.5.0

### Minor Changes

- 469d6bf: New `@znight/events` package (RFC 0011): in-process application events, `@OnEvent` listeners found and checked at build time, `EventPublisher` with inline and detached dispatch, `recordEvents()` for tests; core gains the `events:publish` and `events:listener` hooks and ZNIGHT070.

### Patch Changes

- Updated dependencies [469d6bf]
  - @znight/core@0.5.0
  - @znight/compiler@0.5.0
