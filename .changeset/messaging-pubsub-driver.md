---
"@znight/messaging": patch
---

New Google Cloud Pub/Sub driver, `@znight/messaging/pubsub` (optional peer `@google-cloud/pubsub` ^6, RFC 0012): `publish(queue)` targets a topic and `@Consumer(queue)` a subscription (mappable), unary Pull bounded by the consumer concurrency with ack deadline leases, retries as ack deadlines (≤ 600 s), attempts from `deliveryAttempt`, ordering keys, attributes as headers, and `retries: 'znight' | 'subscription'` to choose whether Znight or the subscription's retry and dead-letter policies own failures.
