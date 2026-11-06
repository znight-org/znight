---
description: Application events with @znight/events - publish class instances, listen with @OnEvent, choose inline or detached listeners, handle errors, transactions and the relay to a message broker.
---

# Application events

Application events decouple the code that does something from the code that reacts to it: a use case
publishes `UserCreated`, and the welcome mail, the audit trail and the search index listen to it.
`@znight/events` keeps the wiring compile-time like the rest of Znight: listeners are found by the
compiler, from the type of their parameter.

## Publish

An event is an instance of a class: no base class, interface or decorator is required.

```ts
export abstract class UserEvent {
  readonly occurredAt = new Date()
  abstract readonly userId: string
}

export class UserCreated extends UserEvent {
  constructor(
    readonly userId: string,
    readonly email: string,
  ) {
    super()
  }
}
```

Inject `EventPublisher` and publish:

```ts
import { Injectable } from '@znight/core'
import { EventPublisher } from '@znight/events'
import { UserCreated } from './user.events.ts'

@Injectable()
export class CreateUser {
  constructor(private readonly events: EventPublisher) {}

  async execute(email: string): Promise<void> {
    const id = crypto.randomUUID()
    // ... insert the user
    await this.events.publish(new UserCreated(id, email))
  }
}
```

Register the plugin, before the plugins that receive traffic (it stops after them):

```ts
import { Application } from '@znight/core'
import { EventsPlugin } from '@znight/events'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'

const app = await Application.create({ metadata: __ZNIGHT_METADATA__, plugins: [EventsPlugin.configure()] })
```

## Listen

```ts
import { OnEvent } from '@znight/events'
import { UserCreated, UserEvent } from './user.events.ts'

export class SearchIndex {
  @OnEvent()
  async add(event: UserCreated): Promise<void> {
    // inline: part of the operation
  }
}

export class Audit {
  @OnEvent({ order: 100 })
  record(event: UserEvent): void {
    // every subclass of UserEvent
  }
}
```

The parameter type is the subscription: a class, a union (`event: Started | Cancelled`) or a base
class. A class with `@OnEvent` methods becomes a singleton provider unless it is already a provider;
it may be request-scoped (`@Injectable({ scope: 'request' })`) to share the publisher's unit of work.

## Inline or detached

|             | Inline (default)                                | `detached: true`                              |
| ----------- | ----------------------------------------------- | --------------------------------------------- |
| When        | during `publish()`, in `order`                  | after the inline phase, concurrently          |
| Scope       | the publisher's (same request-scoped instances) | a fresh scope per listener                    |
| An error    | rejects `publish()` unchanged, stops the rest   | goes to `onError`; other listeners unaffected |
| Typical use | invariants, same-transaction writes             | e-mails, notifications, cache warm-up         |

`emit(event)` is the fire-and-forget form: the whole publication runs after the caller continued, in a
fresh scope, and every error goes to `onError`.

A detached listener cannot depend on request values (`HttpContext`, `InboundMessage`, `JobContext`):
the request may be over when it runs. The compiler reports it ([`ZNIGHT070`](/reference/error-codes#znight070));
put what the listener needs in the event.

## Errors

```ts
import { EventsPlugin } from '@znight/events'

EventsPlugin.configure({
  onError: (error, info) => {
    console.error(`${info.listener} failed on ${info.eventName}`, error)
  },
})
```

Without `onError`, errors are logged by the application logger. There are no retries: work that must
eventually succeed belongs to a message consumer.

## Transactions

Znight leaves the ORM to you, so it has no transaction manager to hook into. Three patterns cover the
needs:

1. **Publish after commit** (the common case): call `publish()` once the transaction callback
   returned.
2. **Inside the transaction**: an inline listener and the use case share a request-scoped transaction
   handle, so the listener's writes commit or roll back with the use case.
3. **Deferred until commit**: a request-scoped buffer collects the events published deep inside the
   transaction, and your transaction helper publishes them after the commit (and drops them on
   rollback).

## Relay to a message broker

Out-of-process delivery is a detached listener that publishes a message, with an explicit contract:

```ts
import { OnEvent } from '@znight/events'
import { MessageBroker } from '@znight/messaging'
import { OrderPlaced } from './order.events.ts'

export class OrderEventsRelay {
  constructor(private readonly broker: MessageBroker) {}

  @OnEvent({ detached: true })
  async relay(event: OrderPlaced): Promise<void> {
    await this.broker.publish('orders', { id: event.orderId }, { type: 'order.placed' })
  }
}
```

It is not durable: a crash between the commit and the relay loses the message. Durability needs an
outbox table written in the same transaction.

## Testing

```ts
import { recordEvents } from '@znight/events/testing'

const events = recordEvents(test)
await createUser.execute('ada@example.com')
await events.idle() // detached listeners settled
expect(events.of(UserCreated)).toHaveLength(1)
expect(events.failures()).toEqual([])
```

In unit tests, `TestBed` auto-mocks `EventPublisher`:
`expect(mocks.get(EventPublisher).publish).toHaveBeenCalledWith(expect.any(UserCreated))`.

## Shutdown

On `app.stop()`, the plugin waits for detached listeners in flight (`drainTimeoutMs`, 10 s by
default). Listing it first in `plugins` makes it stop last, once no request, message or job can
publish any more.
