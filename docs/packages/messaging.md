---
description: "@znight/messaging - message consumers with typed handlers, retries with backoff and dead-letter queues on RabbitMQ, SQS, Kafka, Google Cloud Pub/Sub, Azure Service Bus or in memory."
---

# @znight/messaging <Badge type="tip" text="available" />

Message consumers for Znight. Consumers are providers whose handlers are analysed by the compiler;
the `MessagingPlugin` subscribes them through a driver: RabbitMQ, Amazon SQS, Kafka, Google Cloud
Pub/Sub, Azure Service Bus, or in memory for tests. Runs on Node.js 24+ and Bun 1.3+.

```sh
npm install @znight/messaging amqplib   # or @aws-sdk/client-sqs, @platformatic/kafka, @google-cloud/pubsub, @azure/service-bus
```

::: code-group

```ts [src/main.ts]
import { Application } from '@znight/core'
import { MessagingPlugin } from '@znight/messaging'
import { rabbitmq } from '@znight/messaging/rabbitmq'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [MessagingPlugin.configure({ driver: rabbitmq({ url: 'amqp://localhost' }) })],
})
await app.start()
```

:::

## Consumers

```ts
import { Consumer, type InboundMessage, Message, NonRetryableError, OnError, OnMessage, Retry } from '@znight/messaging'
import { z } from 'zod'

export const OrderCreatedSchema = z.object({ orderId: z.string(), total: z.number() })
export type OrderCreated = z.output<typeof OrderCreatedSchema>

@Consumer('orders')
export class OrderConsumer {
  constructor(private readonly orders: OrderService) {}

  @OnMessage('order.created')
  @Retry({ attempts: 5, backoff: 'exponential', delay: 1_000, maxDelay: 60_000 })
  async onCreated(@Message(OrderCreatedSchema) event: OrderCreated) {
    if (event.total < 0) throw new NonRetryableError('negative total') // straight to the dead-letter queue
    await this.orders.process(event)
  }

  @OnMessage() // default handler: messages without a more specific match
  async onOther(@Message() payload: unknown) {}

  @OnError()
  onFailure(error: unknown, message: InboundMessage): 'ack' | void {
    // the message will not be retried anymore; return 'ack' to drop it instead of dead-lettering it
  }
}
```

| Decorator                                                                                         | Target | Description                                                                                                      |
| ------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `@Consumer(queue)` / `@Consumer({ queue, scope?, concurrency?, deadLetter?, ...driver options })` | class  | A provider (singleton by default, `scope: 'request'` for one instance per message) consuming `queue`             |
| `@OnMessage(type?)`                                                                               | method | Handles messages of `type` (exact, or a pattern where `*` matches anything); without `type`, the default handler |
| `@Retry({ attempts, backoff?, delay?, maxDelay? })`                                               | method | Retry policy: `attempts` counts the first delivery; `backoff` is `'fixed'` or `'exponential'` (default)          |
| `@OnError()`                                                                                      | method | `(error, message) => void \| 'ack'` when a message will not be retried anymore                                   |
| `@Message(schema?)`                                                                               | param  | The payload, validated by a Standard Schema (Zod, Valibot...) when given                                         |
| `@Headers(name?)`                                                                                 | param  | All headers, or one header                                                                                       |
| `@Ctx()`                                                                                          | param  | The `InboundMessage`                                                                                             |

