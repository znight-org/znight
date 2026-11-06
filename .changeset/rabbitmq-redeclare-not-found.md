---
"@znight/messaging": patch
---

RabbitMQ: a consumer whose queue is gone when it resubscribes (`404 NOT_FOUND`, e.g. a queue deleted while the driver was declaring it again after the broker cancelled the consumer) declares the queue again before the next attempt instead of retrying forever.
