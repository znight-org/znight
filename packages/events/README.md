# @znight/events

In-process application events for [Znight](https://github.com/znight-org/znight): publish an instance of
a class, and the provider methods marked `@OnEvent()` whose parameter is typed with that class (or one
of its base classes) run. Listeners are found and checked by the compiler, not registered at runtime
(RFC 0011).

```sh
npm install @znight/events
```

## Usage

```ts
// src/users/user-created.ts: an event is an instance of any class
export class UserCreated {
  constructor(
    readonly userId: string,
    readonly email: string,
  ) {}
}
```

```ts
// src/users/create-user.ts
import { Injectable } from '@znight/core'
import { EventPublisher } from '@znight/events'
import { UserCreated } from './user-created.ts'

@Injectable()
export class CreateUser {
  constructor(private readonly events: EventPublisher) {}

  async execute(email: string): Promise<string> {
    const id = crypto.randomUUID()
    // ... save the user
    await this.events.publish(new UserCreated(id, email))
    return id
  }
}
```

```ts
// src/mail/welcome-mail.ts: a class with @OnEvent methods becomes a singleton provider
import { OnEvent } from '@znight/events'
import { UserCreated } from '../users/user-created.ts'

export class WelcomeMail {
  @OnEvent({ detached: true })
  async send(event: UserCreated): Promise<void> {
    // runs after publish() resolved, in its own scope; errors go to onError
  }
}
```

```ts
// src/main.ts
import { Application } from '@znight/core'
import { EventsPlugin } from '@znight/events'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  // before HttpPlugin, MessagingPlugin and SchedulePlugin: it stops after them
  plugins: [EventsPlugin.configure()],
})
await app.start()
```

## Listeners

`@OnEvent(options?)` goes on a public instance method with exactly one parameter, the event. Its type
annotation is the subscription:

| Parameter type                | Receives                                       |
| ----------------------------- | ---------------------------------------------- |
| `event: UserCreated`          | instances of `UserCreated` and its subclasses  |
| `event: UserEvent` (a base)   | every subclass instance (a "wildcard")         |
| `event: Started \| Cancelled` | instances of either class (one entry per type) |

An interface, a type alias, a primitive, `object`, `unknown`, a class with type arguments, an optional
or nullable parameter and a string argument (`@OnEvent('user.created')`, the `@nestjs/event-emitter`
form) are build errors (ZNIGHT070).

| Option     | Default | Effect                                                                                       |
| ---------- | ------- | -------------------------------------------------------------------------------------------- |
| `order`    | `0`     | Integer; lower runs first. Ties: provider token, then method name                            |
| `detached` | `false` | Runs after the publication in a fresh scope; errors are reported (`onError`), never rethrown |

- **Inline** listeners (the default) run in order, each awaited, in the publisher's async context: a
  request-scoped host is the publisher's instance (one unit of work). The first error rejects
  `publish()` with that error, unchanged, and skips the remaining inline and every detached listener.
- **Detached** listeners start on a macrotask once the inline phase succeeded, concurrently, each in
  its own scope. A detached listener whose host depends on a request-scoped external (`HttpContext`,
  `InboundMessage`, `JobContext`) is a build error: pass what it needs in the event.
- Listeners declared on an abstract class run on each concrete provider extending it (`extends`, not
  `implements`), which is then never reported unused nor pruned. A subclass that redeclares the
  method replaces the inherited listener: its own `@OnEvent` (with its options) applies, or none.
- Method interceptors (`@Logged`, `@Traced`, your own `@Intercept`) wrap listeners like any method.

## Publisher

| Method           | Behaviour                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `publish(event)` | Runs inline listeners, then schedules detached ones; resolves when the inline phase is done                |
| `emit(event)`    | Fire and forget: the whole publication runs on a macrotask in a fresh scope, every error goes to `onError` |

Both throw a `TypeError` for a value that is not a class instance, and reject with ZNIGHT021 before
`EventsPlugin` is bootstrapped (in a constructor) and once it is disposed.

## Plugin options

```ts
import { EventsPlugin } from '@znight/events'

EventsPlugin.configure({
  onError: (error, info) => console.error(`${info.listener} failed on ${info.eventName}`, error),
  drainTimeoutMs: 10_000,
})
```

| Option           | Default             | Effect                                                                        |
| ---------------- | ------------------- | ----------------------------------------------------------------------------- |
| `onError`        | `logger.error(...)` | Receives errors of detached listeners and of `emit()`; may be async           |
| `drainTimeoutMs` | `10000`             | How long `onStop` waits for detached listeners in flight (`Infinity`: no cap) |

## Testing

`EventPublisher` is an abstract class: `TestBed` auto-mocks it. In application tests, listener hosts
are instantiated by `TestApp`, and `recordEvents()` records publications and failures:

```ts
import { recordEvents } from '@znight/events/testing'

const events = recordEvents(test) // a TestApp or an Application
// ... exercise the application
await events.idle() // detached listeners settled
events.of(UserCreated) // the published UserCreated instances
events.failures() // listeners that threw
```

## Observability

Two core hooks, produced only when observed: `events:publish` (one publication with listeners,
around its inline phase) and `events:listener` (one listener invocation, inline or detached).

## Compiler contract

- Manifest: `compiler: '@znight/events/compiler'`, `provides: EventPublisher → EventsPlugin
  (singleton)`.
- The extension owns `@znight/events#OnEvent` (target `method`, one static argument), reports
  ZNIGHT005 and ZNIGHT070, adds each concrete host as a root and generates
  `metadata.extensions.events` (absent without listener):

  ```ts
  {
    listeners: [{
      event: UserCreated,
      eventName: 'UserCreated',
      token: 'src/mail/welcome-mail.ts#WelcomeMail',
      method: 'send',
      order: 0,
      detached: true,
      invoke: (c: WelcomeMail, e: UserCreated) => c.send(e),
    }],
  }
  ```

  Entries are sorted by (`order`, token, method, event name). The generated code calls no helper of
  this package.
- Specification: §9.8 of [`docs/internals/architecture.md`](../../docs/internals/architecture.md).

## Limitations

- In-process only, no persistence and no retries: a listener that needs them is a message consumer
  (relay the event to `MessageBroker` from a detached listener).
- No transaction phases (`@TransactionalEventListener`): publish after the commit, or buffer events
  until it (see the application events guide).
- No concurrency limit for detached listeners.

## License

MIT
