---
"@znight/observability": patch
---

`ObservabilityPlugin` registers only the hooks of the features its options enable: with HTTP logging, metrics and tracing off, no `http:request` wrapper slows requests down.
