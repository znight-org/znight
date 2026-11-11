# @znight/events

## 0.9.0

### Patch Changes

- Updated dependencies [394c247]
  - @znight/compiler@0.9.0
  - @znight/core@0.9.0

## 0.8.0

### Patch Changes

- @znight/compiler@0.8.0
  - @znight/core@0.8.0

## 0.7.3

### Patch Changes

- bb1c8f1: Report the errors of detached listeners and of `emit()` on the `error:report` hook.
- Updated dependencies [bb1c8f1]
  - @znight/core@0.7.3
  - @znight/compiler@0.7.3

## 0.7.2

### Patch Changes

- @znight/compiler@0.7.2
  - @znight/core@0.7.2

## 0.7.1

### Patch Changes

- 3cbfd77: The `homepage` of every package points to its page of the documentation site.
- Updated dependencies [3cbfd77]
  - @znight/compiler@0.7.1
  - @znight/core@0.7.1

## 0.7.0

### Patch Changes

- @znight/compiler@0.7.0
  - @znight/core@0.7.0

## 0.6.6

### Patch Changes

- Updated dependencies [d85b11b]
  - @znight/compiler@0.6.6
  - @znight/core@0.6.6

## 0.6.5

### Patch Changes

- @znight/compiler@0.6.5
  - @znight/core@0.6.5

## 0.6.4

### Patch Changes

- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
  - @znight/compiler@0.6.4
  - @znight/core@0.6.4

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
