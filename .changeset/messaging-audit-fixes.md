---
"@znight/messaging": patch
---

Harden the drivers: Kafka bounds and scopes `x-znight-not-before`, RabbitMQ copies drop `user-id`, publications time out (`publishTimeoutMs`) and a late reconnection is closed, SQS dead-letter copies are always sendable and close waits for queued FIFO messages, and wildcard `@OnMessage` patterns match in linear time.
