---
description: Consume and publish messages with @znight/messaging - choose a driver, write consumers, validate payloads, handle failures with retries and dead letters, idempotency, concurrency, workers, shutdown and tests with the in-memory driver.
---

# Messaging

`@znight/messaging` turns classes into **message consumers** and gives every provider a
`MessageBroker` to publish with. The compiler checks consumers at build time (handlers, retry
policies, one consumer per queue); the `MessagingPlugin` subscribes them through a driver: RabbitMQ,
Amazon SQS, Kafka, Google Cloud Pub/Sub, NATS JetStream, Azure Service Bus, Redis Streams, or in
memory. Consumers do not depend on the broker: switching drivers changes one line.

This page shows how to build consumers and workers. The [package reference](/packages/messaging)
lists the decorators, plugin options, every driver and how to write your own.

## Choose a driver {#drivers}

| You run                                | Driver                                                      | Why                                                                          |
| -------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Tests, local development               | `memory()` (`@znight/messaging/memory`)                     | No broker; a test drives and inspects it                                     |
| Task queues on your own infrastructure | `rabbitmq()` (`@znight/messaging/rabbitmq`)                 | Queues, native delayed retries, recovery after connection losses             |
| AWS                                    | `sqs()` (`@znight/messaging/sqs`)                           | Managed queues, retries through the visibility timeout                       |
| Event streams, replay, high throughput | `kafka()` (`@znight/messaging/kafka`)                       | Ordered partitions, consumer groups; also OCI Streaming and Azure Event Hubs |
| Google Cloud                           | `pubsub()` (`@znight/messaging/pubsub`)                     | Topics and subscriptions, retries by Znight or by the subscription           |
| NATS                                   | `nats()` (`@znight/messaging/nats`)                         | JetStream durable consumers, deduplicated publishing                         |
| Azure                                  | `azureServiceBus()` (`@znight/messaging/azure-service-bus`) | Queues and topic subscriptions, native dead-letter sub-queues                |
| Redis or Valkey already in your stack  | `redis()` (`@znight/messaging/redis`)                       | Streams and consumer groups, no other broker to operate                      |

