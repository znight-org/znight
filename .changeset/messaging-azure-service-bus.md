---
"@znight/messaging": patch
---

Azure Service Bus driver at `@znight/messaging/azure-service-bus` (optional peer `@azure/service-bus`, and `@azure/identity` for `DefaultAzureCredential`): queues, topic subscriptions and dead-letter sub-queues, peek-lock receives with lock renewal, retries owned by Znight (scheduled copies, native dead-letter sub-queue) or by the entity (`retries: 'entity'`, `maxDeliveryCount`), scheduled delayed publishing, entities verified with the administration client and created with `provision: true` (RFC 0014).
