---
"@znight/http": patch
"@znight/compiler": patch
---

Faster validated routes: the generated `invoke` of a route validating arguments with schemas stays synchronous while the schemas validate synchronously (no promise and no `await` per request), and falls back to awaiting them, in parameter order, for asynchronous schemas. `coerce.number`, `coerce.integer` and `coerce.boolean` read plain values without a regular expression, `validate` reads `~standard` once, `isThenable` is exported for the generated code, and code generators get the `block` builder.
