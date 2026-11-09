---
"@znight/schedule": patch
---

A run aborted by `onDispose` after a failed start releases its lock lease when it settles, instead of holding it until its ttl expires.
