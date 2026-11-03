---
"@znight/observability": patch
---

Observe GraphQL operations (RFC 0005 O1): the plugin wraps the `graphql:operation` hook with a span per operation (`tracing.graphql`, `graphql.document` opt-in), `graphql_operations_total` and `graphql_operation_duration_seconds` with operation names capped at `maxOperationNames` (`metrics.graphql`), and opt-in operation logs (`logging.graphql`); no wrapper is registered when all three are off.
