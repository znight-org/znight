---
description: "@znight/messaging - message consumers with typed handlers, retries with backoff and dead-letter queues on RabbitMQ, SQS, Kafka or in memory."
---

# @znight/messaging <Badge type="warning" text="in development" />

Message consumers for Znight. Consumers are providers whose handlers are analysed by the compiler;
the `MessagingPlugin` subscribes them through a driver: RabbitMQ, Amazon SQS, Kafka, or in memory for
tests.

<!-- TODO(api): verify against implementation (this page follows the specification; names and options may change) -->

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
import { Consumer, Message, NonRetryableError, OnError, OnMessage, Retry } from '@znight/messaging'
import { z } from 'zod'

export const OrderCreatedSchema = z.object({ orderId: z.string(), total: z.number() })
export type OrderCreated = z.infer<typeof OrderCreatedSchema>

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
    // runs after the last attempt; return 'ack' to drop the message instead of dead-lettering it
  }
}
```

| Decorator                                                                            | Target | Description                                                                |
| ------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------- |
| `@Consumer(queue)` / `@Consumer({ queue, scope?, concurrency?, ...driver options })` | class  | A provider consuming `queue`                                               |
| `@OnMessage(type?)`                                                                  | method | Handles messages whose `type` matches; without `type`, the default handler |
| `@Retry({ attempts, backoff?, delay?, maxDelay? })`                                  | method | Retry policy: `backoff` is `'fixed'` or `'exponential'`                    |
| `@OnError()`                                                                         | method | `(error, message) => void \| 'ack'` after the last failed attempt          |
| `@Message(schema?)`                                                                  | param  | The payload, validated by the schema when given                            |
| `@Headers(name?)`                                                                    | param  | A header, or all headers                                                   |
| `@Ctx()`                                                                             | param  | The `InboundMessage`                                                       |

The compiler checks consumers ([`ZNIGHT011`](/reference/error-codes#znight011)): a consumer needs a
handler, two handlers cannot match the same type, retry options must be valid.

## Delivery semantics

Delivery is **at least once**: handlers must be idempotent.

1. Each delivery runs in its own [request scope](/guide/scopes#request-scopes) (`InboundMessage` is a
   request-scoped external) through the `messaging:message` hook.
2. The handler is selected by `message.type` (a header or the routing key, depending on the driver).
   No match → dead-letter with a reason.
3. Success → **ack**.
4. `NonRetryableError` or a schema failure → **dead-letter** immediately.
5. Other failures → **retry**, counting attempts from the broker (`ApproximateReceiveCount`,
   `x-delivery-count`) or an `x-znight-attempt` header. Short delays wait in process (within the
   driver's budget); longer ones use the broker's native mechanism (SQS visibility timeout, RabbitMQ
   TTL + dead-letter exchange retry queue, Kafka retry topic). The application refuses to boot if a
   `@Retry` policy cannot be honoured by the driver.
6. After the last attempt, `@OnError` runs: returning `'ack'` drops the message, anything else (or a
   throw) dead-letters it. The original message is acked only once the dead-letter publish is
   confirmed.

On shutdown, consumers stop pulling, in-flight handlers are awaited and pending retries are
requeued: messages are never dropped.

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

`publish(queue, payload, { type?, headers?, key? })`; `key` is the partition key for Kafka.

## Drivers

| Driver     | Import                       | Peer dependency       | Native delayed retries     |
| ---------- | ---------------------------- | --------------------- | -------------------------- |
| In memory  | `@znight/messaging/memory`   | —                     | in process                 |
| RabbitMQ   | `@znight/messaging/rabbitmq` | `amqplib`             | TTL + dead-letter exchange |
| Amazon SQS | `@znight/messaging/sqs`      | `@aws-sdk/client-sqs` | visibility timeout         |
| Kafka      | `@znight/messaging/kafka`    | `@platformatic/kafka` | retry topic                |

A driver implements `MessagingDriver { name, capabilities, connect(), subscribe(), publish(), close() }`;
`capabilities` (`nativeDelay`, `maxInProcessDelayMs`, `deliveryCount`) let the plugin validate retry
policies at boot.

## Concurrency

`@Consumer({ queue: 'orders', concurrency: 10 })` processes up to ten messages of that consumer at
once. Each delivery has its own scope, so request-scoped providers are never shared between messages.

## Testing

Use the in-memory driver with [`TestApp`](/guide/testing#testapp-end-to-end-tests) to publish
messages and assert on outcomes without a broker. Integration tests against real brokers can use
Testcontainers.
