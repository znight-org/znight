---
"@znight/http": patch
---

The fast lane of the request pipeline now serves requests with `http:request` listeners or wrappers instead of sending them through the general pipeline, with the same replies and the same hook events (applications with `@znight/observability` get it).
