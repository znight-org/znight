# RFC 0012: Google Cloud Pub/Sub driver (`@znight/messaging/pubsub`)

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Accepted (2026-11-10, requested by the maintainer)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Date     | 2026-11-10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Affects  | `@znight/messaging`: a new subpath export `/pubsub` (optional peer `@google-cloud/pubsub` ^6). No change to the driver contract, the runtime, the compiler extension or the error catalogue. Specification §9.2 (driver table), package README, docs                                                                                                                                                                                                                                                                                                                                                      |
| Decision | **A Pub/Sub driver built on unary Pull, where `@Consumer(queue)` names a subscription and `publish(queue)` a topic (same name by default, both remappable).** Retries are ack deadlines (`modifyAckDeadline`, at most 600 s); attempts come from `deliveryAttempt`. Who retries and dead-letters is a driver option: Znight (default, `@Retry` and a Znight dead-letter topic) or the subscription (`retries: 'subscription'`: every failure is a nack, the subscription's retry and dead-letter policies apply, nothing is stacked). No delayed publishing, no topology created unless `provision: true` |

## 1. Summary

`@znight/messaging` ships RabbitMQ, SQS, Kafka and in-memory drivers. Applications on Google Cloud
use Pub/Sub, and the `MessagingDriver` contract (§9.2 of the specification) is public: this RFC adds
a fourth broker driver at `@znight/messaging/pubsub`. It is short because the contract does not
change. What needs a decision is where Pub/Sub differs from a queue: topics and subscriptions are
separate resources, the broker can own retries and dead letters (subscription retry policy and
dead-letter policy), attempts are only counted with a dead-letter policy, and there is no delayed
delivery.

```ts
import { MessagingPlugin } from '@znight/messaging'
import { pubsub } from '@znight/messaging/pubsub'

MessagingPlugin.configure({
  driver: pubsub({
    projectId: 'acme-prod', // default: the client's project (GOOGLE_CLOUD_PROJECT, credentials...)
    subscriptions: { notifications: process.env['NOTIFICATIONS_SUBSCRIPTION'] ?? 'notifications' },
  }),
})
```

## 2. Names: topics and subscriptions

- `MessageBroker.publish(queue, ...)` publishes to the **topic** `topics(queue)`; `@Consumer(queue)`
  pulls the **subscription** `subscriptions(queue)`. Both default to the queue name itself, so a
  topic and a subscription with the same name (Pub/Sub keeps them in separate namespaces) behave like
  a queue: the conformance scenarios run unchanged.
- `topics` and `subscriptions` are a record or a function (`(queue) => name`). A name is a short id
  in the driver's project or a full resource name (`projects/<p>/topics/<t>`,
  `projects/<p>/subscriptions/<s>`), for cross-project resources.
- Fan-out (one topic, one subscription per consumer) needs no special support: publish to the topic,
  give each `@Consumer` its subscription name (or a logical name mapped through `subscriptions`, for
  names that change per environment).
- `InboundMessage.queue` and `x-znight-original-queue` carry the `@Consumer` queue (the logical
  name).
- The project is `projectId`, else the one the `PubSub` client resolves (`GOOGLE_CLOUD_PROJECT`,
  credentials, metadata server, `PUBSUB_PROJECT_ID` with the emulator).

## 3. Receiving: unary Pull, flow control and leases

The driver uses the generated `v1.SubscriberClient` (unary `Pull`, `Acknowledge`,
`ModifyAckDeadline`) rather than the high-level `Subscription` (StreamingPull):

- the high-level `nack()` has no delay, and its lease manager keeps extending a message after a
  `modAck(n)`, so a delayed redelivery is not possible without private APIs;
- on close, the high-level subscriber nacks or waits for every message it holds, whereas the Znight
  runtime still owns in-flight deliveries and settles them itself;
- unary Pull gives exact flow control: one outstanding `Pull` per subscription, for at most the free
  concurrency slots (`maxMessages`, ≤ 1000). The consumer `concurrency` is the number of leased
  messages, as with SQS.

StreamingPull has a higher ceiling at very high throughput; the consumer `concurrency` is the bound
that matters for a Znight consumer, and a consumer can be scaled out with more replicas.

