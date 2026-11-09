---
"@znight/http": patch
---

Report a route decorator already applied and stored in a `const` (`const AdminOnly = Roles(['admin'])`, used as `@AdminOnly`) as ZNIGHT005 instead of dropping its decision.
