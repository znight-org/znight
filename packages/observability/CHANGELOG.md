# @znight/observability

## 0.7.3

### Patch Changes

- Updated dependencies [bb1c8f1]
  - @znight/core@0.7.3

## 0.7.2

### Patch Changes

- cf435ed: Pretty (development) logs print one line per entry: short messages for HTTP requests (`[GET] [/users/42] - [200] 3.3ms`), message deliveries, scheduled runs, GraphQL operations, WebSocket messages and events, a `[name]` prefix for named loggers, `pid`, `hostname`, `traceId` and `spanId` hidden; the JSON output is unchanged.
- @znight/core@0.7.2

## 0.7.1

### Patch Changes

- 3cbfd77: The `homepage` of every package points to its page of the documentation site.
- Updated dependencies [3cbfd77]
  - @znight/core@0.7.1

## 0.7.0

### Patch Changes

- @znight/core@0.7.0

## 0.6.6

### Patch Changes

- @znight/core@0.6.6

## 0.6.5

### Patch Changes

- @znight/core@0.6.5

## 0.6.4

### Patch Changes

- 74b6b04: Datadog transport: during `flush()` / `close()`, a batch that fails with an error status loses only itself; the rest of the buffer is dropped only when the intake is unreachable (network error, timeout).
- Updated dependencies [74b6b04]
  - @znight/core@0.6.4

## 0.6.3

### Patch Changes

- 345cd53: Bound GraphQL operation names and message types in metric labels, take span client addresses from the trustProxy-aware HTTP context, bound the Datadog flush when the intake is down, and harden Logger.flush()/close() and MetricsServer.listen().
- Updated dependencies [dede0c2]
  - @znight/core@0.6.3

## 0.6.2

### Patch Changes

- @znight/core@0.6.2

## 0.6.1

### Patch Changes

- @znight/core@0.6.1

## 0.6.0

### Patch Changes

- f6cbef6: WebSocket instrumentation (RFC 0003 §8.10): a `SERVER` span per inbound message (a new trace linked to the handshake span), `websocket_*` connection and message metrics, and logs of closed connections and failed messages, switchable with `tracing.websocket`, `metrics.websocket` and `logging.websocket`.
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
