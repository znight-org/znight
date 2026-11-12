# @znight/messaging

## 0.9.1

### Patch Changes

- Updated dependencies [5e828fc]
  - @znight/compiler@0.9.1
  - @znight/core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [394c247]
  - @znight/compiler@0.9.0
  - @znight/core@0.9.0

## 0.8.0

### Patch Changes

- babdc79: Azure Service Bus driver at `@znight/messaging/azure-service-bus` (optional peer `@azure/service-bus`, and `@azure/identity` for `DefaultAzureCredential`): queues, topic subscriptions and dead-letter sub-queues, peek-lock receives with lock renewal, retries owned by Znight (scheduled copies, native dead-letter sub-queue) or by the entity (`retries: 'entity'`, `maxDeliveryCount`), scheduled delayed publishing, entities verified with the administration client and created with `provision: true` (RFC 0014).
- 434b251: Public driver conformance kit: `describeDriverConformance()` from `@znight/messaging/testing` runs the scenarios every first-party driver passes against a third-party driver, with the `describe`/`it` of any test framework; `deadLetterHeaders()` is exported from the root, and the README documents how to write, test and publish your own driver (RFC 0014).
- cc6e4f0: NATS JetStream driver (`@znight/messaging/nats`, RFC 0014): durable pull consumers with confirmed acks, native attempts, `nak(delay)` retries, deduplicated dead letters, ack-wait extension, `max_deliver` advisories and optional stream provisioning.
- 5557128: Redis Streams driver at `@znight/messaging/redis` (Redis 7.0+ or Valkey, ioredis 5.4+ or 6 as an optional peer): a stream per queue read through consumer groups, retries and releases as an atomic copy plus `XACK` to a retry stream per group (fan-outs never see another group's retries), dead letters to a dead-letter stream, delayed retries and delayed publishing through sorted sets, crashed consumers' entries claimed back with `XAUTOCLAIM`, a housekeeping pass that trims what every group acknowledged and removes the consumers of crashed processes, `MAXLEN ~` and `WAIT` for replicas (RFC 0014).
- b04d06c: NATS JetStream driver: `InboundMessage.timestamp` keeps the exact millisecond of a JetStream timestamp (a nanosecond count beyond 2^53 used to lose one).
- @znight/compiler@0.8.0
  - @znight/core@0.8.0

## 0.7.3

### Patch Changes

- bb1c8f1: Report dead-lettered and rejected deliveries on the `error:report` hook, with the message context.
- 2aa77d7: New Google Cloud Pub/Sub driver, `@znight/messaging/pubsub` (optional peer `@google-cloud/pubsub` ^6, RFC 0012): `publish(queue)` targets a topic and `@Consumer(queue)` a subscription (mappable), unary Pull bounded by the consumer concurrency with ack deadline leases, retries as ack deadlines (≤ 600 s), attempts from `deliveryAttempt`, ordering keys, attributes as headers, and `retries: 'znight' | 'subscription'` to choose whether Znight or the subscription's retry and dead-letter policies own failures. Drivers can report `Subscription.nativeDeadLetter` when the broker dead-letters by its own policy.
- Updated dependencies [bb1c8f1]
  - @znight/core@0.7.3
  - @znight/compiler@0.7.3

## 0.7.2

### Patch Changes

- @znight/compiler@0.7.2
  - @znight/core@0.7.2

## 0.7.1

### Patch Changes

- 3cbfd77: The `homepage` of every package points to its page of the documentation site.
- Updated dependencies [3cbfd77]
  - @znight/compiler@0.7.1
  - @znight/core@0.7.1

## 0.7.0

### Patch Changes

- @znight/compiler@0.7.0
  - @znight/core@0.7.0

## 0.6.6

### Patch Changes

- Updated dependencies [d85b11b]
  - @znight/compiler@0.6.6
  - @znight/core@0.6.6

## 0.6.5

### Patch Changes

- @znight/compiler@0.6.5
  - @znight/core@0.6.5

## 0.6.4

### Patch Changes

- 74b6b04: Kafka: the `maxRetryDelayMs` cap of a retry record runs from when it was fetched, so records queued behind far-future ones no longer wait `maxRetryDelayMs` each.
- 74b6b04: RabbitMQ: retried and dead-lettered copies keep the `user-id` property when it is the user of the connection, and drop it otherwise.
- 74b6b04: SQS: the degraded dead-letter copy (without `x-znight-error` and the headers) is sent only when SQS refuses the copy as invalid; throttling, KMS and permission failures release the message for a full copy later.
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
  - @znight/compiler@0.6.4
  - @znight/core@0.6.4

## 0.6.3

### Patch Changes

- 7c44484: Harden the drivers: Kafka bounds and scopes `x-znight-not-before`, RabbitMQ copies drop `user-id`, publications time out (`publishTimeoutMs`) and a late reconnection is closed, SQS dead-letter copies are always sendable and close waits for queued FIFO messages, and wildcard `@OnMessage` patterns match in linear time.
- Updated dependencies [0eeac37]
- Updated dependencies [dede0c2]
  - @znight/compiler@0.6.3
  - @znight/core@0.6.3

## 0.6.2

### Patch Changes

- @znight/compiler@0.6.2
  - @znight/core@0.6.2

## 0.6.1

### Patch Changes

- @znight/compiler@0.6.1
  - @znight/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [f6cbef6]
  - @znight/core@0.6.0
  - @znight/compiler@0.6.0

## 0.5.1

### Patch Changes

- 61bc2c8: RabbitMQ: a consumer whose queue is gone when it resubscribes (`404 NOT_FOUND`, e.g. a queue deleted while the driver was declaring it again after the broker cancelled the consumer) declares the queue again before the next attempt instead of retrying forever.
- @znight/compiler@0.5.1
  - @znight/core@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [469d6bf]
  - @znight/core@0.5.0
  - @znight/compiler@0.5.0

## 0.4.0

### Minor Changes

- 3bb4597: Custom parameter decorators (RFC 0010): `createParamDecorator<T, D>({ http, graphql, messaging })` defines a `@CurrentUser()` of your own, checked at build time (target, transport, data argument, value type) and called directly by the generated `invoke` of routes, GraphQL fields and message handlers; resolvers are functions or `ParamResolver` providers in any scope. The compiler adds `AnalyzeContext.paramDecorator` and `TypeHelpers.assignable` to the extension API; `TestApp` instantiates parameter resolvers with the controllers, resolvers and consumers.

### Patch Changes

- Updated dependencies [3bb4597]
  - @znight/core@0.4.0
  - @znight/compiler@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [75f4b8c]
  - @znight/core@0.3.0
  - @znight/compiler@0.3.0

## 0.2.2

### Patch Changes

- @znight/compiler@0.2.2
  - @znight/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [1ecae4f]
  - @znight/compiler@0.2.1
  - @znight/core@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [b6119e6]
  - @znight/compiler@0.2.0
  - @znight/core@0.2.0

## 0.1.4

### Patch Changes

- 1fb7b0e: Update development dependencies: @biomejs/biome, tsdown, @aws-sdk/client-secrets-manager, @aws-sdk/client-sqs and @cfworker/json-schema.
- Updated dependencies [c21ef01]
- Updated dependencies [c21ef01]
  - @znight/compiler@0.1.4
  - @znight/core@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [39f7f5f]
- Updated dependencies [39f7f5f]
  - @znight/core@0.1.3
  - @znight/compiler@0.1.3

## 0.1.2

### Patch Changes

- @znight/compiler@0.1.2
  - @znight/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [dc8ac11]
  - @znight/compiler@0.1.1
  - @znight/core@0.1.1

## 0.1.0

### Initial release

- First public release of `@znight/messaging`. Znight messaging plugin: consumers, retries and dead-letter queues with RabbitMQ, SQS or Kafka.
