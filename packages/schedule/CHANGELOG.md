# @znight/schedule

## 0.9.1

### Patch Changes

- Updated dependencies [5e828fc]
  - @znight/compiler@0.9.1
  - @znight/core@0.9.1

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

- bb1c8f1: Report failed runs (and lock store failures) on the `error:report` hook, with the job context; a run honouring the abort of a shutdown or a removal is not reported.
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

- 74b6b04: A run aborted by `onDispose` after a failed start releases its lock lease when it settles, instead of holding it until its ttl expires.
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
  - @znight/compiler@0.6.4
  - @znight/core@0.6.4

## 0.6.3

### Patch Changes

- 815c9d9: Fix audit findings: out-of-range epochs no longer hang `parseCron().next()`, linear duration error hints, a bounded zone year cache, early first lease extension after a slow acquire, runs aborted on dispose and while waiting for their lease, and queued manual runs kept on `pause()`.
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

### Patch Changes

- Updated dependencies [469d6bf]
  - @znight/core@0.5.0
  - @znight/compiler@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [3bb4597]
  - @znight/core@0.4.0
  - @znight/compiler@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [75f4b8c]
  - @znight/core@0.3.0
  - @znight/compiler@0.3.0

## 0.2.2

### Patch Changes

- @znight/compiler@0.2.2
  - @znight/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [1ecae4f]
  - @znight/compiler@0.2.1
  - @znight/core@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [b6119e6]
  - @znight/compiler@0.2.0
  - @znight/core@0.2.0

## 0.1.4

### Patch Changes

- Updated dependencies [c21ef01]
- Updated dependencies [c21ef01]
  - @znight/compiler@0.1.4
  - @znight/core@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [39f7f5f]
- Updated dependencies [39f7f5f]
  - @znight/core@0.1.3
  - @znight/compiler@0.1.3

## 0.1.2

### Patch Changes

- @znight/compiler@0.1.2
  - @znight/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [dc8ac11]
  - @znight/compiler@0.1.1
  - @znight/core@0.1.1

## 0.1.0

### Initial release

- First public release of `@znight/schedule`. Znight schedule: cron, interval and timeout jobs validated at build time, with distributed locks and graceful shutdown.
