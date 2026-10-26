---
description: "@znight/messaging - message consumers with typed handlers, retries with backoff and dead-letter queues on RabbitMQ, SQS, Kafka or in memory."
---

# @znight/messaging <Badge type="tip" text="available" />

Message consumers for Znight. Consumers are providers whose handlers are analysed by the compiler;
the `MessagingPlugin` subscribes them through a driver: RabbitMQ, Amazon SQS, Kafka, or in memory for
tests. Runs on Node.js 24+ and Bun 1.3+.

```sh
npm install @znight/messaging amqplib   # or @aws-sdk/client-sqs, or @platformatic/kafka
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

1. Each delivery runs in its own [request scope](/guide/scopes#request-scopes) (`InboundMessage` is a
   request-scoped external) through the `messaging:message` hook.
2. The handler is selected by `message.type`: exact match, then patterns, then the default handler.
3. Success → **ack**.
4. A retryable failure with attempts left → **retry** as `attempt + 1`, attempts being counted by the
   broker (`ApproximateReceiveCount`, `x-delivery-count`) or an `x-znight-attempt` header. Short
   delays are waited in process (within the driver's budget) and the message is then redelivered
   through the broker; longer ones use the broker's native mechanism (SQS visibility timeout,
   RabbitMQ delay queues, Kafka retry topic). The application refuses to boot
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
once the broker **confirmed** the message; `key` is the Kafka partition key or the SQS FIFO group,
`delay` is not supported by Kafka.

## Drivers

| Driver     | Import                       | Peer dependency       | Native delayed retries     |
| ---------- | ---------------------------- | --------------------- | -------------------------- |
| In memory  | `@znight/messaging/memory`   | —                     | in process                 |
| RabbitMQ   | `@znight/messaging/rabbitmq` | `amqplib`             | TTL + dead-letter exchange |
| Amazon SQS | `@znight/messaging/sqs`      | `@aws-sdk/client-sqs` | visibility timeout         |
| Kafka      | `@znight/messaging/kafka`    | `@platformatic/kafka` | retry topic                |

A driver implements
`MessagingDriver { name, capabilities, connect(), subscribe(), publish(), close(), deadLetterName() }`;
`capabilities` (`nativeDelay`, `maxNativeDelayMs`, `maxInProcessDelayMs`, `deliveryCount`,
`maxPublishDelayMs`) let the plugin validate retry policies at boot.

`MessagingPlugin.configure({ driver, defaults?, codec?, consume? })`: `defaults.retry` (3 attempts,
exponential from 1 s, capped at 30 s; `false` = a single attempt), `defaults.concurrency` (1),
`defaults.deadLetter` (`(queue) => name` or `false`), `defaults.requeueDelay` (1 s); `consume: false`
for publish-only processes. Options may be a function of the container; invalid options fail
`Application.create()` with [`ZNIGHT011`](/reference/error-codes#znight011).

While consumers are subscribed (from `onStart` to the end of `onStop`), the plugin keeps the process
alive: a worker whose only ingress is a consumer does not exit after `app.start()`, whatever the
driver (the in-memory one holds no socket), and stops through `app.stop()` or a signal.

Driver highlights (details in the
[package README](https://github.com/ugho49/Znight/tree/main/packages/messaging#drivers)):

- **RabbitMQ**: delayed publications go through 32 delay levels shared by every queue of the
  virtual host (`znight.delays.0` to `.31`, option `delayLevelPrefix`), never a queue per delay;
  retries use per-delay queues bounded by your `@Retry` policies. On RabbitMQ 4+, declared quorum
  queues get `x-delivery-limit: -1` (Znight counts the attempts; an existing queue without it gets a
  warning recommending a `delivery-limit` policy). Lost connections, closed channels and consumers
  cancelled by the broker are recovered, with backoff, until every consumer consumes again.
- **Kafka**: records fetched again after a rebalance are skipped (commits never move back), and the
  retry stream has its own back-pressure, so waiting retries never pause the main topic.
- **SQS**: the lease extension stops before each settlement, so it never overrides a retry delay.

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
