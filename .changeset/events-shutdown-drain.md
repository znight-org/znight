---
"@znight/events": patch
---

Default `drainTimeoutMs` lowered to 4 000 ms (below the core `hookTimeoutMs`), detached listeners drained before provider disposal when the application never started, async `onError` awaited by `idle()` and the drain, and a late `onDispose` no longer disables a reused plugin instance.
