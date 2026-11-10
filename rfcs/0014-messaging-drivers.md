# RFC 0014: Messaging drivers (public contract, conformance kit, new brokers)

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Accepted (2026-11-10, requested by the maintainer)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Date     | 2026-11-10                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Affects  | `@znight/messaging`: the `MessagingDriver` contract becomes a documented public API for third-party drivers, a new subpath export `/testing` (`describeDriverConformance()`), `deadLetterHeaders()` exported from the root. Planned subpaths `/azure-service-bus`, `/nats` and `/redis`. No change to the runtime, the compiler extension or the error catalogue. Specification §9.2, package README, docs, roadmap                                                    |
| Decision | **Anyone can write a messaging driver: the contract of §9.2 is public and stable, and the scenarios every first-party driver passes are exported as a framework-neutral conformance kit.** Three first-party drivers are planned on that contract: Azure Service Bus, NATS JetStream and Redis Streams. Oracle Cloud Infrastructure Streaming is covered by the Kafka driver (Kafka-compatible endpoint); OCI Queue is not planned (a third-party driver can cover it) |

## 1. Summary

`@znight/messaging` ships memory, RabbitMQ, SQS, Kafka and Pub/Sub drivers behind subpath exports.
The `MessagingDriver` contract (§9.2 of the specification) has been exported from the root since the
first release, but nothing told a third party what a driver owes the runtime, and the scenarios that
check it lived in the package's integration tests (`test/integration/conformance.ts`), out of reach.

This RFC:

1. declares the driver contract public, with the guarantees on both sides (§2);
2. exports the conformance scenarios as `describeDriverConformance()` from
   `@znight/messaging/testing`, runnable with `bun:test`, Vitest, Jest or `node:test`, like
   `@znight/graphql/testing` does for GraphQL drivers (§3); every first-party driver runs them;
3. plans three first-party drivers on that contract: Azure Service Bus, NATS JetStream and Redis
   Streams (§4), and records why Oracle is covered differently (§5).

## 2. The public driver contract

A driver is an object implementing `MessagingDriver` (`name`, `capabilities`, `connect`,
`subscribe`, `publish`, `close`, `deadLetterName`); the types are exported from `@znight/messaging`.
No compiler extension and no manifest are involved: drivers are runtime-only, so a third-party driver
is a plain package exporting a factory.

**What the runtime guarantees to the driver.**

- `connect(context)` is called once in `onBootstrap`, before any `subscribe` / `publish`, with a
  `logger` for background failures. `close()` is called once in `onDispose`, after every
  subscription was cancelled and closed.
- Retry policies are validated against `capabilities` at boot (ZNIGHT011): the runtime never asks a
  driver for a native delay above `maxNativeDelayMs`, never holds a delivery in-process longer than
  `maxInProcessDelayMs`, and refuses `publish(..., { delay })` above `maxPublishDelayMs`.
- Each `DriverDelivery` gets exactly one settlement (`ack`, `retry`, `deadLetter` or `release`),
  possibly followed by `release()` when that settlement failed. The handler promise settles once the
  delivery is settled.
- Dead-letter requests carry the destination (`undefined` when dead-lettering is disabled or the
  subscription reported `nativeDeadLetter`), the reason, the error and the attempts made.
- On stop, the runtime calls `subscription.cancel()`, releases the deliveries waiting for an
  in-process retry, waits for the handlers in flight, then calls `subscription.close()`.

**What the driver guarantees to the runtime.**

- **Confirmation.** `publish` resolves once the broker confirmed the message. A settlement resolves
  once the broker acknowledged it; `retry` and `deadLetter` make the copy durable before settling
  the original (at-least-once, never at-most-once). `release` never loses a message.
- **Back-pressure.** Never more than `options.concurrency` pending handler promises per
  subscription.
- **Attempts.** `DriverDelivery.attempt` is 1-based: the broker's delivery count
  (`deliveryCount: 'native'`) or the `x-znight-attempt` header of the republished copy
  (`deliveryCount: 'header'`, read with `attemptFromHeaders()`), or both combined.
- **Headers.** Every header is carried verbatim, both ways, as strings: Znight's (`x-znight-*`), the
  application's, and the trace context written by `@znight/observability` in the
  `messaging:publish` hook (`traceparent`, `tracestate`, whatever the configured propagator writes). A broker that renames headers
  maps them back (Pub/Sub exposes `googclient_traceparent` as `traceparent`). `id`, `type`, `key`,
  `contentType` and `timestamp` survive the round trip, in properties or in `x-znight-*` headers.
- **Dead letters.** A dead-lettered copy keeps the body, the type and the headers, minus
  `x-znight-attempt`, plus the reason, the error, the original queue and the attempts: exactly what
  the exported `deadLetterHeaders(headers, request, queue)` builds.
