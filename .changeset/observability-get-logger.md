---
"@znight/observability": patch
---

Add `getLogger(name)`, a static logger for code outside dependency injection (or migrating NestJS `new Logger(X.name)`), routed to the running application's logger, buffered before it exists, and `setFallbackLogger()` to silence or capture it in tests without an application.
