# @znight/observability

## 0.1.4

### Patch Changes

- b6d42bc: `ObservabilityPlugin` registers only the hooks of the features its options enable: with HTTP logging, metrics and tracing off, no `http:request` wrapper slows requests down.
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

- First public release of `@znight/observability`. Znight observability plugin: structured logging (Pino), Prometheus metrics and OpenTelemetry tracing.
