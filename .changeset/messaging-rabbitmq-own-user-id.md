---
"@znight/messaging": patch
---

RabbitMQ: retried and dead-lettered copies keep the `user-id` property when it is the user of the connection, and drop it otherwise.
