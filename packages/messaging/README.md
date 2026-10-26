# @znight/messaging

Message consumers and publishing for [Znight](../../README.md): retries with backoff, dead-letter
queues, per-consumer concurrency and graceful shutdown, on **RabbitMQ**, **Amazon SQS** or **Kafka**
(plus an in-memory broker for tests and local development).

Like the rest of Znight, consumers are discovered **at build time**: `@znight/compiler` (with the
`@znight/messaging/compiler` extension) reads the decorators and generates the consumer metadata. At
runtime `MessagingPlugin` only executes it.

```sh
bun add @znight/messaging
bun add amqplib              # RabbitMQ driver
bun add @aws-sdk/client-sqs  # SQS driver
bun add @platformatic/kafka  # Kafka driver
```

Runs on Node.js >= 24 and Bun >= 1.3. Broker clients are optional peer dependencies: install only the
one you use.

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
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'

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
         │                          └─ or native delayed redelivery (SQS visibility, RabbitMQ delay queue, Kafka retry topic)
         └─ NonRetryableError / invalid payload / undecodable body / no handler / last attempt
              └─► @OnError ─ 'ack' ─► ack
                           └─ otherwise (or throws) ─► dead-letter: publish (confirmed) then ack
                                                       └─ publish failed ─► release (redelivered later)
```

- **Nothing is dropped**: every path ends with the broker owning the message (acknowledged,
  republished, dead-lettered or released). A settlement failure (connection loss) leaves the message
  unacknowledged, so the broker redelivers it.
- **Attempts** are counted by the broker (SQS `ApproximateReceiveCount`, RabbitMQ quorum
  `x-delivery-count`) and/or the `x-znight-attempt` header of republished retries
  (`message.attempt`, 1-based). A redelivery beyond the last attempt is dead-lettered without calling
  the handler.
- **Ordering** is not guaranteed across retries. Kafka keeps the order of a partition (records of a
  partition are handled one at a time); SQS FIFO keeps the order of a message group.

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
locked: prefetch slot, SQS lease) then the message is redelivered; longer delays use the broker's
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
queue's `RedrivePolicy`). The copy keeps the body, type, id and headers (without `x-znight-attempt`, so
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
dead-lettering: RabbitMQ rejects the message (a queue DLX policy applies), SQS and Kafka discard it.

### Concurrency and graceful shutdown

`concurrency` (default `defaults.concurrency`, 1) bounds the messages a consumer handles at once
(RabbitMQ prefetch, SQS receive batches, Kafka partitions handled in parallel).

`app.stop()` (or SIGTERM) stops receiving, aborts in-process retry delays (those messages are released
to the broker, never dropped), aborts `message.signal`, waits for the handlers in flight, then closes
the connections. Keep handlers shorter than `shutdown.hookTimeoutMs` (5 s by default) or raise it.

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
  key: string | undefined // Kafka key, SQS FIFO group
  attempt: number // 1-based
  maxAttempts: number
  redelivered: boolean
  timestamp: number | undefined // produced at (epoch ms)
  receivedAt: number
  contentType: string | undefined
  body: Uint8Array | string // raw body
  driver: string
  raw: unknown // amqplib ConsumeMessage, SQS Message, Kafka Message...
  signal: AbortSignal // aborted on shutdown
}
```

## Publishing

`MessageBroker` is a singleton external: inject it anywhere (or `app.get(MessageBroker)`).

```ts
const { id } = await broker.publish('orders', order, {
  type: 'order.placed', // handler selection
  headers: { 'x-tenant': 'acme' }, // string values
  key: order.customerId, // Kafka partition key / SQS FIFO group
  delay: 5_000, // ms (RabbitMQ, SQS ≤ 15 min, memory; not Kafka)
  id: order.id, // default: random UUID
})
```

`publish()` resolves once the broker **confirmed** the message (publisher confirms, SQS response, Kafka
acks from all in-sync replicas). Payloads are JSON-encoded; `Uint8Array` is sent as
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

| Option                  | Default                      | Description                                                           |
| ----------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `driver`                | —                            | `memory()`, `rabbitmq()`, `sqs()` or `kafka()` (from their subpaths). |
| `defaults.retry`        | 3 attempts, 1 s exp., ≤ 30 s | Policy of handlers without `@Retry`; `false` disables retries.        |
| `defaults.concurrency`  | `1`                          | Concurrency of consumers without `concurrency`.                       |
| `defaults.deadLetter`   | driver naming                | `(queue) => name`, or `false` to disable dead-lettering.              |
| `defaults.requeueDelay` | `1000`                       | Pause (ms) before releasing a message whose settlement failed.        |
| `codec`                 | `jsonCodec`                  | `{ encode(payload, contentType), decode(body, contentType) }`.        |
| `consume`               | `true`                       | `false` for publish-only processes (consumers are not subscribed).    |

The plugin (`name: 'messaging'`) exposes `broker`, `driver` and `consumers()` (state, in-flight count,
dead-letter queue of each consumer).

## Drivers

