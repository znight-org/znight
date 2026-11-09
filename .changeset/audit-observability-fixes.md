---
"@znight/observability": patch
---

Bound GraphQL operation names and message types in metric labels, take span client addresses from the trustProxy-aware HTTP context, bound the Datadog flush when the intake is down, and harden Logger.flush()/close() and MetricsServer.listen().
