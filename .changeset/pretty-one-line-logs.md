---
"@znight/observability": patch
---

Pretty (development) logs print one line per entry: short messages for HTTP requests (`[GET] [/users/42] - [200] 3.3ms`), message deliveries, scheduled runs, GraphQL operations, WebSocket messages and events, a `[name]` prefix for named loggers, `pid`, `hostname`, `traceId` and `spanId` hidden; the JSON output is unchanged.