| Capability             | memory    | RabbitMQ                                | SQS                              | Kafka                                |
| ---------------------- | --------- | --------------------------------------- | -------------------------------- | ------------------------------------ |
| Subpath                | `/memory` | `/rabbitmq`                             | `/sqs`                           | `/kafka`                             |
| Client (optional peer) | —         | `amqplib` ^2                            | `@aws-sdk/client-sqs` ^3         | `@platformatic/kafka` ^2             |
| Attempt counting       | native    | `x-znight-attempt` + `x-delivery-count` | `ApproximateReceiveCount`        | `x-znight-attempt`                   |
| Native retry delay     | timers    | delay queues (TTL + DLX), ≤ 49 days     | visibility timeout, ≤ 12 h       | retry topic, ≤ `maxRetryDelayMs`     |
| In-process budget      | 1 s       | 5 s                                     | 1 s                              | 0 (always the retry topic)           |
| Delayed publish        | yes       | yes (delay queues)                      | ≤ 15 min (not FIFO)              | no                                   |
| Dead letters           | `<q>.dlq` | `<q>.dlq` (publish confirmed + ack)     | `<q>-dlq` / RedrivePolicy target | `<topic>.dlq` (acks all + commit)    |
| Ordering               | FIFO      | none across retries                     | FIFO groups                      | per partition                        |
| Topology               | implicit  | declared (`assertTopology`) or verified | verified (queues must exist)     | verified or created (`createTopics`) |

### Memory

Deterministic in-process broker: FIFO queues, round-robin between competing subscribers, delays,
native delivery counts, dead-letter queues. Ideal for tests:

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

| Option                | Default                                      | Description                                                                 |
| --------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| `url`                 | —                                            | AMQP URL or amqplib connection options.                                     |
| `socketOptions`       | —                                            | TLS / socket options.                                                       |
| `assertTopology`      | `true`                                       | Declare consumed, dead-letter and delay queues; `false`: verify they exist. |
| `queueType`           | `'quorum'`                                   | Type of declared queues (`'classic'` for existing classic queues).          |
| `queueArguments`      | —                                            | Extra arguments of declared queues.                                         |
| `maxInProcessDelayMs` | `5000`                                       | Longest retry delay waited in-process.                                      |
| `delayQueueName`      | `` `${q}.delay.${ms}` ``                     | Delay queue naming.                                                         |
| `deadLetterName`      | `` `${q}.dlq` ``                             | Default dead-letter queue.                                                  |
| `mandatory`           | `true`                                       | Fail `publish()` when no queue receives the message.                        |
| `persistent`          | `true`                                       | Persistent messages.                                                        |
| `typeFromRoutingKey`  | `false`                                      | Use the routing key as type for messages without type (topic exchanges).    |
| `reconnect`           | `{ initialDelayMs: 100, maxDelayMs: 30000 }` | Reconnection with exponential backoff; `false` disables.                    |
| `connectionName`      | `'znight'`                                   | Connection name in the management UI.                                       |

Publishing goes through a confirm channel and the default exchange (routing key = queue). Each
consumer has its own channel with `prefetch = concurrency`. Retries are republished copies carrying
`x-znight-attempt` (to the queue, or to a per-delay queue `orders.delay.2000` whose TTL dead-letters
back into `orders`, so delays never block each other); quorum delay queues use at-least-once
dead-lettering. The type is read from the `type` property (then `x-znight-type`), the id from
`message-id`. After a connection loss the driver reconnects and resumes the consumers; messages in
flight on the lost connection are redelivered by RabbitMQ.

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
order. IAM permissions: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`,
`sqs:SendMessage`, `sqs:GetQueueUrl`, `sqs:GetQueueAttributes`.

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
| `maxRetryDelayMs`     | 15 min                 | Longest wait of a retry record.                                                 |

`@Consumer({ queue: 'orders', groupId: 'billing-orders' })` overrides the group of one consumer (two
consumers cannot share a group). Offsets are committed manually, once a record is settled; records of
a partition are handled sequentially, partitions concurrently (`concurrency`). Retries are
non-blocking: the record goes to the group's retry topic with `x-znight-not-before`; a dedicated
consumer (group `<group>.retry`, always from the beginning) waits until then without holding a
concurrency slot. On shutdown, unsettled records are not committed and are consumed again later.

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

## Writing a driver

Implement `MessagingDriver` (`name`, `capabilities`, `connect`, `subscribe`, `publish`, `close`,
`deadLetterName`). `subscribe` receives a `DeliveryHandler`: call it for each message with a
`DriverDelivery` exposing `ack`, `retry({ attempt, delayMs })`, `deadLetter({ queue, reason, error,
attempt })` and `release()`; never have more pending handler promises than `options.concurrency`.
The runtime calls exactly one settlement (then possibly `release` when it failed), so operations must
only be marked done once the broker confirmed them. The `drivers/shared.ts` helpers
(`deadLetterHeaders`...) and the integration conformance suite (`test/integration/conformance.ts`)
document the expected behaviour.

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
      invoke: (consumer: any, message: InboundMessage) => unknown
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
(`m as InboundMessage<never>` when the parameter narrows the payload type). Example:

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
