---
"@znight/core": patch
---

New `error:report` hook: one event per error the framework turns into a failure (5xx, failed delivery or run, detached listener, lifecycle failure), for Sentry-style reporters; core reports lifecycle failures.
