---
"@znight/compiler": patch
---

Bun's own modules (`bun`, `bun:sqlite`...) are builtins like `node:*`: a type imported from them (`SQL` from `bun`) is a token (`bun#SQL`) instead of an unresolved type (ZNIGHT010), so a `@Provides` method can return it.
