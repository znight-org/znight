---
"@znight/http": patch
---

The WebSocket handshake timeout aborts `ctx.signal` with the message "The WebSocket handshake timed out" instead of the SSE `maxDuration` one; `RequestAbortedError` takes an optional message.
