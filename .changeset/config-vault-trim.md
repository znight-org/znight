---
"@znight/config": patch
---

`vault()` trims the white space around an explicit `token` or `namespace` (a token read with `readFileSync` keeps its final newline) instead of rejecting it, as `fetch` did before.
