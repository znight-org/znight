# @znight/observability

## 0.4.0

### Patch Changes

- Updated dependencies [3bb4597]
  - @znight/core@0.4.0

## 0.3.0

### Patch Changes

- 75f4b8c: GraphQL operation spans carry `znight.graphql.driver` when a GraphQL driver other than the built-in transport received the operation (RFC 0009).
- Updated dependencies [75f4b8c]
  - @znight/core@0.3.0

## 0.2.2

### Patch Changes

- 90cf396: Add `getLogger(name)`, a static logger for code outside dependency injection (or migrating NestJS `new Logger(X.name)`), routed to the running application's logger, buffered before it exists, and `setFallbackLogger()` to silence or capture it in tests without an application.
- @znight/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [1ecae4f]
  - @znight/core@0.2.1

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
