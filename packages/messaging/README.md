# @znight/messaging

Message consumers and publishing for [Znight](../../README.md), checked at build time and run on
RabbitMQ, Amazon SQS, Kafka, Google Cloud Pub/Sub, Azure Service Bus or in memory.

Retries with backoff, dead-letter queues, per-consumer concurrency and graceful shutdown, the same
on **RabbitMQ**, **Amazon SQS**, **Kafka**, **Google Cloud Pub/Sub** and **Azure Service Bus**; the
in-memory broker serves
tests and local development.

Like the rest of Znight, consumers are discovered **at build time**: `@znight/compiler` (with the
`@znight/messaging/compiler` extension) reads the decorators and generates the consumer metadata. At
runtime `MessagingPlugin` only executes it.

```sh
# bun
bun add @znight/core @znight/messaging
bun add -d @znight/compiler vite
bun add amqplib              # optional: RabbitMQ driver
bun add @aws-sdk/client-sqs  # optional: SQS driver
bun add @platformatic/kafka  # optional: Kafka driver
bun add @google-cloud/pubsub # optional: Pub/Sub driver
bun add @azure/service-bus   # optional: Azure Service Bus driver (+ @azure/identity for Entra ID)

# npm
npm install @znight/core @znight/messaging
npm install -D @znight/compiler vite
npm install amqplib              # optional: RabbitMQ driver
npm install @aws-sdk/client-sqs  # optional: SQS driver
npm install @platformatic/kafka  # optional: Kafka driver
npm install @google-cloud/pubsub # optional: Pub/Sub driver
npm install @azure/service-bus   # optional: Azure Service Bus driver (+ @azure/identity for Entra ID)
```

Runs on Node.js >= 24 and Bun >= 1.3. Broker clients are optional peer dependencies: install only the
one you use (the in-memory driver needs none).

