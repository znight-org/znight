# @znight/observability

## 0.2.0

### Patch Changes

- 5306d9f: Observe GraphQL operations (RFC 0005 O1): the plugin wraps the `graphql:operation` hook with a span per operation (`tracing.graphql`, `graphql.document` opt-in), `graphql_operations_total` and `graphql_operation_duration_seconds` with operation names capped at `maxOperationNames` (`metrics.graphql`), and opt-in operation logs (`logging.graphql`); no wrapper is registered when all three are off.
- @znight/core@0.2.0

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
