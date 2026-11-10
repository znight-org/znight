---
"@znight/http": patch
---

A client leaving during a WebSocket handshake now aborts `ctx.signal` (`kind: 'client'`) and the handshake is not completed (`PendingUpgrade.disconnected`); the accepted connection closing later never aborts it. `upgradeInMemory()` takes a `signal`, and `AdapterRequest.onAbort` may return a function removing its listener.
