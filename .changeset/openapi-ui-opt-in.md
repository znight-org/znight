---
"@znight/openapi": minor
---

`OpenApiPlugin`'s `ui` option has no default anymore: without it, only the document is served, no API reference page (migration: set `ui: 'scalar'` to keep the API reference page).