**Documentation:** [`@znight/messaging`](https://github.com/znight-org/znight/blob/main/docs/packages/messaging.md).
**Examples:** [`microservice`](https://github.com/znight-org/znight/tree/main/examples/microservice)
(publishing from an HTTP API, retries, dead letters, traces across HTTP and messaging),
[`worker`](https://github.com/znight-org/znight/tree/main/examples/worker) (a worker without HTTP
server), [`monorepo`](https://github.com/znight-org/znight/tree/main/examples/monorepo) (a consumer
service whose queue and message contracts come from a shared library package).

## Quick start

```ts
// src/orders/order.consumer.ts
import { Consumer, Message, NonRetryableError, OnError, OnMessage, Retry, type InboundMessage } from '@znight/messaging'
import { z } from 'zod'

export const OrderPlaced = z.object({ id: z.string(), total: z.number() })

@Consumer('orders')
export class OrderConsumer {
  constructor(private readonly billing: BillingService) {}

  @OnMessage('order.placed')
  @Retry({ attempts: 5, backoff: 'exponential', delay: 500, maxDelay: 30_000 })
  async placed(@Message(OrderPlaced) order: z.output<typeof OrderPlaced>) {
    if (order.total < 0) throw new NonRetryableError('Negative total') // dead-lettered right away
    await this.billing.charge(order) // throws → retried
  }

  @OnError()
  onError(error: unknown, message: InboundMessage) {
    if (message.type === 'order.legacy') return 'ack' // swallow instead of dead-lettering
  }
}
```

```ts
// src/orders/order.service.ts
import { Injectable } from '@znight/core'
import { MessageBroker } from '@znight/messaging'

@Injectable()
export class OrderService {
  constructor(private readonly broker: MessageBroker) {}

  async place(order: Order) {
    await this.broker.publish('orders', order, { type: 'order.placed', key: order.customerId })
  }
}
```

```ts
// src/main.ts
import { Application } from '@znight/core'
import { MessagingPlugin } from '@znight/messaging'
import { rabbitmq } from '@znight/messaging/rabbitmq'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [MessagingPlugin.configure({ driver: rabbitmq({ url: process.env.AMQP_URL! }) })],
})
await app.start() // consumers subscribe; SIGTERM drains them gracefully
```

## Decorators

Decorators are compile-time markers (no-ops at runtime). _Static_ arguments must be statically
evaluable (literals, `const` references); _value_ arguments (schemas) may reference exported bindings.

| Decorator                                                                                         | Target | Description                                                                                                              |
| ------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `@Consumer(queue)` / `@Consumer({ queue, scope?, concurrency?, deadLetter?, ...driver options })` | class  | A provider (singleton by default, `scope: 'request'` for one instance per message) consuming `queue` (a Kafka topic).    |
| `@OnMessage(type?)`                                                                               | method | Handles messages of `type` (exact, or a pattern where `*` matches anything: `'order.*'`). Without type: default handler. |
| `@Retry({ attempts, backoff?, delay?, maxDelay? })`                                               | method | Retry policy of the handler (see [Retries](#retries)).                                                                   |
| `@OnError()`                                                                                      | method | `(error, message) => void \| 'ack'`, called when a message will not be retried anymore.                                  |
| `@Message(schema?)`                                                                               | param  | The payload; validated with a [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType...) when given.       |
| `@Headers(name?)`                                                                                 | param  | All headers (`Record<string, string>`), or one header (`string \| undefined`, exact then case-insensitive match).        |
| `@Ctx()`                                                                                          | param  | The `InboundMessage`.                                                                                                    |

Handler selection: exact type, then patterns (declaration order), then the default handler. A
message no handler matches is dead-lettered with reason `no-handler` (or acknowledged by `@OnError`).
A queue is consumed by a single `@Consumer` class per application.

Handler parameters can also use a custom parameter decorator defined with `createParamDecorator`
(`@znight/core`, RFC 0010) when it has a `messaging` resolver, which receives the `InboundMessage`:

```ts
import { createParamDecorator } from '@znight/core'

export const Tenant = createParamDecorator<string>({
  messaging: message => message.headers['x-tenant'] ?? 'default',
})

// @OnMessage('order.placed') placed(@Message(Order) order: Order, @Tenant() tenant: string) { ... }
```

A resolver error fails the delivery like a handler error (retries, `@OnError`, dead letters).

## Delivery semantics

Delivery is **at-least-once**. A message can be handled more than once: redelivery after a crash, a
lost acknowledgement, a rebalance, a dead-letter queue outage... **Handlers must be idempotent** —
deduplicate on `message.id` (stable across redeliveries; `publish()` generates a UUID, or pass your
own `id`) or make the side effects idempotent.

Each delivery goes through this state machine:

```
receive ─► wait for a concurrency slot ─► request scope (InboundMessage) ─► hooks.run('messaging:message')
   └─► decode ─► select handler by type ─► invoke (validate → handler)
         ├─ success ───────────────────────────────────────────────► ack
         ├─ failure, attempts left ─► wait in-process (≤ driver budget) ─► redeliver as attempt + 1
         │                          └─ or native delayed redelivery (SQS visibility, RabbitMQ delay queue, Kafka retry topic, Pub/Sub ack deadline, Service Bus scheduled copy)
         └─ NonRetryableError / invalid payload / undecodable body / no handler / last attempt
              └─► @OnError ─ 'ack' ─► ack
                           └─ otherwise (or throws) ─► dead-letter: publish (confirmed) then ack
                                                       └─ publish failed ─► release (redelivered later)
```

- **Nothing is dropped**: every path ends with the broker owning the message (acknowledged,
  republished, dead-lettered or released). A settlement failure (connection loss) leaves the message
  unacknowledged, so the broker redelivers it.
- **Attempts** are counted by the broker (SQS `ApproximateReceiveCount`, RabbitMQ quorum
  `x-delivery-count`, Pub/Sub `deliveryAttempt`, Service Bus `deliveryCount`) and/or the `x-znight-attempt` header of republished retries
  (`message.attempt`, 1-based). A redelivery beyond the last attempt is dead-lettered without calling
  the handler.
- **Ordering** is not guaranteed across retries. Kafka keeps the order of a partition (records of a
  partition are handled one at a time); SQS FIFO keeps the order of a message group, Pub/Sub the order
  of an ordering key on ordered subscriptions.

| Outcome (`event.outcome`) | When                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `ack`                     | The handler succeeded, or `@OnError` returned `'ack'`.                                     |
| `retry`                   | A retryable failure with attempts left, or a failed dead-lettering (message released).     |
| `dead-letter`             | No more attempts: moved to the dead-letter queue (or rejected when dead-lettering is off). |

### Retries

`attempts` counts the first delivery: `{ attempts: 3 }` = 1 delivery + 2 retries.

| Option     | Default         | Description                                                        |
| ---------- | --------------- | ------------------------------------------------------------------ |
| `attempts` | —               | Total attempts (`1`: no retry).                                    |
| `backoff`  | `'exponential'` | `fixed`: always `delay`; `exponential`: `delay × 2^(attempt − 1)`. |
| `delay`    | `1000`          | Base delay in milliseconds.                                        |
| `maxDelay` | —               | Cap of exponential delays.                                         |

Handlers without `@Retry` use `defaults.retry` (3 attempts, exponential from 1 s, capped at 30 s).

A delay shorter than the driver's `maxInProcessDelayMs` is waited **in-process** (the message stays
locked: prefetch slot, SQS or Pub/Sub lease) then the message is redelivered; longer delays use the broker's
**native** delayed redelivery. **The application fails to start (ZNIGHT011)** if a policy needs a delay
the driver cannot honour (e.g. more than 12 h on SQS).

### Errors and validation

- Throw `NonRetryableError` (or a subclass) for permanent failures: dead-lettered immediately
  (reason `non-retryable`). `isNonRetryable(error)` also recognises errors from other copies of the package.
- `@Message(schema)` validation failures throw a `MessageValidationError` (non-retryable, reason
  `validation`, `error.issues: { path, message }[]`). Handlers receive the schema **output**
  (defaults, transforms).
- An undecodable body (malformed JSON...) is dead-lettered with reason `decode`.

### Dead-letter queues

The dead-letter destination of a queue is, by priority: `@Consumer({ deadLetter })`,
`defaults.deadLetter(queue)`, the driver naming (`orders.dlq`; SQS `orders-dlq` or the target of the
queue's `RedrivePolicy`; Pub/Sub the topic `orders-dlq` or the topic of the subscription's dead-letter
policy; Service Bus the dead-letter sub-queue `orders/$deadletterqueue`). The copy keeps the body, type, id and headers (without `x-znight-attempt`, so
that a redrive starts over) and adds:

| Header                        | Value                                                                   |
| ----------------------------- | ----------------------------------------------------------------------- |
| `x-znight-dead-letter-reason` | `no-handler`, `decode`, `validation`, `non-retryable` or `max-attempts` |
| `x-znight-error`              | Error message (truncated to 1024 characters)                            |
| `x-znight-original-queue`     | Queue / topic the message was consumed from                             |
| `x-znight-attempts`           | Attempts made                                                           |
| `x-znight-consumer-group`     | Kafka only: consumer group                                              |

The original is acknowledged only once the copy is confirmed; if the publication fails, the message
is released after `defaults.requeueDelay` and redelivered. `deadLetter: false` disables
dead-lettering: RabbitMQ rejects the message (a queue DLX policy applies), SQS and Kafka discard it,
Pub/Sub nacks it (the subscription's dead-letter policy applies) or acknowledges it when the
subscription is known to have no dead-letter policy, Service Bus completes it.

### Concurrency and graceful shutdown

`concurrency` (default `defaults.concurrency`, 1) bounds the messages a consumer handles at once
(RabbitMQ prefetch, SQS receive batches, Kafka partitions handled in parallel, Pub/Sub leased messages, Service Bus
locked messages).

`app.stop()` (or SIGTERM) stops receiving, aborts in-process retry delays (those messages are released
to the broker, never dropped), aborts `message.signal`, waits for the handlers in flight, then closes
the connections. Keep handlers shorter than `shutdown.hookTimeoutMs` (5 s by default) or raise it.

While consumers run (from `onStart` to the end of `onStop`), the plugin keeps the process alive: a
worker whose only ingress is a consumer does not exit after `app.start()`, whatever the driver (the
memory driver holds no socket), and stops only through `app.stop()` or a signal.

The runtime logs each retry (`warn`) and each dead letter (`error`) with the error. When a
`messaging:message` wrapper is installed (the `ObservabilityPlugin` delivery log writes one entry per
delivery with the error), these entries carry only the error message (`error`) instead of the error
and its stack (`err`), so that the stack is logged once.

### Request scope

Each delivery runs in its own request scope seeded with the `InboundMessage`
(`@znight/messaging#InboundMessage`, a request-scoped external): inject it into request-scoped
providers, or use `Lazy<InboundMessage>` from singletons. Request-scoped instances are disposed when
the delivery ends.

```ts
interface InboundMessage<T = unknown> {
  id: string // stable across redeliveries
  queue: string
  type: string | undefined
  payload: T
  headers: Readonly<Record<string, string>>
  key: string | undefined // Kafka key, SQS FIFO group, Pub/Sub ordering key, Service Bus session id
  attempt: number // 1-based
  maxAttempts: number
  redelivered: boolean
  timestamp: number | undefined // produced at (epoch ms)
  receivedAt: number
  contentType: string | undefined
  body: Uint8Array | string // raw body
  driver: string
  raw: unknown // amqplib ConsumeMessage, SQS Message, Kafka Message, Pub/Sub ReceivedMessage, ServiceBusReceivedMessage...
  signal: AbortSignal // aborted on shutdown
}
```

## Publishing

`MessageBroker` is a singleton external: inject it anywhere (or `app.get(MessageBroker)`).

```ts
const { id } = await broker.publish('orders', order, {
  type: 'order.placed', // handler selection
  headers: { 'x-tenant': 'acme' }, // string values
  key: order.customerId, // Kafka partition key / SQS FIFO group / Pub/Sub ordering key / Service Bus session id
  delay: 5_000, // ms (RabbitMQ, SQS ≤ 15 min, Service Bus, memory; not Kafka nor Pub/Sub)
  id: order.id, // default: random UUID
})
```

`publish()` resolves once the broker **confirmed** the message (publisher confirms, SQS response, Kafka
acks from all in-sync replicas, Pub/Sub `Publish` response, Service Bus send
disposition). Payloads are JSON-encoded; `Uint8Array` is sent as
`application/octet-stream`; a string with a `contentType` is sent as is. It works from the plugin's
bootstrap until the application is disposed (providers' `onStart` and `onStop` included).

## Configuration

```ts
MessagingPlugin.configure({
  driver: sqs({ clientConfig: { region: 'eu-west-1' } }),
  defaults: { retry: { attempts: 5, delay: 200 }, concurrency: 10, deadLetter: queue => `${queue}-dead` },
})
// or computed from the container (evaluated at bootstrap)
MessagingPlugin.configure(c => ({ driver: rabbitmq({ url: c.get(AmqpConfig).url }) }))
```

| Option                  | Default                      | Description                                                                                            |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `driver`                | —                            | `memory()`, `rabbitmq()`, `sqs()`, `kafka()`, `pubsub()` or `azureServiceBus()` (from their subpaths). |
| `defaults.retry`        | 3 attempts, 1 s exp., ≤ 30 s | Policy of handlers without `@Retry`; `false` disables retries.                                         |
| `defaults.concurrency`  | `1`                          | Concurrency of consumers without `concurrency`.                                                        |
| `defaults.deadLetter`   | driver naming                | `(queue) => name`, or `false` to disable dead-lettering.                                               |
| `defaults.requeueDelay` | `1000`                       | Pause (ms) before releasing a message whose settlement failed.                                         |
| `codec`                 | `jsonCodec`                  | `{ encode(payload, contentType), decode(body, contentType) }`.                                         |
| `consume`               | `true`                       | `false` for publish-only processes (consumers are not subscribed).                                     |

The plugin (`name: 'messaging'`) exposes `broker`, `driver` and `consumers()` (state, in-flight count,
dead-letter queue of each consumer).

Options are validated in `onBootstrap`, so invalid options (a `driver` that is not a messaging driver,
a `defaults.concurrency` that is not a positive integer...) make `Application.create()` fail with
**ZNIGHT011**, the code of invalid consumer settings, like a `@Retry` policy the driver cannot honour.

## Drivers

| Capability             | memory    | RabbitMQ                                | SQS                              | Kafka                                | Pub/Sub                                          | Azure Service Bus                                  |
| ---------------------- | --------- | --------------------------------------- | -------------------------------- | ------------------------------------ | ------------------------------------------------ | -------------------------------------------------- |
| Subpath                | `/memory` | `/rabbitmq`                             | `/sqs`                           | `/kafka`                             | `/pubsub`                                        | `/azure-service-bus`                               |
| Client (optional peer) | —         | `amqplib` ^2                            | `@aws-sdk/client-sqs` ^3         | `@platformatic/kafka` ^2             | `@google-cloud/pubsub` ^6                        | `@azure/service-bus` ^7                            |
| Attempt counting       | native    | `x-znight-attempt` + `x-delivery-count` | `ApproximateReceiveCount`        | `x-znight-attempt`                   | `deliveryAttempt` (in memory without DLQ policy) | `deliveryCount` + `x-znight-attempt`               |
| Native retry delay     | timers    | delay queues (TTL + DLX), ≤ 49 days     | visibility timeout, ≤ 12 h       | retry topic, ≤ `maxRetryDelayMs`     | ack deadline, ≤ 600 s                            | scheduled copy (queues), lock held (subscriptions) |
| In-process budget      | 1 s       | 5 s                                     | 1 s                              | 0 (always the retry topic)           | 1 s (0 with `retries: 'subscription'`)           | 1 s (0 with `retries: 'entity'`)                   |
| Delayed publish        | yes       | yes (32 shared delay levels), ≤ 49 days | ≤ 15 min (not FIFO)              | no                                   | no                                               | yes (scheduled messages)                           |
| Dead letters           | `<q>.dlq` | `<q>.dlq` (publish confirmed + ack)     | `<q>-dlq` / RedrivePolicy target | `<topic>.dlq` (acks all + commit)    | topic `<q>-dlq` / dead-letter policy topic       | sub-queue `<q>/$deadletterqueue`                   |
| Ordering               | FIFO      | none across retries                     | FIFO groups                      | per partition                        | ordering keys (ordered subscriptions)            | none (sessions refused)                            |
| Topology               | implicit  | declared (`assertTopology`) or verified | verified (queues must exist)     | verified or created (`createTopics`) | verified or created (`provision`)                | verified or created (`provision`)                  |

OCI Streaming and Azure Event Hubs work through the Kafka driver ([below](#oracle-cloud-infrastructure-streaming));
for another broker, [write your own driver](#writing-your-own-driver) and check it with the conformance kit.

### Memory

Deterministic in-process broker: FIFO queues, round-robin between competing subscribers, delays (of
any length: timers longer than 2^31 - 1 ms are chained), native delivery counts, dead-letter queues.
Ideal for tests:

```ts
import { memory } from '@znight/messaging/memory'

const driver = memory({ maxInProcessDelayMs: 1000 })
const app = await Application.create({ metadata, plugins: [MessagingPlugin.configure({ driver })] })
await app.start()

driver.send('orders', { payload: { id: 1 }, type: 'order.placed' }) // as an external producer
driver.send('orders', { body: '{oops', contentType: 'application/json' }) // malformed body
await driver.idle() // nothing in flight, scheduled or deliverable

driver.settlements('orders') // [{ id, attempt, action: 'ack' | 'retry' | 'release' | 'dead-letter' | 'reject', delayMs?, reason?, error? }]
driver.deadLetters('orders') // [{ queue, reason, error, attempt, message }]
driver.published('orders') // messages published through MessageBroker
driver.pending('orders.dlq') // messages waiting in a queue
driver.fail('publish', { queue: 'orders.dlq', times: 1 }) // inject failures (publish, ack, retry, dead-letter, release, subscribe, connect)
await driver.waitFor(() => driver.settlements().length === 3)
```

### RabbitMQ

```ts
import { rabbitmq } from '@znight/messaging/rabbitmq'

rabbitmq({ url: 'amqp://guest:guest@localhost:5672' })
```

| Option                | Default                                      | Description                                                                        |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `url`                 | —                                            | AMQP URL or amqplib connection options.                                            |
| `socketOptions`       | —                                            | TLS / socket options.                                                              |
| `assertTopology`      | `true`                                       | Declare consumed, dead-letter and delay queues; `false`: verify they exist.        |
| `queueType`           | `'quorum'`                                   | Type of declared queues (`'classic'` for existing classic queues).                 |
| `queueArguments`      | —                                            | Extra arguments of declared queues (`x-delivery-limit` overrides `-1`).            |
| `maxInProcessDelayMs` | `5000`                                       | Longest retry delay waited in-process.                                             |
| `delayQueueName`      | `` `${q}.delay.${ms}` ``                     | Retry delay queue naming.                                                          |
| `delayLevelPrefix`    | `'znight.delays'`                            | Names of the delay levels of delayed publications (`<prefix>.0` to `.31`).         |
| `deadLetterName`      | `` `${q}.dlq` ``                             | Default dead-letter queue.                                                         |
| `publishTimeoutMs`    | `30000`                                      | Longest wait for a publisher confirm (publish, retry, dead letter); `0`: no limit. |
| `mandatory`           | `true`                                       | Fail `publish()` when no queue receives the message.                               |
| `persistent`          | `true`                                       | Persistent messages.                                                               |
| `typeFromRoutingKey`  | `false`                                      | Use the routing key as type for messages without type (topic exchanges).           |
| `reconnect`           | `{ initialDelayMs: 100, maxDelayMs: 30000 }` | Reconnection with exponential backoff; `false` disables.                           |
| `connectionName`      | `'znight'`                                   | Connection name in the management UI.                                              |

Publishing goes through a confirm channel and the default exchange (routing key = queue); a returned
(unroutable) message fails its own `publish()` only, even when concurrent publications share its id.
A publication not confirmed within `publishTimeoutMs` fails, naming the broker alarm when the
connection is blocked (memory or disk alarm), instead of hanging until the alarm clears.
Each consumer has its own channel with `prefetch = concurrency`. Retries are republished copies
carrying `x-znight-attempt` (to the queue, or to a per-delay queue `orders.delay.2000` whose TTL
dead-letters back into `orders`, so delays never block each other); quorum delay queues use
at-least-once dead-lettering. Retry delays come from the `@Retry` policies, so their delay queues are
a bounded set declared at subscribe time. The type is read from the `type` property (then
`x-znight-type`, then the routing key with `typeFromRoutingKey`), the id from `message-id`; retried
and dead-lettered copies carry the type that selected the handler (a type read from the routing key
included) but never the `CC` / `BCC` headers nor the broker's `x-death` headers. The `user-id`
property is kept only when it is the user of the connection (the broker rejects any other).

Delayed publications (`publish(queue, payload, { delay })`, any delay up to 2^32 - 1 ms) do not create
one queue per delay: they go through 32 **delay levels** shared by every queue of the virtual host,
`znight.delays.0` to `znight.delays.31` (a topic exchange and a queue each, the queue of level n with a
TTL of 2^n ms). The delay, rounded up to an odd number of milliseconds, is written in binary in the
routing key: the message waits in the level of each set bit, then level 0 dead-letters it to the
default exchange, which delivers it to its queue (named in the `CC` header). A delay is never shortened;
each level crossed adds a few milliseconds. The levels are declared on the first delayed publication
of each connection, whatever `assertTopology`; quorum levels use at-least-once dead-lettering. Use
`delayLevelPrefix` when applications sharing a virtual host use different `queueType`s.

On RabbitMQ 4 and later, declared quorum queues (consumed and dead-letter queues) get
`x-delivery-limit: -1`: Znight counts the attempts itself, whereas the broker's default limit (20
deliveries, releases included) would silently drop a message released repeatedly, for instance while
its dead-letter queue is unavailable. A queue that already exists without this argument cannot be
changed by a declaration: the driver declares it as it is and logs a warning; apply a policy with
`"delivery-limit": -1` (or re-create the queue). With `assertTopology: false`, set that policy on your
quorum queues.

After a connection loss the driver reconnects (exponential backoff) and resumes the consumers;
messages in flight on the lost connection are redelivered by RabbitMQ. A consumer channel closed by a
channel error, or a consumer cancelled by the broker (queue deleted, node down: the queues are then
declared again with `assertTopology`), is resumed the same way; so is a consumer whose queue is gone
when it resumes (`404 NOT_FOUND`: declared again before the next attempt). The recovery retries until
every consumer consumes again, including when the connection is lost again while it runs.

### Amazon SQS

```ts
import { sqs } from '@znight/messaging/sqs'

sqs({ clientConfig: { region: 'eu-west-1' } })
```

| Option                | Default         | Description                                                      |
| --------------------- | --------------- | ---------------------------------------------------------------- |
| `client`              | —               | An existing `SQSClient` (not destroyed on close).                |
| `clientConfig`        | `{}`            | Configuration of the client created by the driver.               |
| `queueUrls`           | —               | `{ name: url }` to skip `GetQueueUrl` (queues may also be URLs). |
| `waitTimeSeconds`     | `20`            | Long polling duration.                                           |
| `visibilityTimeout`   | queue attribute | Visibility timeout of received messages (seconds).               |
| `extendVisibility`    | `true`          | Extend the visibility while handlers run (every half timeout).   |
| `maxInProcessDelayMs` | `1000`          | Longest retry delay waited in-process.                           |
| `deadLetterName`      | `<q>-dlq`       | Default dead-letter queue (`<name>-dlq.fifo` for FIFO queues).   |

Queues are not created by the driver (manage them as infrastructure). At subscribe time it verifies
the queue and its dead-letter queue exist and that a `RedrivePolicy` `maxReceiveCount` is at least the
consumer's largest `attempts` (otherwise SQS would move messages before Znight retried them; the boot
fails). With a redrive policy and the default naming, Znight dead-letters to the policy's target.
Headers are message attributes: SQS allows 10 per message and Znight uses up to 4 (`x-znight-id`,
`x-znight-type`, `content-type`, `x-znight-encoding`). FIFO queues use `key` as `MessageGroupId`
(default `'default'`), the message id as deduplication id, and messages of a group are handled in
order. A dead-letter copy is always one SQS accepts: its FIFO deduplication id is derived from the SQS
`MessageId` (never from a producer's `x-znight-id`), the characters SQS refuses are replaced in
`x-znight-error`, and a copy SQS still refuses as invalid (too large...) is sent again without
`x-znight-error` and the headers (with a warning) instead of looping on redeliveries; a transient
failure (throttling, KMS, permissions) releases the message instead, for a full copy later. The lease extension of a message stops (once any extension in flight completed) before its
settlement is sent, so that it never overrides the visibility set by a retry or a release. IAM
permissions: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`,
`sqs:SendMessage`, `sqs:GetQueueUrl`, `sqs:GetQueueAttributes`.

### Google Cloud Pub/Sub

```ts
import { pubsub } from '@znight/messaging/pubsub'

pubsub({ projectId: 'acme-prod', subscriptions: { notifications: 'events-notifications' } })
```

| Option                | Default              | Description                                                                                |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `projectId`           | the client's project | Project of short names (`GOOGLE_CLOUD_PROJECT`, credentials, `PUBSUB_PROJECT_ID`...).      |
| `client`              | —                    | An existing `PubSub` whose configuration the driver reuses (not closed).                   |
| `clientConfig`        | `{}`                 | Configuration of the `PubSub` client created by the driver (`credentials`, `apiEndpoint`). |
| `publisherClient`     | —                    | An existing `v1.PublisherClient` (not closed).                                             |
| `subscriberClient`    | —                    | An existing `v1.SubscriberClient` (not closed).                                            |
| `topics`              | the queue name       | Topic of each published queue: `{ queue: name }` or `(queue) => name`.                     |
| `subscriptions`       | the queue name       | Subscription of each `@Consumer` queue: `{ queue: name }` or `(queue) => name`.            |
| `retries`             | `'znight'`           | Who retries and dead-letters: `'znight'` or `'subscription'` (below).                      |
| `ackDeadlineSeconds`  | `60`                 | Ack deadline kept on messages while handlers run (10–600, extended every half).            |
| `maxInProcessDelayMs` | `1000`               | Longest retry delay waited in-process (`0` with `retries: 'subscription'`).                |
| `pullTimeoutMs`       | `30000`              | Longest wait of a Pull for messages.                                                       |
| `deadLetterName`      | `<q>-dlq`            | Default dead-letter queue (a topic).                                                       |
| `provision`           | `false`              | Create missing topics and subscriptions (development, emulator).                           |

`publish(queue)` publishes to a **topic** and `@Consumer(queue)` pulls a **subscription**. Both are
named after the queue by default (a topic and a subscription with the same name behave like a
queue); map them with `topics` and `subscriptions` (a short name in `projectId`, or a full resource
name `projects/<p>/subscriptions/<s>`). For a fan-out, publish to the topic and give each consumer its
subscription. `message.queue` and `x-znight-original-queue` keep the `@Consumer` queue.

The driver pulls with unary Pull, never more messages than the consumer `concurrency`, keeps their ack
deadline at `ackDeadlineSeconds` while they are handled (the extension stops, once any extension in
flight landed, before a settlement), acknowledges with `Acknowledge` and releases with a zero
deadline. A retry sets the ack deadline to the delay (whole seconds, at most 600 s): Pub/Sub
redelivers the message after it. Attempts come from `deliveryAttempt`, which Pub/Sub only sets on
subscriptions with a **dead-letter policy**; without one, the driver counts the retries it requested
in memory (exact for a single replica, approximate across replicas and restarts) and warns at
subscribe time when a consumer retries.

**Who retries.** Pub/Sub can own retries and dead letters (subscription retry policy and dead-letter
policy). To never stack both layers, pick one owner with `retries`:

- `'znight'` (default): `@Retry` applies and Znight publishes dead letters (with the
  `x-znight-dead-letter-reason`... attributes) to the topic `<q>-dlq`. When the subscription also has
  a dead-letter policy, its `maxDeliveryAttempts` must allow every attempt of the consumer (the boot
  fails otherwise) and the default destination becomes the policy's topic.
- `'subscription'`: every failure is an immediate nack, so the subscription's retry policy sets the
  backoff (the `@Retry` delays are ignored) and its dead-letter policy forwards the message after
  `maxDeliveryAttempts`; Znight publishes no dead-letter copy. The subscription must have a dead-letter
  policy (the boot fails otherwise). Set the `@Retry` attempts (or `defaults.retry.attempts`) to
  `maxDeliveryAttempts` so that the handler runs on every delivery (a warning when they differ).
  Terminal failures (a `NonRetryableError`, a validation or decoding failure, a message without
  handler, exhausted attempts) are nacked too and logged as rejected, without a dead-letter queue
  name since Znight publishes nothing: they are redelivered until the policy forwards them, and the
  handler, `@OnError`, the `dead-letter` delivery outcome (logs, metrics, traces) and the
  `error:report` event repeat on each of these deliveries. The `@Retry` delays are ignored but still
  checked: each must fit within 600 s.

The in-process budget and the `@Retry` checks are driver-wide, so the mode is chosen on the driver.
Under `pubsub({ retries: 'subscription' })`, a consumer can take the ownership back with
`@Consumer({ queue, retries: 'znight' })`, typically the collector of a dead-letter topic, whose
subscription has no dead-letter policy: it keeps `@Retry` and Znight dead letters, with no in-process
budget (every retry delay becomes an ack deadline, in whole seconds). The opposite,
`@Consumer({ retries: 'subscription' })` under a `'znight'` driver, fails the boot (ZNIGHT011).

```ts
MessagingPlugin.configure({
  driver: pubsub({ retries: 'subscription' }),
  defaults: { retry: { attempts: 5, backoff: 'fixed', delay: 0 } }, // maxDeliveryAttempts: 5
})
```

Headers are message attributes (Pub/Sub allows 100 per message, keys up to 256 bytes, values up to
1024 bytes, no `goog` prefix: checked before publishing) and Znight uses 3 (`x-znight-id`,
`x-znight-type`, `content-type`); the body is the message data. Trace context (`traceparent`,
`tracestate`) travels as attributes; the `googclient_traceparent` of messages published by the Google
client library with OpenTelemetry is exposed as `traceparent`. `key` is the ordering key: on
subscriptions with message ordering (or whose configuration cannot be read), messages of a key are
handled one after the other. Delayed publishing is not supported.

Nothing is created by default: at subscribe time the driver reads the subscription (a missing one
fails the boot) and checks the Znight dead-letter topic. Without the `pubsub.subscriptions.get` and
`pubsub.topics.get` permissions (`roles/pubsub.viewer`), it logs a warning and skips these checks.
`provision: true` creates the missing topic and subscription of a consumer, the dead-letter topic with
a subscription of the same name (a topic without subscription drops its messages), and the topics
published to. Under `retries: 'subscription'`, a created subscription gets a dead-letter policy to that
topic, with the consumer's attempts as `maxDeliveryAttempts` (between 5 and 100, the Pub/Sub bounds).
`PUBSUB_EMULATOR_HOST` (or `clientConfig.apiEndpoint`) targets the emulator.

On stop, the driver stops pulling (a Pull in flight is abandoned and the messages it may still return
are released), keeps extending the deadline of the messages in flight until the runtime settles them,
then closes the clients it created. A long drain needs `shutdown.hookTimeoutMs` above it. Permissions:
`pubsub.subscriptions.consume`, `pubsub.topics.publish`, and `pubsub.subscriptions.get` /
`pubsub.topics.get` for the checks. Design notes: [RFC 0012](../../rfcs/0012-messaging-pubsub.md).

### Azure Service Bus

```ts
import { azureServiceBus } from '@znight/messaging/azure-service-bus'

azureServiceBus({ connectionString: process.env['SERVICE_BUS_CONNECTION_STRING'] })
// Microsoft Entra ID: DefaultAzureCredential (@azure/identity) unless `credential` is given
azureServiceBus({
  fullyQualifiedNamespace: 'acme.servicebus.windows.net',
  subscriptions: { billing: 'orders/billing' },
})
```

| Option                           | Default                  | Description                                                                                       |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `connectionString`               | —                        | Connection string of the namespace (or of the emulator).                                          |
| `fullyQualifiedNamespace`        | —                        | `<namespace>.servicebus.windows.net`, authenticated with `credential`.                            |
| `credential`                     | `DefaultAzureCredential` | A `TokenCredential`; the default comes from `@azure/identity` (optional peer, loaded on connect). |
| `client`                         | —                        | An existing `ServiceBusClient` (not closed). One of these three options is required.              |
| `clientOptions`                  | `{}`                     | Options of the client created by the driver (retry options, web sockets...).                      |
| `administrationClient`           | from the credentials     | A `ServiceBusAdministrationClient` for the checks and `provision`; `false` skips them.            |
| `entities`                       | the queue name           | Queue or topic of each published queue: `{ queue: name }` or `(queue) => name`.                   |
| `subscriptions`                  | the queue name           | Entity of each `@Consumer` queue: `queue`, `topic/subscription`, with `/$deadletterqueue` or not. |
| `retries`                        | `'znight'`               | Who retries and dead-letters: `'znight'` or `'entity'` (below).                                   |
| `maxInProcessDelayMs`            | `1000`                   | Longest retry delay waited in-process (`0` with `retries: 'entity'`).                             |
| `maxWaitTimeMs`                  | `30000`                  | Longest wait of a receive for messages.                                                           |
| `maxAutoLockRenewalDurationInMs` | `300000`                 | How long the SDK renews the lock of a message after receiving it.                                 |
| `deadLetterName`                 | `<q>/$deadletterqueue`   | Default dead-letter queue: the entity's native sub-queue, or another queue or topic.              |
| `provision`                      | `false`                  | Create missing queues, topics and subscriptions (development, emulator).                          |

`publish(queue)` sends to the **queue or topic** named after the queue (`entities` maps it).
`@Consumer(queue)` receives from a queue, from a **topic subscription** written `topic/subscription`
(or `topic/subscriptions/subscription`, the Service Bus path), or from the **dead-letter sub-queue**
of either (`orders/$deadletterqueue`); `subscriptions` maps a consumer queue to such a path.
`message.queue` and `x-znight-original-queue` keep the `@Consumer` queue. For a fan-out, publish to
the topic and give each consumer its subscription.

The driver receives in peek-lock mode (`receiveMessages`), never more messages than the free
concurrency slots, and the SDK renews the lock of each message while it is handled, up to
`maxAutoLockRenewalDurationInMs` after it was received. `ack` completes the message, `release`
abandons it. Attempts combine the delivery count (abandoned or expired deliveries) and the
`x-znight-attempt` property of scheduled retry copies.

**Who retries.** Service Bus can own redelivery (`maxDeliveryCount`, then the dead-letter
sub-queue). To never stack both layers, pick one owner with `retries`:

- `'znight'` (default): `@Retry` applies. A retry without delay (or after an in-process wait)
  abandons the message. A longer delay on a queue schedules a copy on the queue
  (`scheduledEnqueueTimeUtc`, with `x-znight-attempt`), then completes the original: the JS SDK has no
  transactions, so a crash in between duplicates the message, never loses it. On a subscription (a
  copy sent to the topic would reach every subscription) or a dead-letter sub-queue, the message
  stays locked during the delay, then is abandoned: such delays must fit within
  `maxAutoLockRenewalDurationInMs` (the boot fails otherwise; forward the subscription to a queue
  with `forwardTo` for long delays). Dead letters go to the entity's **dead-letter sub-queue**
  (`deadLetterMessage()`, with `DeadLetterReason` / `DeadLetterErrorDescription` and the
  `x-znight-dead-letter-reason`... properties); another `deadLetter` name (a queue or topic) receives a
  copy before the original is completed. `deadLetter: false` completes (discards) the message. The
  entity's `maxDeliveryCount` must allow every attempt of the consumer (the boot fails otherwise).
- `'entity'`: every retryable failure abandons the message at once (the `@Retry` delays are
  ignored), and the entity dead-letters it after `maxDeliveryCount` deliveries; set the `@Retry`
  attempts (or `defaults.retry.attempts`) to `maxDeliveryCount` (a warning when they differ).
  Non-retryable failures (`NonRetryableError`, validation, decoding, no handler) are dead-lettered to
  the sub-queue at once. Under `azureServiceBus({ retries: 'entity' })`, a consumer can take the
  ownership back with `@Consumer({ queue, retries: 'znight' })` (a dead-letter collector);
  `@Consumer({ retries: 'entity' })` under a `'znight'` driver fails the boot (ZNIGHT011).

The sub-queue keeps the delivery count of a message: the driver records it on the messages it
dead-letters, so that a consumer of the sub-queue starts over at attempt 1 (a message the entity
dead-lettered after `maxDeliveryCount` starts at that count).

Headers are application properties; the id is the message id (so duplicate detection applies to
`publish(..., { id })`; retry and dead-letter copies get their own message id and keep the Znight id
in `x-znight-id`), the type is the subject, the content type the content type, and the body is sent as
bytes. `key` becomes the session id and the partition key (at most 128 characters). Trace context
(`traceparent`, `tracestate`) travels as application properties; the `Diagnostic-Id` the Azure SDK
writes is exposed as `traceparent` when there is none. Delayed publishing schedules the message
(`scheduleMessages`, no practical limit).

Session-enabled entities are refused (ZNIGHT011): session receivers, for ordered processing, are
planned. Nothing is created by default: at subscribe time the administration client reads the queue
or subscription (missing, session-enabled or with a `maxDeliveryCount` below the attempts: the boot
fails) and the dead-letter queue named after another entity. Without the Manage right (or with
`administrationClient: false`), the driver logs a warning and peeks at the entity instead, which only
proves it exists. `provision: true` creates the missing queue (`maxDeliveryCount` covering the
attempts, at least 10), topic and subscription of a consumer, the queues published to and the
dead-letter queues. With the [emulator](https://learn.microsoft.com/azure/service-bus-messaging/overview-emulator),
use its connection string (`UseDevelopmentEmulator=true`) and point `administrationClient` at its
administration port (5300).

On stop, the driver stops receiving (a receive in flight is aborted: messages it was getting stay
locked until their lock expires), waits for the deliveries in flight, abandons the messages held for
a retry, then closes the receivers, the senders and the client it created. Rights: Listen and Send
(`Azure Service Bus Data Receiver` / `Data Sender` roles), Manage for the checks and `provision`.
Design notes: [RFC 0014](../../rfcs/0014-messaging-drivers.md) §4.1.

### Kafka

```ts
import { kafka } from '@znight/messaging/kafka'

kafka({ bootstrapBrokers: ['localhost:9092'], groupId: 'billing' })
```

| Option                | Default                | Description                                                                     |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `bootstrapBrokers`    | —                      | `host:port` list.                                                               |
| `clientId`            | `'znight'`             | Client id.                                                                      |
| `groupId`             | `'znight'`             | Prefix of consumer groups: each consumer uses `<groupId>.<topic>`.              |
| `connection`          | —                      | Options shared by producer, consumers and admin (tls, sasl, timeouts).          |
| `consumer`            | —                      | Extra consumer options (`sessionTimeout`, `heartbeatInterval`...).              |
| `fromBeginning`       | `false`                | Where new consumer groups start (`earliest` or `latest`).                       |
| `createTopics`        | `false`                | Create missing topics (`true` or `{ partitions, replicas }`); otherwise verify. |
| `retryTopicName`      | `` `${group}.retry` `` | Retry topic of a consumer group.                                                |
| `deadLetterName`      | `` `${topic}.dlq` ``   | Default dead-letter topic.                                                      |
| `maxInProcessDelayMs` | `0`                    | Longest retry delay waited in-process (blocks the partition).                   |
| `maxRetryDelayMs`     | 15 min                 | Longest wait of a retry record, whatever its `x-znight-not-before` says.        |

`@Consumer({ queue: 'orders', groupId: 'billing-orders' })` overrides the group of one consumer (two
consumers cannot share a group). Offsets are committed manually, once a record is settled; records of
a partition are handled sequentially, partitions concurrently (`concurrency`). Retries are
non-blocking: the record goes to the group's retry topic with `x-znight-not-before`; a dedicated
consumer (group `<group>.retry`, always from the beginning) waits until then without holding a
concurrency slot, and the main and retry streams have their own back-pressure (a backlog of retries
waiting for their time never pauses the main topic). Only records of the retry topic honour
`x-znight-not-before`, and none waits more than `maxRetryDelayMs` after it was fetched (a later
not-before, from another producer or a skewed clock, is logged and cut short). After a rebalance, the records of a partition this
member kept are fetched again from the committed offset: those already buffered or handled are
skipped (committed offsets never move back); the buffered records of the partitions it lost are
dropped, their new owner handles them. On shutdown, unsettled records are not committed and are
consumed again later.

With `createTopics`, a topic created concurrently (by another consumer, such as the collector of a
dead-letter topic, or another instance) counts as created. Transient broker errors are retried by the
client (`connection.retries`), and by the driver for the topics still missing when an existing topic
stopped those retries; startup then fails with the error code and message of each topic.

### Oracle Cloud Infrastructure Streaming

OCI Streaming exposes a Kafka-compatible endpoint, so the Kafka driver works with it: point
`bootstrapBrokers` at the stream pool and authenticate with SASL `PLAIN` over TLS, the user being
`<tenancy>/<user>/<stream pool OCID>` and the password an auth token.

```ts
import { kafka } from '@znight/messaging/kafka'

kafka({
  bootstrapBrokers: ['cell-1.streaming.eu-frankfurt-1.oci.oraclecloud.com:9092'],
  connection: {
    tls: {}, // TLS with the default certificate authorities
    sasl: { mechanism: 'PLAIN', username: process.env['OCI_STREAM_USER'], password: process.env['OCI_AUTH_TOKEN'] },
  },
})
```

The topics the driver uses are streams of that pool: the consumed topics, the retry topic of each
consumer group (`<group>.retry`) and the dead-letter topics (`<topic>.dlq`). Create them beforehand,
or let `createTopics` create them where the pool allows it. Azure Event Hubs, Kafka-compatible too,
works the same way. OCI Queue has no first-party driver ([RFC 0014](../../rfcs/0014-messaging-drivers.md)):
a third-party driver can cover it.

### Writing your own driver

A driver is an object implementing `MessagingDriver`; its types are exported from
`@znight/messaging` and the contract is public ([RFC 0014](../../rfcs/0014-messaging-drivers.md),
specification §9.2). Drivers are runtime-only: no compiler extension, no manifest, just a package
exporting a factory that applications pass to `MessagingPlugin.configure({ driver })`.

| Member                            | What it does                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                            | Short name (`acme`), exposed as `InboundMessage.driver`.                                                                                                       |
| `capabilities`                    | `nativeDelay`, `maxNativeDelayMs`, `maxInProcessDelayMs`, `deliveryCount` (`'native'` or `'header'`), `maxPublishDelayMs` (`0`: no delayed publishing).        |
| `connect({ logger })`             | Opens the connection, in `onBootstrap`. The logger is for background failures (lost connection, polling errors).                                               |
| `subscribe(queue, handler, opts)` | Verifies the queue and its dead-letter destination, then calls `handler(delivery)` for each message, with at most `opts.concurrency` pending handler promises. |
| `publish(queue, message)`         | Resolves once the broker **confirmed** the message; `message.delayMs > 0` asks for a delayed delivery.                                                         |
| `deadLetterName(queue)`           | Default dead-letter destination (`orders.dlq`, `orders-dlq`...).                                                                                               |
| `close()`                         | Closes the subscriptions and the connection, in `onDispose`. Idempotent.                                                                                       |

**Lifecycle.** `connect` runs once in `onBootstrap`, after the plugin validated every `@Retry` policy
against `capabilities` (ZNIGHT011 otherwise: the runtime never asks for more than the driver
declares). `onStart` subscribes each consumer, with `SubscribeOptions` (`consumer`, `concurrency`,
`deadLetterQueue`, `maxAttempts`, `retryDelays`, and the driver options of `@Consumer({ queue,
...options })`). On stop, the runtime calls `subscription.cancel()` (stop receiving), releases the
deliveries waiting for an in-process retry, waits for the handlers in flight, then calls
`subscription.close()`; `close()` comes last, in `onDispose`.

**Settlement.** Each `DriverDelivery` (`id`, `body`, `contentType`, `headers`, `type`, `key`,
`attempt`, `redelivered`, `timestamp`, `raw`) gets exactly one settlement, possibly followed by
`release()` when it failed, and each one resolves once the broker acknowledged it:

- `ack()`: the message was handled.
- `retry({ attempt, delayMs })`: redeliver it as attempt `attempt` after `delayMs`. The copy (or the
  native redelivery) must be durable before the original is settled: at-least-once, never
  at-most-once. Waits up to `maxInProcessDelayMs` happen in the runtime, which then asks for
  `delayMs: 0`.
- `deadLetter({ queue, reason, error, attempt })`: publish the copy to `queue` with
  `deadLetterHeaders(headers, request, originalQueue)` (the original headers minus
  `x-znight-attempt`, plus the reason, the error, the original queue and the attempts), then settle
  the original. `queue` is `undefined` when dead-lettering is disabled: reject the message natively
  (so that a broker dead-letter policy applies) or discard it. A subscription whose broker
  dead-letters by its own policy reports `nativeDeadLetter: true`.
- `release()`: give the message back for a later redelivery without settling it. Never lose it.

**Attempts.** `attempt` is 1-based: the broker's delivery count (`deliveryCount: 'native'`), or the
`x-znight-attempt` header of the copies `retry` publishes (`deliveryCount: 'header'`, read it with
`attemptFromHeaders()`), or both combined.

**Headers and trace context.** Carry every header verbatim, both ways, as strings: Znight's
(`x-znight-*`), the application's, and the trace context `@znight/observability` writes in the
`messaging:publish` hook (`traceparent`, `tracestate`, whatever the configured propagator writes), which it reads back on delivery.
A broker that renames headers maps them back. `id`, `type`, `key`, `contentType` and `timestamp`
survive the round trip, in message properties or in `x-znight-*` headers (`MessagingHeaders`).

**Shutdown.** `cancel()` stops receiving. `close()` waits for the deliveries in flight to settle and
gives back what was received but not handed to the runtime.

A minimal driver over an in-process broker (a real driver holds a client instead), run by the
conformance kit in this package's tests:

<!-- sample: packages/messaging/test/testing/local-driver.ts -->

```ts
/** A minimal messaging driver over an in-process broker, conformant (`describeDriverConformance()`). */
import type {
  DeadLetterRequest,
  DeliveryHandler,
  DriverCapabilities,
  DriverContext,
  DriverDelivery,
  MessagingDriver,
  OutboundMessage,
  RetryRequest,
  SubscribeOptions,
  Subscription,
} from '@znight/messaging'

import { attemptFromHeaders, deadLetterHeaders, MessagingHeaders } from '@znight/messaging'

/** The "broker": queues shared by every driver created on it (a real driver holds a client instead). */
export class LocalBroker {
  readonly #queues = new Map<string, OutboundMessage[]>()

  /** The messages of a queue, oldest first. */
  queue(name: string): OutboundMessage[] {
    const messages = this.#queues.get(name) ?? []
    this.#queues.set(name, messages)
    return messages
  }

  /** Stores a message, now or after `delayMs` (the broker's delayed delivery). */
  enqueue(name: string, message: OutboundMessage, delayMs: number): Promise<void> {
    if (delayMs <= 0) this.queue(name).push(message)
    else setTimeout(() => this.queue(name).push(message), delayMs)
    return Promise.resolve() // a real broker confirms the write
  }
}

export interface LocalDriverOptions {
  /** Longest retry delay the runtime waits in-process. Default: 1000 ms. */
  readonly maxInProcessDelayMs?: number
}

export function localDriver(broker: LocalBroker, options: LocalDriverOptions = {}): MessagingDriver {
  return new LocalDriver(broker, options)
}

const MAX_DELAY_MS = 2 ** 31 - 1

class LocalDriver implements MessagingDriver {
  readonly name = 'local'
  readonly capabilities: DriverCapabilities
  readonly #broker: LocalBroker
  readonly #subscriptions = new Set<LocalSubscription>()
  #context: DriverContext | undefined

  constructor(broker: LocalBroker, options: LocalDriverOptions) {
    this.#broker = broker
    this.capabilities = {
      nativeDelay: true, // retries are enqueued again after their delay
      maxNativeDelayMs: MAX_DELAY_MS,
      maxInProcessDelayMs: options.maxInProcessDelayMs ?? 1000,
      deliveryCount: 'header', // attempts travel in the x-znight-attempt header of the copies
      maxPublishDelayMs: MAX_DELAY_MS,
    }
  }

  connect(context: DriverContext): Promise<void> {
    this.#context = context // a real driver opens its connection here
    return Promise.resolve()
  }

  deadLetterName(queue: string): string {
    return `${queue}.dlq`
  }

  publish(queue: string, message: OutboundMessage): Promise<void> {
    return this.#broker.enqueue(queue, message, message.delayMs)
  }

  subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    // a real driver verifies here that `queue` and `options.deadLetterQueue` exist
    const logger = this.#context?.logger
    const subscription = new LocalSubscription(this.#broker, queue, options.concurrency, delivery =>
      handler(delivery).catch((error: unknown) => logger?.error('[local] delivery failed', { error })),
    )
    this.#subscriptions.add(subscription)
    return Promise.resolve(subscription)
  }

  async close(): Promise<void> {
    for (const subscription of this.#subscriptions) await subscription.close()
    this.#subscriptions.clear()
  }
}

class LocalSubscription implements Subscription {
  readonly #inflight = new Set<Promise<void>>()
  readonly #timer: ReturnType<typeof setInterval>

  constructor(broker: LocalBroker, queue: string, concurrency: number, handle: DeliveryHandler) {
    this.#timer = setInterval(() => {
      const messages = broker.queue(queue)
      // back-pressure: never more than `concurrency` deliveries in flight
      while (this.#inflight.size < concurrency && messages.length > 0) {
        const delivery = toDelivery(broker, queue, messages.shift() as OutboundMessage)
        const handled: Promise<void> = handle(delivery).finally(() => this.#inflight.delete(handled))
        this.#inflight.add(handled)
      }
    }, 10)
  }

  cancel(): Promise<void> {
    clearInterval(this.#timer) // stop receiving
    return Promise.resolve()
  }

  async close(): Promise<void> {
    clearInterval(this.#timer)
    await Promise.all(this.#inflight) // the runtime settles what it received
  }
}

function toDelivery(broker: LocalBroker, queue: string, message: OutboundMessage): DriverDelivery {
  return {
    id: message.id,
    body: message.body,
    contentType: message.contentType,
    headers: message.headers,
    type: message.type,
    key: message.key,
    attempt: attemptFromHeaders(message.headers),
    redelivered: false,
    timestamp: message.timestamp,
    raw: message,
    // a received message left the queue: nothing to acknowledge
    ack: () => Promise.resolve(),
    retry: ({ attempt, delayMs }: RetryRequest) => {
      const headers = { ...message.headers, [MessagingHeaders.Attempt]: String(attempt) }
      return broker.enqueue(queue, { ...message, headers }, delayMs)
    },
    deadLetter: (request: DeadLetterRequest) => {
      // `request.queue` is undefined when dead-lettering is disabled: the message is dropped
      if (request.queue === undefined) return Promise.resolve()
      const headers = deadLetterHeaders(message.headers, request, queue)
      return broker.enqueue(request.queue, { ...message, headers }, 0)
    },
    release: () => {
      broker.queue(queue).unshift(message) // back at the head, for a later redelivery
      return Promise.resolve()
    },
  }
}
```

**Conformance kit.** `describeDriverConformance()` of `@znight/messaging/testing` registers the
scenarios every first-party driver passes: publishing and consuming with type routing, headers and
trace context; retries in-process then native; dead letters (last attempt, non-retryable error,
validation) and their headers; concurrency; pending retries released on stop and redelivered after a
restart; delayed publishing honoured, or refused when `maxPublishDelayMs` is `0`. It takes the
`describe` and `it` of your test framework (`bun:test`, Vitest, Jest) and asserts with `node:assert`:

```ts
import { describeDriverConformance } from '@znight/messaging/testing'
import { describe, it } from 'vitest'

import { acme } from '../src/index.ts'

describeDriverConformance({
  name: 'acme',
  // a driver per application; all of them reach the same broker
  driver: overrides => acme({ url: process.env['ACME_URL'], ...overrides }),
  test: { describe, it },
  // for a driver that never creates resources
  prepareQueue: async (queue, deadLetterQueue) => createQueues(queue, deadLetterQueue),
  nativeDelayMs: 1000, // shortest native delay the broker honours precisely
})
```

| Option                            | Default   | Description                                                                                   |
| --------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `name`                            | —         | Name in the scenario names (`acme driver conformance`).                                       |
| `driver(overrides)`               | —         | A driver for one application. Must honour `overrides.maxInProcessDelayMs` (see below).        |
| `test`                            | —         | `{ describe, it }` of the test framework (`it(name, body, timeoutMs)`).                       |
| `prepareQueue(queue, deadLetter)` | none      | Creates a queue and its dead-letter destination before a scenario uses them.                  |
| `consumerOptions(queue)`          | none      | Driver options of `@Consumer` (a consumer group...).                                          |
| `nativeDelayMs`                   | `1000`    | Shortest native retry delay the broker honours precisely (whole seconds for SQS and Pub/Sub). |
| `timeoutMs`                       | `120_000` | Timeout of each scenario; its waits give up a quarter of it (at most 10 s) earlier.           |

`overrides.maxInProcessDelayMs` is the in-process retry budget a scenario needs: the retry scenario
sets it below its second retry delay to force a native retry, the restart scenario above its retry
delay (1 s) so that a retry is pending in-process when the application stops and `release()` must
give it back. A driver that keeps another budget fails these scenarios with an explanation. For an
in-process broker held by the driver instance, return the same instance for the same overrides (it
is connected again after `close()`).

Run it against a real broker (Testcontainers, an emulator) in CI. Each scenario stops the
applications it started, whatever its outcome; its waits give up before `timeoutMs`, so a failure
names what it waited for instead of surfacing as a framework timeout.

**Publishing.** Name the package `znight-messaging-<broker>` (or `@<scope>/znight-messaging-<broker>`)
and export a factory (`acme(options)`) and the driver class. Declare `@znight/messaging` as a peer
dependency on the minor you test against (for instance `^0.7.4`: before 1.0, a minor release may change the
contract, and the changelog says so), and the broker client as a dependency, or as a peer dependency
when applications configure it themselves. Ship ESM, run on Node.js 24+ and Bun 1.3+, and run the
conformance kit in your CI.

## Hooks

```ts
// one delivery (observability uses it for logs, metrics, spans)
app.hooks.wrap('messaging:message', async (event, next) => {
  await next()
  metrics.count(event.queue, event.outcome) // 'ack' | 'retry' | 'dead-letter'; event.error on failure
})

// one publication: add propagation headers before next()
app.hooks.wrap('messaging:publish', (event, next) => {
  event.headers.traceparent = currentTraceParent()
  return next()
})
```

`MessageDeliveryEvent` (from `@znight/core`): `queue`, `type`, `messageId`, `attempt`, `headers`,
`consumer`, `handler`, `message`, `startTime`, `outcome`, `error`. A wrapper that throws before
`next()` (or never calls it) counts as a failed attempt. Listeners (`hooks.on`) receive the completed
events of both hooks (`outcome` / `error` set).

Error reporters listen to the `error:report` hook of `@znight/core` (see the
[Sentry recipe](https://github.com/znight-org/znight/blob/main/docs/guide/plugins.md#report-errors-error-report)): the plugin emits it, when it has listeners, once per delivery dead-lettered or
rejected (whatever the reason; not for the attempts it retries, nor when `@OnError` returns `'ack'`),
with `source: 'messaging'`, `operation` (`orders order.created`), the tags `queue`, `type`,
`messageId`, `consumer`, `handler`, `attempt`, `reason` and `deadLetterQueue`, and the
`InboundMessage`.

## Compiler

`@znight/compiler` loads the `@znight/messaging/compiler` extension automatically (it is declared in the
package manifest) as soon as your code imports `@znight/messaging`. At build time it:

- registers every `@Consumer` class as a provider (singleton unless `scope` says otherwise); consumers
  are roots of the application, so neither they nor their dependencies are reported as unused;
- collects the `@OnMessage` handlers and the `@OnError` method of the class **and of its base
  classes**: an abstract base class can hold shared handlers. The nearest declaration of a method
  wins; an override without messaging decorators keeps the inherited handler (which calls the
  override);
- creates one handler per `@OnMessage` decorator: stack them to handle several types with one method;
- generates a **typed** invoker per handler, so `tsc` checks the handler signature against what is
  injected: the schema output for `@Message(schema)`, `string | undefined` for `@Headers('name')`,
  `Readonly<Record<string, string>>` for `@Headers()`, the `InboundMessage` for `@Ctx()`.

Every parameter of a handler needs `@Message()`, `@Headers()` or `@Ctx()`; optional parameters and
parameters with a default value may have none (they receive `undefined`).

```ts
@Consumer('orders')
export class OrderConsumer extends AuditedConsumer {
  @OnMessage('order.created')
  @OnMessage('order.updated') // same method, two types
  upsert(@Message(Order) order: Order, @Headers('x-tenant') tenant?: string, @Ctx() message?: InboundMessage) {}
}
```

Invalid consumers fail the build with a precise location instead of failing at boot:

- **ZNIGHT005** (invalid decorator usage): decorator on the wrong target; `@Consumer` without queue;
  `@Consumer`, `@Retry` or `@OnError` applied twice; handler the generated code cannot call (static,
  private, protected, `#private`, accessor, computed name, generator); `@OnMessage` and `@OnError` on
  one method; `@Retry` or a parameter decorator outside of an `@OnMessage` handler; several decorators
  on one parameter; a handler parameter decorator imported from another package (`Headers` or `Ctx`
  of `@znight/http`), or a messaging parameter decorator on another extension's handler (an HTTP
  route); rest parameter; `@Message(...)` argument that is not an exported schema (a class,
  an object, an inline expression); invalid `@Headers` name or `@OnMessage` type; messaging methods on
  a class that is neither a consumer nor a base class of one (abstract classes are fine). Warning:
  `@Headers('name')` parameter whose type does not accept `undefined`.
- **ZNIGHT011** (invalid consumer): no handler; several default handlers; two handlers for the same
  type or pattern; a pattern that can never be selected because an earlier pattern matches every type
  it matches (`order.*` declared before `order.created.*`); empty type; invalid `@Retry` options (the
  runtime rules, plus unknown options); invalid `queue`, `scope`, `concurrency` or `deadLetter`;
  handler parameter without decorator; `@OnError` method with more than two required parameters or
  returning something else than `'ack'` or nothing; several `@OnError` methods; several consumers of
  the same queue. Warning: `maxDelay` with `backoff: 'fixed'` (no effect).
- **ZNIGHT017** (unvalidated input, a warning, an error with `strictValidation`): `@Message()` without
  schema on a parameter that is not a primitive (`string`, `number`, literal types...), `unknown` or
  binary (`Uint8Array`, `Buffer`).

```
error ZNIGHT011 src/orders/order.consumer.ts:14:3: @Consumer OrderConsumer: the pattern "order.created.*" of OrderConsumer.created() never matches: every type it matches is matched first by "order.*" (OrderConsumer.any())
  = hint: Patterns are tried in declaration order (after exact types): declare the more specific pattern first
```

Patterns that only partially overlap (`order.*` and `*.created`) are legal: the first declared wins.
Checks that depend on the driver (retry delays longer than its `maxInProcessDelayMs` / native delay
limits, SQS redrive policies) run when the application starts. Scope rules are checked by the core
compiler: a singleton consumer cannot inject the request-scoped `InboundMessage` (ZNIGHT003), use
`@Ctx()`, `Lazy<InboundMessage>` or `scope: 'request'`.

## Compiler contract

The `@znight/messaging/compiler` extension (spec §5, §9.2) generates
`metadata.extensions.messaging: MessagingMetadata`:

```ts
interface MessagingMetadata {
  consumers: {
    token: Token // the consumer provider (registered with the @Consumer scope)
    queue: string
    options?: { concurrency?: number; deadLetter?: string | false; [driverOption: string]: unknown } // @Consumer options minus queue/scope
    handlers: {
      method: string
      type?: string // @OnMessage(type)
      retry?: { attempts: number; backoff: 'fixed' | 'exponential'; delay: number; maxDelay?: number } // @Retry, defaults filled
      paramResolvers?: Token[] // class resolvers of custom parameters (RFC 0010), passed to invoke as `x`
      invoke: (consumer: any, message: InboundMessage, x?: readonly object[]) => unknown
    }[]
    errorHandler?: string // @OnError method name, called as consumer[errorHandler](error, message)
  }[]
}
```

Helpers generated code may call (exported from `@znight/messaging`, stable):

| Helper                                                                                                                                          | Used for                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `validateMessage<S extends StandardSchemaV1>(schema: S, value: unknown, label?: string): InferSchemaOutput<S> \| Promise<InferSchemaOutput<S>>` | `@Message(schema)`: throws `MessageValidationError` (non-retryable). Always `await` it. |
| `messageHeader(message: { headers: Readonly<Record<string, string>> }, name: string): string \| undefined`                                      | `@Headers('name')`                                                                      |
| `DEFAULT_BACKOFF` (`'exponential'`), `DEFAULT_RETRY_DELAY_MS` (`1000`)                                                                          | Defaults to fill in `retry` (the runtime also normalizes missing fields).               |

Parameter extraction in `invoke`: `@Message()` → `m.payload as never` (no schema, ZNIGHT017 when the
type is not primitive); `@Message(S)` → `await validateMessage(S, m.payload)` (the invoker is then
`async`); `@Headers()` → `m.headers`; `@Headers('x')` → `messageHeader(m, 'x')`; `@Ctx()` → `m`
(`m as InboundMessage<never>` when the parameter narrows the payload type); a custom parameter
decorator (`createParamDecorator`, RFC 0010) → `await (D.resolvers.messaging as ParamFunctionOf<typeof
D, 'messaging'>)(m, data)` or `await x[i].resolve(m, data)` for a provider class (`x`: the
instances of `paramResolvers`, resolved in the delivery scope); an optional parameter without
decorator → `undefined` (trailing ones are omitted). The invoker is `async` only when it awaits a
validation or a custom parameter, and its `m` parameter is omitted when the handler has no
argument, `_m` when no argument reads it (only class resolvers whose `resolve()` takes no
parameter), so that it type-checks with `noUnusedParameters`.
Consumers are sorted by token, handlers keep their declaration order (inherited handlers first), and
`options` / `errorHandler` / `type` / `retry` are omitted when absent. Example:

```ts
import type { InboundMessage } from '@znight/messaging'
import { messageHeader, validateMessage } from '@znight/messaging'
import { OrderConsumer, OrderPlaced } from '../orders/order.consumer.js'

extensions: {
  messaging: {
    consumers: [
      {
        token: 'src/orders/order.consumer.ts#OrderConsumer',
        queue: 'orders',
        handlers: [
          {
            method: 'placed',
            type: 'order.placed',
            retry: { attempts: 5, backoff: 'exponential', delay: 500, maxDelay: 30000 },
            invoke: async (c: OrderConsumer, m: InboundMessage) =>
              c.placed(await validateMessage(OrderPlaced, m.payload), messageHeader(m, 'x-tenant')),
          },
        ],
        errorHandler: 'onError',
      },
    ],
  },
}
```

The package manifest declares the externals `@znight/messaging#MessageBroker` (singleton) and
`@znight/messaging#InboundMessage` (request), both provided by `MessagingPlugin`. Compile-time checks
(ZNIGHT011: no handler, duplicate types, overlapping patterns, invalid retry options) mirror the
boot-time checks of the plugin, which also validates retry delays against the driver capabilities.
