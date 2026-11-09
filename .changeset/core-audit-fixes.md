---
"@znight/core": patch
---

Bound the wait of `stop()` for a hanging start, report a re-entrant request-scoped or transient creation as ZNIGHT002, dispose an instance whose interceptors fail, and close a scope synchronously when nothing in it is disposable.
