---
"@znight/http": patch
---

A client leaving during a WebSocket handshake now aborts `ctx.signal` (`kind: 'client'`) and the handshake is not completed (`PendingUpgrade.disconnected`); the accepted connection closing later never aborts it. On `node:http` a client's FIN is detected even behind bytes it sent after its headers, and a guard failing with that abort (passing `ctx.signal` to `fetch()`) is answered `400` without an error log. `upgradeInMemory()` takes a `signal`, and `AdapterRequest.onAbort` may return a function removing its listener.
