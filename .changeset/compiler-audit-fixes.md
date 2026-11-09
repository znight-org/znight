---
"@znight/compiler": patch
---

Fix `export =` cycles that hung the compiler, stale or retained parses of files no compile reads, slow `export *` cycles, the Vite plugin losing its dev server listeners after a restart, and extension load failures cached for the whole session.