- **Topology.** `subscribe` verifies the queue and its dead-letter destination (and their native
  policies) and fails early with a `ZnightError` (ZNIGHT011) when they are unusable; creating
  resources is opt-in (`provision`, `createTopics`), except where the broker declares them cheaply
  and idempotently (RabbitMQ, Redis consumer groups).
- **Shutdown.** `cancel()` stops receiving; `close()` waits for the deliveries in flight to settle,
  and gives back anything received but not handed to the runtime.

The contract is versioned with the package (pre-1.0: a breaking change is a minor release and a
changeset says so). New members are optional, as `Subscription.nativeDeadLetter` was.

## 3. The conformance kit

```ts
import { describeDriverConformance } from '@znight/messaging/testing'
import { describe, it } from 'bun:test'

describeDriverConformance({
  name: 'acme',
  driver: overrides => acme({ url: process.env['ACME_URL'], ...overrides }),
  test: { describe, it },
})
```

- **Framework-neutral.** The caller passes `describe` and `it` (`it(name, body, timeoutMs)` as in
  `bun:test`, Vitest and Jest); assertions are `node:assert`'s. Each scenario stops the applications
  it started, so no `afterEach` is needed.
- **Scenarios** (unchanged from the integration suite, now public): publish and consume with type
  routing, headers (trace context included), key and confirmations; retries in-process then native
  with increasing attempts (in-process only for a driver without native delay); dead letters after
  the last attempt, for a non-retryable error and for a validation failure, with the dead-letter
  headers; concurrency bounded by the consumer's; pending in-process retries given back on stop and
  redelivered to the next application; delayed publishing honoured, or refused when
  `maxPublishDelayMs` is `0`.
- **Options**: `name`, `driver(overrides)` (a new driver for each application, reaching the same
  broker; `overrides.maxInProcessDelayMs` lets the retry scenario force native retries),
  `prepareQueue(queue, deadLetterQueue)` (for drivers that never create resources),
  `consumerOptions(queue)` (driver options of `@Consumer`, e.g. a Kafka group), `nativeDelayMs`
  (shortest native delay the broker honours precisely: whole seconds for SQS and Pub/Sub) and
  `timeoutMs`.
- The first-party drivers run it: the memory driver in the regular test run, the brokers under
  `ZNIGHT_INTEGRATION=1` (Testcontainers). The kit adds no dependency: it builds its application from
  hand-written metadata with `@znight/core`.

## 4. Planned first-party drivers

Each is a subpath export with its client as an optional peer dependency, loaded lazily, tested by the
conformance kit against Testcontainers (an emulator when no server image exists), and documented in
the driver table of §9.2. Like Pub/Sub (RFC 0012), when the broker can own redelivery and dead
letters, a driver option chooses **who retries**, never both layers at once: `'znight'` (default:
`@Retry`, Znight dead letters) or the broker's policy.

### 4.1 Azure Service Bus (`/azure-service-bus`, peer `@azure/service-bus` ^7)

- **Names.** `publish(queue)` sends to a queue or a topic (one namespace); `@Consumer(queue)`
  receives from a queue, or from a topic subscription (`subscriptions: { orders: 'orders/billing' }`
  or a function). Connection string, or `fullyQualifiedNamespace` + a `TokenCredential`
  (`@azure/identity`, left to the application), or a `ServiceBusClient`.
- **Settlement.** Peek-lock receivers: `ack` completes, `release` abandons, the lock is renewed while
  a delivery is in flight (`maxAutoLockRenewalDurationInMs`), `concurrency` bounds the messages
  received.
- **Retries.** `retries: 'znight'` (default): a delayed retry schedules a copy
  (`scheduleMessages`, with `x-znight-attempt`) then completes the original (the JS SDK has no
  transactions: a crash in between duplicates, never loses); attempts combine `x-znight-attempt` and
  `deliveryCount`. In-process budget 1 s. `retries: 'entity'`: every failure abandons, the entity's
  `maxDeliveryCount` and dead-letter sub-queue own redelivery (`nativeDeadLetter`), and the runtime
  warns when `maxDeliveryCount` differs from the consumer's attempts.
- **Dead letters.** Default destination: the entity's native sub-queue
  (`<queue>/$deadletterqueue`), reached with `deadLetterMessage()` and the Znight headers as
  application properties; another name is a send-then-complete. `@Consumer('<q>/$deadletterqueue')`
  reads a dead-letter sub-queue.