**Leases.** Received messages get the driver's `ackDeadlineSeconds` (default 60 s, 10–600) at once
(one `ModifyAckDeadline` per pulled batch), then every half of it while they are handled (one
request for all the leased messages of a subscription). Before a settlement that sets a deadline
(retry, release), the message leaves the lease and the extension in flight is awaited, so that it
never overrides the settlement (the SQS rule).

**Ordering keys.** `publish(..., { key })` sets the `orderingKey`, and `InboundMessage.key` reads
it. When the subscription enables message ordering (or its configuration could not be read), the
messages of one key are handled one after the other, in delivery order; other keys and messages
without a key run concurrently. Google recommends regional endpoints for ordered publishing
(`clientConfig.apiEndpoint`).

## 4. Settlements and attempts

| Settlement                            | Pub/Sub call                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `ack()`                               | `Acknowledge`                                                                         |
| `release()` (stop, failed settlement) | `ModifyAckDeadline(0)` (an immediate nack)                                            |
| `retry({ delayMs })`                  | `ModifyAckDeadline(ceil(delayMs / 1000))`, at most 600 s: Pub/Sub redelivers after it |
| `deadLetter({ queue })`               | publish a copy to the dead-letter topic, then `Acknowledge` (§5)                      |

Capabilities: `nativeDelay` (≤ 600 000 ms), in-process budget 1 s (`maxInProcessDelayMs`; Pub/Sub
deadlines have a 1 s granularity), `deliveryCount: 'native'`, `maxPublishDelayMs: 0`.

**Attempts** come from `deliveryAttempt`, which Pub/Sub only sets on subscriptions with a
dead-letter policy (it counts nacks and expired deadlines, releases included, like SQS's
`ApproximateReceiveCount`). Without a dead-letter policy, the driver remembers the attempt of each
retry it requested (by message id, bounded, in memory): exact for a single replica, approximate
across replicas and restarts. A warning at subscribe time recommends a dead-letter policy when a
consumer retries (`maxAttempts > 1`) and the subscription has none.

## 5. Who retries and dead-letters

Pub/Sub can own retries (subscription retry policy: exponential backoff between 0 and 600 s) and
dead letters (dead-letter policy: a topic, 5–100 delivery attempts). Znight retries in process and
publishes its own dead-letter copies. Stacking both multiplies attempts and splits dead letters
across two topics. The driver option `retries` picks one owner:

