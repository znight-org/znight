---
description: "@znight/events - in-process application events: listeners found and checked at build time, inline in the publisher's scope or detached, with ordering, error reporting and graceful shutdown."
---

# @znight/events <Badge type="tip" text="available" />

In-process application events, with the guarantees of a compile-time framework:

- **Typed by classes.** An event is an instance of any class; a listener is a provider method marked
  `@OnEvent()` whose parameter type is the event class, a union of classes or a base class.
- **Checked at build time.** Interfaces, type aliases, generic events, string names and invalid
  options are build errors ([`ZNIGHT070`](/reference/error-codes#znight070)); so is a detached listener
  depending on a request-scoped value.
- **Inline or detached.** Inline listeners run in order in the publisher's scope and fail its
  operation; detached ones run after it, in their own scope, with errors reported.
- **Zero cost when unused.** An application without `@OnEvent` generates the same module as before.

The guide is [Application events](/guide/events); this page is the reference.

## Install

```sh
npm install @znight/events
```

```ts
import { Application } from '@znight/core'
import { EventsPlugin } from '@znight/events'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [EventsPlugin.configure()], // list it before HttpPlugin, MessagingPlugin, SchedulePlugin
})
```

## `@OnEvent(options?)`

| Option     | Type      | Default | Effect                                                                |
| ---------- | --------- | ------- | --------------------------------------------------------------------- |
| `order`    | integer   | `0`     | Lower runs first; ties are broken by provider token, then method name |
| `detached` | `boolean` | `false` | After the publication, in a fresh scope, errors reported not rethrown |

```ts
import { OnEvent } from '@znight/events'
import { UserCreated, UserEvent } from './user.events.ts'

export class Audit {
  @OnEvent({ order: 100 })
  record(event: UserEvent): void {
    // every UserEvent subclass, after the other inline listeners
  }
}

export class WelcomeMail {
  @OnEvent({ detached: true })
  async send(event: UserCreated): Promise<void> {
    // after publish() resolved
  }
}
```

## `EventPublisher`

| Method           | Returns         | Errors                                                                      |
| ---------------- | --------------- | --------------------------------------------------------------------------- |
| `publish(event)` | `Promise<void>` | Rejects with the first inline error, unchanged; detached errors → `onError` |
| `emit(event)`    | `void`          | Every error → `onError`                                                     |

A plain object or a primitive is a `TypeError`. Before `EventsPlugin` is bootstrapped (in a provider
constructor) and once it is disposed: [`ZNIGHT021`](/reference/error-codes#znight021).

## `EventsPlugin.configure(options?)`

| Option           | Default             | Effect                                                                          |
| ---------------- | ------------------- | ------------------------------------------------------------------------------- |
| `onError`        | `logger.error(...)` | `(error, { event, eventName, listener, detached, mode }) => unknown`            |
| `drainTimeoutMs` | `4000`              | How long `onStop` waits for detached listeners in flight (`Infinity`: no limit) |

The application gives each `onStop` at most `shutdown.hookTimeoutMs` (5 s by default) within
`shutdown.timeoutMs` (10 s): keep `drainTimeoutMs` below it, or raise both
(`Application.create({ shutdown: { hookTimeoutMs: 12_000, timeoutMs: 15_000 } })`), otherwise the
stop times out and fails with [`ZNIGHT021`](/reference/error-codes#znight021).

## Testing

```ts
import { recordEvents } from '@znight/events/testing'

const events = recordEvents(test)
await events.idle()
events.of(UserCreated)
events.failures()
```

`EventPublisher` is auto-mocked by `TestBed`; listener hosts are instantiated by `TestApp`.

## Hooks

`events:publish` (`EventPublishEvent`: `event`, `payload`, `mode`, `inline`, `detached`, `error`,
`failedListener`) and `events:listener` (`EventListenerEvent`: `event`, `payload`, `listener`,
`detached`, `error`), built only when observed.

## Limitations

In-process, not durable, no retries, no transaction phases, no concurrency limit for detached
listeners. See [the guide](/guide/events#transactions) for the transaction recipes and the relay to
`@znight/messaging`.