Each driver needs its client as an optional peer dependency (`amqplib`, `@aws-sdk/client-sqs`,
`@platformatic/kafka`...): the [drivers table](/packages/messaging#drivers) lists them, with what
each one does natively.

```ts
import { MessagingPlugin } from '@znight/messaging'
import { rabbitmq } from '@znight/messaging/rabbitmq'
import { createApplication } from './.znight/container.generated.js'

const app = await createApplication({
  plugins: [MessagingPlugin.configure({ driver: rabbitmq({ url: 'amqp://localhost' }) })],
})
await app.start()
```

Choose the driver from configuration with the function form of the options,
`MessagingPlugin.configure(container => ({ driver: ... }))`: the `worker` example uses RabbitMQ when
`RABBITMQ_URL` is set and the in-memory driver otherwise.

## Write a consumer {#consumers}

A consumer is a provider whose methods handle the messages of one queue. Like every provider, it is
found by the compiler. From the `worker` example:

<!-- sample: examples/worker/src/emails/email.consumer.ts -->

```ts
import type { ErrorHandlerResult, InboundMessage } from '@znight/messaging'
import type { Logger } from '@znight/observability'
import type { EmailService } from './email.service.js'
import type { SuppressionList } from './suppression.list.js'

import { Consumer, Ctx, Message, OnError, OnMessage, Retry } from '@znight/messaging'

import { EMAILS_QUEUE, SEND_EMAIL, SendEmailJob } from './email.jobs.js'
import { RecipientRejectedError } from './smtp.client.js'

/**
 * Consumes the "emails.send" queue.
 *
 * - `concurrency: 4`: up to four emails in flight (sending is I/O bound). Static, like every
 *   decorator argument: read by the compiler (`EMAILS_QUEUE` is a `const` from another file).
 * - Delivery is at-least-once: EmailService passes the message id to the SMTP server, which ignores
 *   a Message-ID it already accepted.
 * - Dead letters go to `emails.send.dlq` (the driver's default naming).
 */
@Consumer({ queue: EMAILS_QUEUE, concurrency: 4 })
export class EmailConsumer {
  constructor(
    private readonly emails: EmailService,
    private readonly suppressions: SuppressionList,
    private readonly logger: Logger,
  ) {}

  /**
   * `@Message(SendEmailJob)`: the payload is validated by the Zod schema before the handler runs; an
   * invalid payload is dead-lettered at once (reason `validation`), never retried. `job` is the
   * schema output (`locale` and `data` defaulted).
   *
   * `@Retry`: 4 attempts in total, waiting 250 ms, 500 ms then 1 s between them. Errors are retried
   * unless they are `NonRetryableError`s (RecipientRejectedError, a template variable missing...).
   */
  @OnMessage(SEND_EMAIL)
  @Retry({ attempts: 4, backoff: 'exponential', delay: 250, maxDelay: 2_000 })
  async send(@Message(SendEmailJob) job: SendEmailJob, @Ctx() message: InboundMessage): Promise<void> {
    await this.emails.send(job, message.id)
  }

  /**
   * Called once a message will not be retried anymore (non-retryable error, invalid payload, last
   * attempt failed). Returning `'ack'` acknowledges it; anything else dead-letters it.
   *
   * A hard bounce is an expected outcome, not an incident: the address is suppressed and the message
   * acknowledged. Everything else goes to the dead-letter queue, to be inspected and replayed.
   */
  @OnError()
  onError(error: unknown, message: InboundMessage): ErrorHandlerResult {
    if (error instanceof RecipientRejectedError) {
      this.suppressions.add(error.recipient, `SMTP ${error.smtpCode}`)
      this.logger.warn('Hard bounce: recipient suppressed', { recipient: error.recipient, jobId: message.id })
      return 'ack'
    }
    return undefined
  }
}
```

- `@OnMessage(type)` handles the messages of one type (exact, or a pattern where `*` matches
  anything); `@OnMessage()` without type is the default handler of the queue.
- Parameters: `@Message(schema?)` the payload, `@Headers(name?)` the headers, `@Ctx()` the
  `InboundMessage` (id, type, attempt, `signal`...).
- The compiler checks consumers ([`ZNIGHT011`](/reference/error-codes#znight011)): a consumer needs
  a handler, two handlers cannot match the same type, retry options must be valid, and a queue is
  consumed by a single `@Consumer` class.

## Validate payloads {#validation}

`@Message(schema)` validates the payload with any Standard Schema library before the handler runs;
the handler receives the schema output. An invalid payload is a terminal failure: it goes straight
to `@OnError` and the dead-letter queue, it is never retried (retrying would fail the same way).
A `@Message()` without schema is reported by the compiler
([`ZNIGHT017`](/reference/error-codes#znight017)). The [Validation guide](./validation) covers
schemas for every transport.

## Handle failures {#failures}

A handler that throws is retried, then dead-lettered:

![Message delivery: receive, request scope with the InboundMessage, decode, select the handler by type, invoke (validate, then the handler). Success: ack. A failure with attempts left: retry, waiting in process or delayed by the broker, then redelivered. A terminal failure (last attempt, NonRetryableError, invalid payload, undecodable body, no matching handler): @OnError returning 'ack' drops the message, otherwise it is dead-lettered (copy published and confirmed, then ack; released and redelivered if the publish fails)](/diagrams/messaging-delivery.svg)

- **Retries.** `@Retry({ attempts, backoff, delay, maxDelay })` sets the policy of a handler
  (`attempts` counts the first delivery); handlers without `@Retry` use the plugin's
  `defaults.retry` (3 attempts, exponential from 1 s, at most 30 s). Short delays are waited in
  process, longer ones use the broker (SQS visibility timeout, RabbitMQ delay queues, a Kafka retry
  topic...). A policy the driver cannot honour stops the boot
  ([`ZNIGHT011`](/reference/error-codes#znight011)), not the first failure in production.
- **Errors that retrying cannot fix.** Throw `NonRetryableError` (or a subclass) for a failure that
  will not change: an unknown customer, a rejected recipient. The message goes to `@OnError` at
  once.
- **`@OnError`** runs once a message will not be retried any more (last attempt, `NonRetryableError`,
  invalid payload, undecodable body, no matching handler). Return `'ack'` to drop it (an expected
  outcome, like the hard bounce above), anything else to dead-letter it.
- **Dead letters.** The copy keeps the body, type, id and headers and adds the reason, the error,
  the original queue and the number of attempts (`x-znight-*` headers). The original message is
  acknowledged only once the dead-letter publish is confirmed: if it fails, the message is released
  and redelivered. Inspect the dead-letter queue (`orders.dlq` by default), fix, replay.

## At-least-once delivery and idempotency {#idempotency}

Delivery is **at least once**: a message can be delivered twice (a crash after the work and before
the ack, a lease that expired, a rebalance). Make handlers idempotent:

- use the message id (`@Ctx() message: InboundMessage`, `message.id`) as an idempotency key, as
  the email consumer does with its SMTP `Message-ID`;
- write with upserts or unique constraints rather than blind inserts;
- keep side effects that cannot be repeated (a payment) behind a check of what was already done.

Brokers that deduplicate (NATS JetStream with the message id, SQS FIFO) reduce duplicates; they do
not remove the need.

## Publish {#publish}

`MessageBroker` is provided by the plugin; inject it anywhere:

```ts
import { Injectable } from '@znight/core'
import { MessageBroker } from '@znight/messaging'

@Injectable()
export class CheckoutService {
  constructor(private readonly broker: MessageBroker) {}

  async complete(order: Order) {
    await this.broker.publish('orders', { orderId: order.id, total: order.total }, { type: 'order.created' })
  }
}
```

`publish(queue, payload, options?)` resolves with `{ id }` once the broker **confirmed** the
message: when it resolves, the message is safe. Options: `type` (selects the handler), `headers`,
`key` (the Kafka partition key, the SQS FIFO group, the Pub/Sub ordering key or the Service Bus
session id: messages with the same key keep their order), `delay` (not on Kafka, Pub/Sub nor NATS),
`id` and `contentType`. With [`@znight/observability`](./observability), the trace context travels
in the headers: the consumer's span continues the publisher's trace.

To publish after a database commit, publish from a detached
[application event listener](./events#relay-to-a-message-broker), or write to an outbox table in the
same transaction when the message must never be lost.

## Concurrency and per-message scope {#concurrency}

`@Consumer({ queue: 'orders', concurrency: 10 })` processes up to ten messages of that consumer at
once (the plugin's `defaults.concurrency` is 1). Each delivery runs in its own
[request scope](./scopes#request-scopes): request-scoped providers are created per message and never
shared between messages, and `InboundMessage` is injectable in them. Order per key needs
`concurrency: 1` (or the ordering of the broker's partitions).

## Workers and publish-only processes {#workers}

A **worker** is an application without HTTP: only consumers. While consumers are subscribed, the
plugin keeps the process alive, whatever the driver; it stops on `SIGINT` / `SIGTERM` or
`app.stop()`. The [`worker` example](/examples) is a complete one: email and report consumers,
configuration, logs, graceful shutdown.

A process that publishes without consuming (an HTTP API handing work to a worker) passes
`consume: false`: the plugin connects and publishes, and subscribes none of the consumers the
application contains.

```ts
MessagingPlugin.configure({ driver: rabbitmq({ url: process.env['RABBITMQ_URL'] }), consume: false })
```

## Shutdown {#shutdown}

On shutdown, consumers stop receiving, in-process retry delays are aborted (those messages are
released to the broker), `message.signal` aborts, and the handlers in flight are awaited before the
connection closes: messages are never dropped. Pass `message.signal` to long operations so that they
stop early, and keep the shutdown timeouts above your slowest handler
([Lifecycle](./lifecycle), [Deployment](./deployment#graceful-shutdown-in-orchestrators)).

## Testing {#testing}

**Unit tests.** A consumer is a class: test its handlers with `TestBed`, its dependencies
auto-mocked. From the `worker` example:

```ts
import { TestBed } from '@znight/testing'
import { metadata } from '../src/.znight/container.generated.js'

it('sends the email of the job, identified by the message id', async () => {
  const { instance, mocks } = await TestBed.create(EmailConsumer, { metadata })
  const job = { to: 'ada@example.com', template: 'welcome', locale: 'en', data: { name: 'Ada' } } as const

  await instance.send(job, inboundMessage({ id: 'job-42' }))

  expect(mocks.get(EmailService).send).toHaveBeenCalledWith(job, 'job-42')
})
```

**Application tests.** The in-memory driver is a deterministic broker your test drives and
inspects, with the real container, retries and dead letters:

```ts
import { MessagingPlugin } from '@znight/messaging'
import { memory } from '@znight/messaging/memory'
import { TestApp } from '@znight/testing'

const driver = memory()
await using app = await TestApp.create({ metadata, plugins: [MessagingPlugin.configure({ driver })] })

driver.send('orders', { payload: { orderId: '1', total: 10 }, type: 'order.created' })
await driver.idle() // nothing in flight, scheduled or deliverable
expect(driver.settlements('orders')).toMatchObject([{ action: 'ack' }])
expect(driver.deadLetters('orders')).toEqual([])
```

`driver.published()`, `driver.pending()` and `driver.fail()` (failure injection) complete it; see
also [Messages](./testing#messages) in the Testing guide. **Integration tests** against a real
broker use Testcontainers: the drivers of this repository run a shared conformance kit that way.

## Observability {#observability}

With [`@znight/observability`](./observability), every delivery is logged (one entry per message),
measured (`messaging_messages_processed_total` and `messaging_process_duration_seconds` by queue,
consumer, type and outcome) and traced (a `CONSUMER` span
continuing the publisher's `PRODUCER` span). The `microservice` example follows one trace from an
HTTP request through RabbitMQ to its consumer.
