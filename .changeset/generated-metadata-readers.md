---
"@znight/openapi": patch
"@znight/testing": patch
---

`znight openapi` reads the `metadata` export of the generated module, and the `@znight/testing` messages and JSDoc name `{ metadata }` instead of `__ZNIGHT_METADATA__` (RFC 0015).