- **Delays and ordering.** Delayed publishing through `scheduledEnqueueTimeUtc` (no practical
  limit). `key` becomes the `sessionId` on session-enabled entities; session receivers (ordered
  processing) are a second milestone, the first refuses session-enabled entities (ZNIGHT011).
- **Provisioning and tests.** Entities verified with the administration client (`maxDeliveryCount`
  ≥ attempts under `'znight'`), created with `provision: true`. Tests use the Service Bus emulator
  (entities declared in its configuration file, since it has no administration API).

### 4.2 NATS JetStream (`/nats`, peers `@nats-io/jetstream` ^3 and `@nats-io/transport-node` ^3)

- **Names.** `publish(queue)` publishes to the subject `queue` (a stream must capture it);
  `@Consumer(queue)` reads a durable pull consumer (`<durablePrefix>-<queue>`, filter subject
  `queue`) on the stream capturing it, with explicit acks and `maxAckPending = concurrency`.
- **Settlement and retries.** `ack` is a double ack (`ackAck()`, confirmed by the server), `release`
  is `nak()`. JetStream redelivers with a delay natively (`nak(delayMs)`) and counts deliveries
  (`info.deliveryCount`): attempts are native, no copy is republished. `msg.working()` extends the ack
  wait while a delivery is in flight. In-process budget 1 s.
- **Dead letters.** JetStream has no dead-letter queue (only advisories after `maxDeliver`): Znight
  publishes the copy to the subject `<queue>.dlq` (confirmed by the stream), then terminates the
  original (`term()`). A broker-owned mode is therefore not offered: the consumer's `maxDeliver` must
  be unlimited or at least the attempts (checked at subscribe time).
- **Delays and ordering.** No delayed publishing in the first version (`maxPublishDelayMs: 0`).
  Order is kept per subject with `concurrency: 1`.
- **Provisioning and tests.** Streams verified (`provision: true` creates them); durable consumers are
  created or updated by the driver, like Kafka consumer groups. Tests run `nats` with `-js` in
  Testcontainers.

### 4.3 Redis Streams (`/redis`, peer `redis` ^5)

- **Names.** `publish(queue)` is an `XADD` to the stream `<prefix><queue>` (body, type, id, content
  type and headers as fields; optional `MAXLEN ~`); `@Consumer(queue)` reads through a consumer group
  (`XREADGROUP`, `COUNT` = free slots), created idempotently with `MKSTREAM`. Valkey works the same.
- **Settlement.** `ack` is `XACK`. Messages received but never settled stay in the pending entries
  list and are claimed back (`XAUTOCLAIM` after `claimIdleMs`) by any member, including a restarted
  one: that is `release`, and the shutdown path.
- **Retries.** Redis has no redelivery policy, so retries are Znight's only: a copy with
  `x-znight-attempt` is added and the original acknowledged in one `MULTI`. Delays go through a sorted
  set per stream (`<stream>:delayed`, score = due time) moved back into the stream by an atomic script
  polled by the driver; the same set serves delayed publishing. In-process budget 1 s.
- **Dead letters.** The stream `<queue>.dlq`, written and acknowledged in one `MULTI`.
- **Durability and ordering.** A confirmation means Redis executed the command; durability follows
  the server's persistence (AOF), and an option waits for replicas (`WAIT`). No ordering across
  members of a group.
- **Tests.** The `redis` image in Testcontainers.

## 5. Oracle Cloud Infrastructure and other brokers

- **OCI Streaming** exposes a Kafka-compatible endpoint: the Kafka driver works with it
  (`bootstrapBrokers: ['cell-1.streaming.<region>.oci.oraclecloud.com:9092']`, SASL `PLAIN` over TLS
  with the user `<tenancy>/<user>/<stream pool OCID>` and an auth token). The retry topic
  (`<group>.retry`) and dead-letter topics (`<topic>.dlq`) are streams of the same pool: create them
  beforehand, or let `createTopics` create them where the pool allows it. Nothing to build; the
  driver docs say so. Azure Event Hubs, also Kafka-compatible, is in the same situation.
- **OCI Queue** is not planned: a separate HTTP API with its own SDK, no emulator to test against, and
  no demand so far. Its model (visibility timeout, delivery count, dead-letter queue) maps to the
  contract like SQS, so a third-party driver validated by the conformance kit can cover it.

## 6. Plan

- **M1 (this change).** The contract documented as public (specification §9.2, "Writing your own
  driver" in the README and the docs), `describeDriverConformance()` at `@znight/messaging/testing`,
  `deadLetterHeaders()` exported, the first-party drivers on the kit, the OCI Streaming note.
- **M2.** Redis Streams, then NATS JetStream, then Azure Service Bus (sessions in a later milestone),
  each in its own change with the kit, Testcontainers tests, its row in §9.2 and its README section.