The compiler checks consumers ([`ZNIGHT011`](/reference/error-codes#znight011)): a consumer needs a
handler, two handlers cannot match the same type, retry options must be valid, a queue is consumed
by a single `@Consumer` class. A `@Message()` parameter without schema is
[`ZNIGHT017`](/reference/error-codes#znight017) (a warning, an error with `strictValidation`).

## Delivery semantics

Delivery is **at least once**: handlers must be idempotent.

![Message delivery: receive, request scope with the InboundMessage, decode, select the handler by type, invoke (validate, then the handler). Success: ack. A failure with attempts left: retry, waiting in process or delayed by the broker, then redelivered. A terminal failure (last attempt, NonRetryableError, invalid payload, undecodable body, no matching handler): @OnError returning 'ack' drops the message, otherwise it is dead-lettered (copy published and confirmed, then ack; released and redelivered if the publish fails)](/diagrams/messaging-delivery.svg)

1. Each delivery runs in its own [request scope](/guide/scopes#request-scopes) (`InboundMessage` is a
   request-scoped external) through the `messaging:message` hook.
2. The handler is selected by `message.type`: exact match, then patterns, then the default handler.
3. Success → **ack**.
4. A retryable failure with attempts left → **retry** as `attempt + 1`, attempts being counted by the
   broker (`ApproximateReceiveCount`, `x-delivery-count`, `deliveryAttempt`, `deliveryCount`) or an `x-znight-attempt` header. Short
   delays are waited in process (within the driver's budget) and the message is then redelivered
   through the broker; longer ones use the broker's native mechanism (SQS visibility timeout,
   RabbitMQ delay queues, Kafka retry topic, Pub/Sub ack deadline, Service Bus scheduled copy). The application refuses to boot
   ([`ZNIGHT011`](/reference/error-codes#znight011)) if a `@Retry` policy cannot be honoured by the
   driver.
5. A terminal failure — last attempt, `NonRetryableError`, schema failure (`MessageValidationError`),
   undecodable body, no matching handler — runs `@OnError`: returning `'ack'` drops the message,
   anything else (or a throw) **dead-letters** it. The original message is acked only once the
   dead-letter publish is confirmed; if that publish fails, the message is released and redelivered.

The dead-letter copy keeps the body, type, id and headers and adds `x-znight-dead-letter-reason`,
`x-znight-error`, `x-znight-original-queue` and `x-znight-attempts`. On shutdown, consumers stop
receiving, in-process retry delays are aborted (those messages are released to the broker),
`message.signal` is aborted and in-flight handlers are awaited: messages are never dropped.

## Publishing

`MessageBroker` is provided by the plugin; inject it anywhere:

```ts
import { MessageBroker } from '@znight/messaging'

@Injectable()
export class CheckoutService {
  constructor(private readonly broker: MessageBroker) {}

  async complete(order: Order) {
    await this.broker.publish('orders', { orderId: order.id, total: order.total }, { type: 'order.created' })
  }
}
```

`publish(queue, payload, { type?, headers?, key?, delay?, id?, contentType? })` resolves with `{ id }`
once the broker **confirmed** the message; `key` is the Kafka partition key, the SQS FIFO group or the
Pub/Sub ordering key or the Service Bus session id, `delay` is not supported by Kafka nor Pub/Sub.

## Drivers

| Driver               | Import                                | Peer dependency        | Native delayed retries     |
| -------------------- | ------------------------------------- | ---------------------- | -------------------------- |
| In memory            | `@znight/messaging/memory`            | —                      | in process                 |
| RabbitMQ             | `@znight/messaging/rabbitmq`          | `amqplib`              | TTL + dead-letter exchange |
| Amazon SQS           | `@znight/messaging/sqs`               | `@aws-sdk/client-sqs`  | visibility timeout         |
| Kafka                | `@znight/messaging/kafka`             | `@platformatic/kafka`  | retry topic                |
| Google Cloud Pub/Sub | `@znight/messaging/pubsub`            | `@google-cloud/pubsub` | ack deadline (≤ 600 s)     |
| Azure Service Bus    | `@znight/messaging/azure-service-bus` | `@azure/service-bus`   | scheduled messages         |

A driver implements
`MessagingDriver { name, capabilities, connect(), subscribe(), publish(), close(), deadLetterName() }`;
`capabilities` (`nativeDelay`, `maxNativeDelayMs`, `maxInProcessDelayMs`, `deliveryCount`,
`maxPublishDelayMs`) let the plugin validate retry policies at boot. OCI Streaming and Azure Event Hubs work
through the Kafka driver ([below](#oracle-cloud-infrastructure-streaming)); for another broker,
[write your own driver](#writing-your-own-driver).

`MessagingPlugin.configure({ driver, defaults?, codec?, consume? })`: `defaults.retry` (3 attempts,
exponential from 1 s, capped at 30 s; `false` = a single attempt), `defaults.concurrency` (1),
`defaults.deadLetter` (`(queue) => name` or `false`), `defaults.requeueDelay` (1 s); `consume: false`
for publish-only processes. Options may be a function of the container; invalid options fail
`Application.create()` with [`ZNIGHT011`](/reference/error-codes#znight011).

While consumers are subscribed (from `onStart` to the end of `onStop`), the plugin keeps the process
alive: a worker whose only ingress is a consumer does not exit after `app.start()`, whatever the
driver (the in-memory one holds no socket), and stops through `app.stop()` or a signal.

Driver highlights (details in the
[package README](https://github.com/znight-org/znight/tree/main/packages/messaging#drivers)):

- **RabbitMQ**: delayed publications go through 32 delay levels shared by every queue of the
  virtual host (`znight.delays.0` to `.31`, option `delayLevelPrefix`), never a queue per delay;
  retries use per-delay queues bounded by your `@Retry` policies. On RabbitMQ 4+, declared quorum
  queues get `x-delivery-limit: -1` (Znight counts the attempts; an existing queue without it gets a
  warning recommending a `delivery-limit` policy). Lost connections, closed channels and consumers
  cancelled by the broker are recovered, with backoff, until every consumer consumes again.
- **Kafka**: records fetched again after a rebalance are skipped (commits never move back), and the
  retry stream has its own back-pressure, so waiting retries never pause the main topic.
- **SQS**: the lease extension stops before each settlement, so it never overrides a retry delay.
- **Pub/Sub**: `publish(queue)` targets a topic and `@Consumer(queue)` a subscription (same name by
  default, `topics` / `subscriptions` to map them). Attempts come from `deliveryAttempt` (subscriptions
  with a dead-letter policy). `retries: 'znight'` (default) applies `@Retry` and publishes Znight dead
  letters; `retries: 'subscription'` nacks every failure so that the subscription's retry and
  dead-letter policies own redelivery, never both layers at once (a consumer can only take the
  ownership back, with `@Consumer({ queue, retries: 'znight' })`). No delayed publishing; topics and
  subscriptions are only created with `provision: true` (`PUBSUB_EMULATOR_HOST` targets the emulator).

```ts
import { MessagingPlugin } from '@znight/messaging'
import { pubsub } from '@znight/messaging/pubsub'

MessagingPlugin.configure({
  driver: pubsub({ retries: 'subscription', subscriptions: { notifications: 'events-notifications' } }),
  defaults: { retry: { attempts: 5, backoff: 'fixed', delay: 0 } }, // the subscription's maxDeliveryAttempts
})
```

- **Azure Service Bus**: `publish(queue)` sends to a queue or a topic, `@Consumer(queue)` receives
  from a queue, a topic subscription (`orders/billing`) or a dead-letter sub-queue
  (`orders/$deadletterqueue`); `entities` / `subscriptions` map the names. Peek-lock receives, the
  lock renewed while a message is handled; attempts combine the delivery count and `x-znight-attempt`.
  `retries: 'znight'` (default) abandons for an immediate retry, schedules a copy on the queue for a
  delayed one (a subscription keeps the message locked during the delay instead), and dead-letters to
  the entity's native sub-queue; `retries: 'entity'` abandons every retryable failure so that
  `maxDeliveryCount` and the sub-queue own redelivery, and dead-letters terminal failures
  (non-retryable, validation, decoding, no handler) to the sub-queue at once. Delayed publishing schedules the message;
  `key` is the session id (session-enabled entities are refused for now). Connection string, or
  `fullyQualifiedNamespace` with a credential (`DefaultAzureCredential` of `@azure/identity` by
  default). Entities are checked with the administration client and only created with
  `provision: true`; the opt-in tests run the conformance kit against the Service Bus emulator.

```ts
import { MessagingPlugin } from '@znight/messaging'
import { azureServiceBus } from '@znight/messaging/azure-service-bus'

MessagingPlugin.configure({
  driver: azureServiceBus({
    fullyQualifiedNamespace: 'acme.servicebus.windows.net', // DefaultAzureCredential
    subscriptions: { billing: 'orders/billing' }, // @Consumer('billing') reads the subscription
  }),
})
```

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
[specification §9.2](/contributing/architecture)). Drivers are runtime-only: no compiler extension, no manifest, just a package
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

## Concurrency

`@Consumer({ queue: 'orders', concurrency: 10 })` processes up to ten messages of that consumer at
once. Each delivery has its own scope, so request-scoped providers are never shared between messages.

## Testing

Use the in-memory driver with [`TestApp`](/guide/testing#messages) to send messages and assert on
outcomes without a broker:

```ts
const driver = memory()
await using app = await TestApp.create({ metadata, plugins: [MessagingPlugin.configure({ driver })] })

driver.send('orders', { payload: { orderId: '1', total: 10 }, type: 'order.created' })
await driver.idle()
expect(driver.settlements('orders')).toMatchObject([{ action: 'ack' }])
```

`driver.published()`, `driver.deadLetters()`, `driver.pending()` and `driver.fail()` (failure
injection) complete it. Integration tests against real brokers can use Testcontainers.
