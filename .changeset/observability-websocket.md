---
"@znight/observability": patch
---

WebSocket instrumentation (RFC 0003 §8.10): a `SERVER` span per inbound message (a new trace linked to the handshake span), `websocket_*` connection and message metrics, and logs of closed connections and failed messages, switchable with `tracing.websocket`, `metrics.websocket` and `logging.websocket`.
