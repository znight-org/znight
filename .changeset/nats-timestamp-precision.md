---
"@znight/messaging": patch
---

NATS JetStream driver: `InboundMessage.timestamp` keeps the exact millisecond of a JetStream timestamp (a nanosecond count beyond 2^53 used to lose one).