- **`'znight'` (default).** `@Retry` applies as with the other drivers (in-process delays, then ack
  deadlines). Dead letters go to the topic `<queue>-dlq` (`deadLetterName`), with the Znight
  attributes (`x-znight-dead-letter-reason`, `x-znight-error`...). When the subscription also has a
  dead-letter policy, the subscription must allow every attempt (`maxDeliveryAttempts` ≥ the
  consumer's `maxAttempts`, otherwise the boot fails with ZNIGHT011, like SQS's `maxReceiveCount`)
  and the default destination becomes the policy's topic. `deadLetter: false` nacks the message
  (the subscription's policy applies), or acknowledges it (dropped, as SQS does) when the
  subscription is known to have no dead-letter policy.
- **`'subscription'` (recommended when the subscription is configured in GCP).** Every retry is an
  immediate nack (`ModifyAckDeadline(0)`): the subscription's retry policy sets the backoff, the
  `@Retry` delays are ignored (no in-process wait). Every dead-letter request is a nack too: no
  Znight copy, the subscription forwards the message to its dead-letter topic after
  `maxDeliveryAttempts`. The subscription must have a dead-letter policy (ZNIGHT011 otherwise, when
  its configuration is readable). Set the `@Retry` attempts (or `defaults.retry.attempts`) to
  `maxDeliveryAttempts`, so that the handler runs on every delivery: deliveries beyond the consumer's
  attempts are nacked without running it (a warning at subscribe time when the two differ). A
  `NonRetryableError`, a validation failure or a message without handler is nacked like any failure:
  it is redelivered until the dead-letter policy forwards it.

## 6. Messages: body, attributes, trace context

- The body is the message `data` (bytes, no base64). `x-znight-id`, `x-znight-type` and
  `content-type` are attributes, like with SQS; `InboundMessage.id` falls back to the Pub/Sub
  `messageId` for messages published without Znight, and `timestamp` is the `publishTime`.
- Headers are attributes, both ways. Pub/Sub limits (100 attributes, keys ≤ 256 bytes, values ≤ 1024
  bytes, no `goog` prefix) are checked before publishing, with an explicit error. `x-znight-error`
  is truncated to fit an attribute.
- Trace context (`traceparent`, `tracestate`, written by `@znight/observability` on publish) travels
  as attributes. A message published by the Google client library with OpenTelemetry enabled
  carries `googclient_traceparent`: it is exposed as `traceparent` when the message has none.
- Pub/Sub dead-letter forwarding adds `CloudPubSubDeadLetterSource*` attributes; they reach the
  handlers of the dead-letter topic as headers.

## 7. Delayed publishing: not supported

Pub/Sub has no delayed delivery. A publication with `delay` fails (`maxPublishDelayMs: 0`), as with
Kafka. Emulating it on the consumer side (an `x-znight-not-before` attribute, then
`ModifyAckDeadline` until it is due) was rejected: each hop is a delivery attempt (a dead-letter
policy would forward a long-delayed message), hops are capped at 600 s, every subscription of the
topic pays for it, and the attempt numbers become wrong. Cloud Tasks or Cloud Scheduler are the
Google Cloud tools for delayed work.

## 8. Topology and verification

- Nothing is created by default. At subscribe time, the driver reads the subscription
  (`pubsub.subscriptions.get`): `NOT_FOUND` fails the boot (ZNIGHT011, with hints), and the
  dead-letter policy, ordering and deadline settings drive the checks above. The dead-letter topic
  of `'znight'` mode is checked too (`pubsub.topics.get`). `PERMISSION_DENIED` (a service account with
  `roles/pubsub.subscriber` only) logs a warning and skips the checks.
- `provision: true` (development, emulator) creates what is missing: the topic of the queue and its
  subscription, and the dead-letter topic with a subscription of the same name (a topic without
  subscription drops what is published to it). A publication to a missing topic creates it.

## 9. Emulator, shutdown, dependencies

- **Emulator.** `PUBSUB_EMULATOR_HOST` (or `clientConfig.apiEndpoint`) is honoured by the `PubSub`
  client the driver builds its RPC clients from (`getClientConfig()`); `PUBSUB_PROJECT_ID` gives the
  project. The integration tests run the conformance scenarios against the emulator image with
  Testcontainers (`ZNIGHT_INTEGRATION=1`).
- **Shutdown.** `cancel()` stops pulling: the outstanding `Pull` (unary calls cannot be cancelled)
  is abandoned, and the messages it may still return are released at once. In-flight deliveries keep
  their lease until the runtime settles them; `close()` waits for them, and the driver closes the
  clients it created (never those passed in). A long drain needs `shutdown.hookTimeoutMs` above it.
- **Dependencies.** Optional peer `@google-cloud/pubsub` ^6 (Node.js ≥ 22), imported only by the
  `/pubsub` entry. The driver uses `PubSub` (configuration, credentials, emulator) and the generated
  `v1.PublisherClient` / `v1.SubscriberClient`; existing clients can be passed in (`client`,
  `publisherClient`, `subscriberClient`). Publishing is one `Publish` call per message, resolved
  once Pub/Sub stored it.

## 10. Alternatives considered

- **High-level `Subscription` (StreamingPull).** Rejected for the reasons of §3; it remains possible
  later as an option if throughput requires it.
- **Retries by republication** (as Kafka and RabbitMQ do). A topic delivers to every subscription:
  a retry republished to the topic would reach every other consumer of it.
- **Always deferring to the subscription.** Pub/Sub's dead-letter policy needs IAM bindings for the
  service agent and has a 5-attempt minimum; Znight's own retries and dead-letter attributes stay the
  default, consistent with the other drivers.
- **Living in the application.** The driver contract is public, but Pub/Sub is a mainstream broker
  and its retry-ownership semantics deserve one tested implementation.

## 11. Out of scope

Exactly-once delivery specifics (acks are awaited, and a failed ack is logged by the runtime like
with every driver), push subscriptions, BigQuery and Cloud Storage subscriptions, schemas, and
filters (a subscription filter is configured in GCP and is transparent to the driver).
