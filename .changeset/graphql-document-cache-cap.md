---
"@znight/graphql": patch
---

The document cache keeps query texts up to 128 KiB (1/64 of its 8 MiB budget) instead of 16 KiB, so large pretty-printed or fragment-heavy operations are cached again.
