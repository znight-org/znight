---
"@znight/observability": patch
---

Datadog transport: during `flush()` / `close()`, a batch that fails with an error status loses only itself; the rest of the buffer is dropped only when the intake is unreachable (network error, timeout).
