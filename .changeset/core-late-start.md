---
"@znight/core": patch
---

Stop and dispose a plugin or provider whose `onStart` settles after `stop()` stopped waiting for it, instead of leaking what it opened.
