---
"@znight/websocket": patch
---

Report unexpected failures of handlers, `@OnConnect` and `@OnDisconnect` on the `error:report` hook (the original error of a mapped failure); a `WsException` with code `INTERNAL`, thrown or returned by a mapper, is now logged and reported as an unexpected failure.
