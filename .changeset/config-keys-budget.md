---
"@znight/config": patch
---

`ConfigSource.keys()` (and `toJSON()`) visit at most 10 000 entries per layer, so values whose shared sub-objects make the paths grow exponentially no longer hang the process.
