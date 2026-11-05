# RFC 0011: Application events (`@znight/events`)

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Date     | 2026-11-04                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Affects  | New package `@znight/events` (marker decorator `@OnEvent`, compiler extension `@znight/events/compiler`, `EventsPlugin`, injectable `EventPublisher`, `@znight/events/testing`). `@znight/core`: two hooks (`events:publish`, `events:listener`) and their event types, one error code (`ZNIGHT070`, block `070`–`079`). `@znight/observability`: spans, metrics and logs for both hooks. `@znight/testing`: listener hosts as default `TestApp` roots. Specification §4.8, §5, §7, §8.3, a new §9.8, §10. Docs, guide, migration guide                                                                                                                                                                             |
| Decision | **In-process application events, in the spirit of Spring and Micronaut, not a clone of `@nestjs/cqrs`.** Events are plain class instances. Listeners are provider methods marked `@OnEvent()`; the event type is the type of the method's parameter, read at build time, and the event → listeners registry is generated into the metadata. `EventPublisher.publish(event)` runs the inline listeners in order, in the publisher's request scope, and rejects with the first error; `detached` listeners and `emit(event)` run in the background, in scopes of their own, with errors reported, never thrown. `@znight/messaging` stays the tool for durable, out-of-process delivery, and a recipe bridges the two |

**Owner decisions (2026-11-04).** Every open question of §13 takes its recommended answer: a
`@znight/events` package, `@OnEvent`, inline by default, transaction recipes before a port, stop at
the first inline error and rethrow it unchanged, no typed publishers in v1, a messaging relay recipe
before `@Externalized`, no concurrency limit for detached listeners in v1, request-scoped detached
listeners allowed in a fresh scope, and the `070`–`079` block with ZNIGHT070 only.

## 1. Summary

Znight has no in-process event mechanism. `Hooks` is an instrumentation bus for plugins, not a
domain tool, and `@znight/messaging` is a broker client with queue semantics (§3). Applications
migrated from NestJS that use `@nestjs/cqrs` only for its `EventBus`, or `@nestjs/event-emitter`,
have nowhere to go but a hand-written port. This RFC adds a small package:

```ts
// src/users/user-created.event.ts
export class UserCreated {
  constructor(readonly user: User) {}
}
```

```ts
// src/users/create-user.ts
import { Injectable } from '@znight/core'
import { EventPublisher } from '@znight/events'

@Injectable()
export class CreateUser {
  constructor(
    private readonly users: UserRepository,
    private readonly events: EventPublisher,
  ) {}

  async execute(input: NewUser): Promise<User> {
    const user = await this.users.insert(input)
    await this.events.publish(new UserCreated(user)) // inline listeners have run, detached ones are scheduled
    return user
  }
}
```

```ts
// src/mail/welcome-mail.ts
import { OnEvent } from '@znight/events'

export class WelcomeMail {
  constructor(private readonly mail: MailService) {}

  /** Runs after the publication, in its own scope; a failure is logged, never thrown at CreateUser. */
  @OnEvent({ detached: true })
  async send(event: UserCreated): Promise<void> {
    await this.mail.welcome(event.user)
  }
}

// src/events/attendee-linker.ts
export class AttendeeLinker {
  constructor(private readonly attendees: AttendeeRepository) {}

  /** Runs inside publish(), in the request scope of CreateUser; a failure rejects publish(). */
  @OnEvent({ order: -10 })
  async link(event: UserCreated): Promise<void> {
    await this.attendees.claimTemporary(event.user)
  }
}
```

1. **Discovered and checked at build time.** `@znight/events/compiler` finds every `@OnEvent`
   method, reads the event class from its parameter type (a class, a union of classes, or a base
   class to listen to a family of events), validates the signature and the options, makes the host a
   singleton provider and a graph root when it is not a provider yet, and generates the registry
   with one `invoke` per listener. A listener whose parameter is an interface, a type alias or a
   primitive is a build error (`ZNIGHT070`): nothing at runtime could match it.
2. **Two delivery modes, chosen by the listener.** Inline listeners (default) run sequentially, in
   order, in the publisher's async context and request scope, and their first error rejects
   `publish()`: they are part of the operation. Detached listeners run once the inline ones
   succeeded, each in a fresh scope, concurrently; their errors are reported (log, hook, `onError`)
   and never reach the publisher: they are side effects. `emit(event)` is the publisher's
   fire-and-forget form.
3. **Zero cost when unused.** No listener for an event: `publish()` is one map lookup. No hook
   wrapper: no event object is built. No `@OnEvent` in the application: the package is not even
   needed.
4. **Observable, testable, drained.** Two hooks feed `@znight/observability`; `TestBed` auto-mocks
   `EventPublisher` like any dependency; `@znight/events/testing` records publications in
   `TestApp` tests and waits for detached listeners; `app.stop()` drains detached listeners.
5. **Transactions and brokers stay with their owners.** Znight leaves the ORM to the application,
   so there is no `@TransactionalEventListener` in v1: the guide gets an "after commit" recipe.
   Durable or cross-process delivery is `@znight/messaging`'s job: a detached listener that
   publishes to the broker is the bridge (a recipe first, a decorator later if users ask).

## 2. Ecosystem: what users rely on

### 2.1 Spring application events

- **Publisher.** `ApplicationEventPublisher.publishEvent(Object)` (any object since 4.2, wrapped in a
  `PayloadApplicationEvent`). Injected anywhere; the `ApplicationContext` is one.
- **Listeners.** `@EventListener` on a bean method; the event type is the parameter type, or
  `classes = { A.class, B.class }` for a method with no parameter. Matching follows the type
  hierarchy: a listener of a supertype receives its subtypes.
- **Ordering.** `@Order` on the listener method; otherwise unspecified.
- **Conditions.** `condition = "#event.important"` (a SpEL expression).
- **Return values.** A non-void return value (or each element of an array or collection) is published
  as a new event.
- **Synchronous by default.** Listeners run on the publisher's thread, inside its transaction. An
  exception thrown by a listener propagates to `publishEvent()` and the remaining listeners do not
  run (default multicaster, no error handler).
- **Async.** `@Async` on the listener moves it to an executor; its exceptions go to an
  `AsyncUncaughtExceptionHandler`. The request scope is not inherited.
- **Transactions.** `@TransactionalEventListener(phase = AFTER_COMMIT)` (default phase), also
  `BEFORE_COMMIT`, `AFTER_ROLLBACK`, `AFTER_COMPLETION`; without a transaction the event is dropped
  unless `fallbackExecution = true`. This is the feature Spring users quote most.
- **Generics.** `EntityCreated<User>` is matched on its type argument when the event implements
  `ResolvableTypeProvider`: erasure needs help even on the JVM.
- **Beyond core.** Spring Modulith's `@ApplicationModuleListener` (async, new transaction, after
  commit), its Event Publication Registry (an outbox giving at-least-once delivery) and
  `@Externalized` (forwarding to Kafka, AMQP...). In tests, `@RecordApplicationEvents` injects an
  `ApplicationEvents` recorder.

### 2.2 Micronaut events

- **Publisher.** `ApplicationEventPublisher<E>`, typed by event and injected per type;
  `publishEvent(E)` and `publishEventAsync(E)` (a future).
- **Listeners.** `@EventListener` methods or `ApplicationEventListener<E>` beans (`onApplicationEvent`,
  `supports(E)` as a filter). Listener adapters are generated at compile time with the rest of the
  bean definitions, which is the model this RFC follows.
- **Ordering** with `@Order` / `Ordered`; **async** with `@Async` on the listener and a named
  executor; `@TransactionalEventListener` with phases in Micronaut Data.
- **Framework events.** `StartupEvent`, `ShutdownEvent`, `ServiceReadyEvent`: the lifecycle is
  exposed as events.

### 2.3 NestJS `@nestjs/event-emitter`

- A wrapper around `eventemitter2`: `EventEmitter2.emit('order.created', payload)` with **string**
  names, wildcards (`order.*`, `**`) and namespaces.
- `@OnEvent('order.created', { async, promisify, nextTick, prependListener, suppressErrors })`;
  `suppressErrors` is `true` by default, so a throwing listener is silent unless configured.
- `emit()` is synchronous and does not wait for async listeners; `emitAsync()` returns the
  promise of all listener results.
- Listeners are registered at `onApplicationBootstrap`, so an event emitted earlier is lost:
  `EventEmitterReadinessWatcher.waitUntilReady()` exists for that.
- Payloads are untyped: the listener's parameter type is not checked against the event name.

### 2.4 NestJS `@nestjs/cqrs` `EventBus` (checked: version 12.1.2)

- Events are classes; handlers are `@EventsHandler(A, B)` classes implementing
  `IEventHandler<A | B>.handle(event)`. `EventBus.publish(event)` and `publishAll(events)`.
- **`publish()` does not wait for the handlers.** In 12.1.2 it returns the result of
  `DefaultPubSub.publish()`, which is `subject$.next(event)` and returns `undefined`. Each handler
  runs through `mergeMap(defer(() => Promise.resolve(handler.handle(event))))`: its synchronous
  prefix runs inside `next()`, the rest is detached. Its errors go to `UnhandledExceptionBus` and the
  logger, never to the publisher. So `await eventBus.publish(e)` and `eventBus.publish(e)` behave the
  same.
- Aggregates: `AggregateRoot.apply()` buffers events, `EventPublisher.mergeObjectContext()` and
  `commit()` publish them.
- **Sagas**: `@Saga()` properties mapping the RxJS stream of events to commands
  (`events$.pipe(ofType(UserCreated), map(...))`).
- A pluggable `IEventPublisher` to forward events to a broker; request-scoped handlers through
  `AsyncContext` (since v11).

### 2.5 What users actually rely on

From the frameworks above and from the migration that motivates this RFC (§2.6), sorted by how
often it matters:

1. **Typed, class-based events** with fan-out to several independent handlers, written in other
   modules than the publisher (decoupling is the point).
2. **Side effects that do not slow down or fail the operation**: e-mails, notifications, cache
   invalidation, audit. In NestJS this is the default (cqrs) or the common configuration
   (event-emitter without `emitAsync`).
3. **Work that must be part of the operation**: a second write in the same transaction, a check that
   must fail the request. Spring's default.
4. **"After commit"**: do not send the e-mail when the transaction rolled back.
5. **Ordering** of a few listeners; **supertype listeners** (audit every `DomainEvent`).
6. **Testing**: assert that a use case published an event (a mock), and run handlers for real in
   end-to-end tests.
7. Less often: SpEL-like conditions, returning events from listeners, sagas, wildcards on string
   names, generic events. None is needed for the target migration.

### 2.6 The migration that motivates this RFC

The wishlist API (NestJS, Bun, GraphQL, Drizzle) uses `@nestjs/cqrs` for its `EventBus` only: no
command or query bus, no saga, no aggregate. Eight `@EventsHandler` classes (welcome e-mail,
co-owner added, attendee added, secret santa started and cancelled, e-mail change, password
verification), published from use cases with `await this.eventBus.publish(...)` in some places and
without `await` in others. Handlers send e-mails and do follow-up writes in their own transactions,
and catch their own e-mail failures. Unit tests mock the bus (`createMock<EventBus>()`) and assert
`publish` was called with an instance of the event class. Given §2.4, every handler is a detached
listener today, whatever the call site looks like.

## 3. What Znight has today (checked against the code)

| Fact                                                                                                                                                                                          | Where                                                                     | Consequence                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageBroker.publish(queue, payload, { type })` routes by queue name and string type; the payload goes through the plugin codec (JSON by default)                                           | `packages/messaging/src/broker.ts:61-139`                                 | Class instances become plain JSON: no methods, no `Date`, no `instanceof`; handlers re-validate with a schema (`@Message(schema)`)       |
| `publish()` resolves once the driver accepted the message; the memory driver dispatches on a microtask, consumers run later                                                                   | `broker.ts:27`, `drivers/memory.ts` (module doc)                          | The publisher never waits for handlers and cannot take part in their outcome                                                             |
| Each delivery runs in a new scope seeded with the `InboundMessage`                                                                                                                            | `packages/messaging/src/runtime.ts:216`                                   | A consumer never shares the publisher's request scope (its unit of work, its `HttpContext`)                                              |
| Handler errors are retried, then dead-lettered                                                                                                                                                | `packages/messaging/src/retry.ts`, architecture §9.2                      | The publisher never sees them; in process, retries rarely make sense for domain reactions                                                |
| "Several consumers of the same queue" is ZNIGHT011; the memory driver round-robins between competing subscribers                                                                              | `packages/messaging/README.md` (ZNIGHT011), `drivers/memory.ts`           | Fan-out of one event to N handlers needs N queues and N `publish()` calls by the publisher, which must know every handler: no decoupling |
| `MessagingPlugin.configure({ driver })` takes one driver for the whole application                                                                                                            | `packages/messaging/src/plugin.ts:36-37`                                  | An application on RabbitMQ or SQS cannot also use the memory driver for in-process events                                                |
| The memory driver is documented "for tests and local development"                                                                                                                             | `drivers/memory.ts:2`                                                     | Not a production in-process bus by design                                                                                                |
| The request scope is an `AsyncLocalStorage`; `runInScope()` closes it when its callback settles; resolving in a closed scope throws ZNIGHT013; `openScope()` serves work that outlives a call | `packages/core/src/container.ts:160`, `708-760`, `container-errors.ts:78` | Inline listeners called in the publisher's async context get its scope for free; detached work must open its own                         |
| Multi injection (`Listener[]`) gives every implementation of an interface, ordered by token                                                                                                   | `docs/guide/dependency-injection.md` "Multi injection"                    | The hand-written alternative (§12) is ~30 lines, but typed by interface, not by event class                                              |
| Hooks are typed in core (`ZnightHooks`); producers check `hasWrappers` / `hasListeners` before building an event                                                                              | `packages/core/src/hooks.ts`, `broker.ts:74-99`                           | Same pattern for the two new hooks: no cost without observers                                                                            |
| Extension API: `registerProvider`, `addRoot`, `bindInjection`, `store`, `classInfo` (with `superClass` and `heritage`), parameter `TypeInfo` with canonical identities                        | `packages/compiler/src/extensions/api.ts`                                 | Everything the compiler side needs exists; no compiler change                                                                            |
| A class whose only entry point is a decorated method is "unused" (ZNIGHT019) and pruned unless declared a root                                                                                | RFC 0004 §2, `AnalyzeContext.addRoot`                                     | Listener hosts are roots, like job hosts                                                                                                 |
| Shutdown: plugins' `onStop` (reverse order), then providers' `onStop` and disposal, then plugins' `onDispose`                                                                                 | `docs/guide/lifecycle.md`                                                 | Detached listeners are drained in the plugin's `onStop`, before providers are disposed                                                   |

**Conclusion: `@znight/messaging` with the memory driver does not cover the need**, and should not
be bent to. Its contract is a broker's: asynchronous, serialised, retried, dead-lettered,
competing consumers, one driver. Application events are a method call made indirect: synchronous or
awaited, typed by class, in the caller's scope, with exceptions reaching the caller, fanned out to
every listener. The two meet only at the boundary of the process, where the bridge of §5.15 sits.
What `@znight/messaging` does teach is the layout (decorators, compiler extension, generated
`invoke`, plugin), which this RFC copies.

## 4. Goals and non-goals

### 4.1 Goals

- Class-based events with fan-out, publisher and listeners decoupled, wired at build time.
- The event type of a listener comes from its parameter type; mistakes are build errors.
- Both delivery semantics, chosen per listener, plus a fire-and-forget publication.
- Defined ordering, error propagation, scopes, shutdown and observability.
- A one-to-one migration path for `@nestjs/cqrs` `EventBus` handlers and `@nestjs/event-emitter`
  listeners.
- No measurable cost on applications or events that do not use it.

### 4.2 Non-goals

- A command bus or a query bus: in Znight a command handler is an injected service.
- Sagas and RxJS streams of events. A saga is a listener that calls a service; long-running
  processes belong to `@znight/messaging` or `@znight/schedule`.
- String event names and wildcards. A class per event is the model; §10 shows how to migrate.
- Durable delivery, retries, an outbox: `@znight/messaging`.
- Transaction phases in v1 (§5.14).
- Conditions in decorators (Spring SpEL): an `if` at the top of the listener does it, and stays
  type-checked.
- Republishing a listener's return value (Spring): return values are ignored.
- Framework lifecycle events (`StartupEvent`): lifecycle hooks (`onStart`, `onReady`, `onStop`)
  already exist.

## 5. Design

### 5.1 Where it lives: a small package

`@znight/events`, with the usual layout (principle 5): marker decorators, a compiler extension
(`@znight/events/compiler`, discovered through `package.json#znight`), a runtime plugin
(`EventsPlugin.configure()`), and a test helper subpath (`@znight/events/testing`).

Why not `@znight/core`: core has no compiler extension of its own; its decorators are read by the
compiler itself, so putting events in core means teaching `@znight/compiler` about listeners,
growing the core metadata shape and the core runtime for applications that never publish an event.
A package costs one install line, keeps core's surface as it is, and follows the precedent of
`@znight/schedule`, which has the same structure. Only what producers and observers must share goes
to core: the hook names and event types (§5.12) and the error code (§7), as for every package.

### 5.2 Events

An event is an instance of a class. Any class: no base class, no interface to implement, no
decorator. It may live in the application, in a provider library or in a package (a contracts
package of a monorepo).

```ts
export abstract class WishlistEvent {
  readonly occurredAt = new Date()
  abstract readonly wishlistId: string
}

export class CoOwnerAdded extends WishlistEvent {
  constructor(
    readonly wishlistId: string,
    readonly userId: string,
  ) {
    super()
  }
}
```

Dispatch uses the runtime class of the published object (`event.constructor`) and its prototype
chain. Plain objects (`publish({ type: 'x' })`) and primitives are rejected at runtime with a
`TypeError` naming the value; the compiler checks listeners, not call sites (§13, Q6).

### 5.3 The publisher

```ts
/** Publishes application events to the listeners generated at build time. Inject it anywhere. */
export abstract class EventPublisher {
  /**
   * Runs the inline listeners of `event`, in order, in the caller's async context and request
   * scope, then schedules its detached listeners. Resolves once every inline listener settled;
   * rejects with the first inline error, unchanged (the remaining inline listeners and every
   * detached listener are skipped).
   */
  abstract publish(event: object): Promise<void>

  /**
   * Fire and forget: starts `publish(event)` in the background, in a fresh scope, and returns.
   * Never throws (except for a non-object event) and never waits; failures are reported (§5.9).
   */
  abstract emit(event: object): void
}
```

- `EventPublisher` is supplied by `EventsPlugin` through the manifest (`provides`, singleton), like
  `MessageBroker` and `SchedulerRegistry`. Injecting it without the plugin configured fails at boot
  with the usual missing-external error.
- The publisher does not depend on the listeners in the dependency graph: the registry holds tokens,
  and listener instances are resolved from the container at dispatch time. A listener may therefore
  depend on a service that publishes the event it listens to, with no cycle (ZNIGHT002) and no
  `Lazy<T>`.
- `publish()` is available from the end of `EventsPlugin.onBootstrap` (the singletons exist). Called
  earlier (in a constructor or a factory), it rejects with ZNIGHT021, as `MessageBroker.publish()`
  does.
- The name is `EventPublisher`, not `ApplicationEvents` (Spring's name for its test recorder) or
  `EventBus` (NestJS cqrs, whose semantics differ, §2.4).

### 5.4 Listeners

```ts
export interface OnEventOptions {
  /** Inline listeners run in ascending order (default 0); ties are broken by token, then method name. */
  readonly order?: number
  /** Run after the publication, in a fresh scope, with errors reported instead of thrown. Default: false. */
  readonly detached?: boolean
}

export function OnEvent(options?: OnEventOptions): MethodDecorator
```

Rules, all checked at build time:

- `@OnEvent` goes on a public, non-static instance method of a class. On anything else: ZNIGHT005
  (wrong target), as everywhere.
- The method has **exactly one parameter**, without decorator, not a rest parameter. Its type
  annotation is the event type:
  - a class (`UserCreated`), abstract or not, from the application, a provider library or a
    package;
  - a union of classes (`SecretSantaStarted | SecretSantaCancelled`): one registration per member,
    sharing the method;
  - a base class (`WishlistEvent`): the listener receives every subclass instance (§5.6).
- Anything else is ZNIGHT070 with a hint: an interface or a type alias of an object type ("nothing
  at runtime identifies an interface: listen to a class"), a primitive or literal, `object`,
  `unknown` or `any`, an inline object type, a missing annotation, a class with type arguments
  (`EntityCreated<User>`: "type arguments are erased; listen to `EntityCreated` or declare
  `UserCreated extends EntityCreated<User>`"), a class that cannot be imported by the generated
  module (not exported).
- `order` must be a finite integer literal; `detached` a boolean literal; unknown options are
  errors (ZNIGHT070). Options are static, like every Znight decorator argument.
- The return type is free (`void`, `Promise<void>`, anything): the value is ignored and awaited when
  it is a promise.
- A string argument (`@OnEvent('user.created')`, the `@nestjs/event-emitter` form) is ZNIGHT070 with
  a migration hint (§10.2).
- A class with `@OnEvent` methods that is not a provider yet becomes a **singleton provider**. Any
  class provider may host listeners (`@Injectable` with any scope, `@Controller`, `@Consumer`); a
  value produced by a `@Provides` factory cannot, since the compiler analyses no class for it. Hosts
  are graph roots (`addRoot`), so they are never reported unused (ZNIGHT019) or pruned.
- `@OnEvent` methods on an abstract base class are inherited by the concrete subclasses that are
  providers; on a base class with no concrete provider subclass, a warning (ZNIGHT070) says they
  never run.
- Method interceptors apply: the generated `invoke` calls the instance method, so `@Logged`,
  `@Traced` or an application `@Transactional()` interceptor wraps the listener.

### 5.5 The generated registry

The compiler extension stores, per listener, the event class, the host token, the method, the mode
and the order, and generates (excerpt, keys as computed strings, ordering by canonical identity
only, golden-test deterministic):

```ts
import { UserCreated } from '../users/user-created.event.js'
import { WishlistEvent } from '../wishlist/wishlist.events.js'

export const __ZNIGHT_METADATA__: ZnightMetadata = {
  // ...
  extensions: {
    ['events']: {
      ['listeners']: [
        {
          event: UserCreated,
          eventName: 'UserCreated',
          token: 'src/events/attendee-linker.ts#AttendeeLinker',
          method: 'link',
          order: -10,
          detached: false,
          invoke: (instance, event) => (instance as AttendeeLinker).link(event as UserCreated),
          source: { file: 'src/events/attendee-linker.ts', line: 7, column: 3 },
        },
        {
          event: UserCreated,
          eventName: 'UserCreated',
          token: 'src/mail/welcome-mail.ts#WelcomeMail',
          method: 'send',
          order: 0,
          detached: true,
          invoke: (instance, event) => (instance as WelcomeMail).send(event as UserCreated),
          source: { file: 'src/mail/welcome-mail.ts', line: 8, column: 3 },
        },
        // WishlistEvent listeners: `event: WishlistEvent`, matched through the prototype chain
      ],
    },
  },
}
```

The entries are sorted by (`order`, token, method), so the runtime never sorts more than a merge of
already sorted lists. `eventName` is the class name, for logs, spans and metrics. Listeners from a
compiled provider library come with its metadata like other extension data (specification §6.4).

### 5.6 Matching and ordering (normative)

- At boot, the plugin builds a `Map<Function, Listener[]>` from the registry, keyed by the listened
  class.
- At the first publication of an instance of class `C`, the plugin walks `C`'s prototype chain and
  concatenates the listeners registered for each class on it, then sorts them by (`order`, token,
  method). The result is memoised per constructor: every later publication of a `C` is one map
  lookup. The memo is bounded by the number of event classes the application publishes.
- A listener registered for a base class therefore receives its subclasses, in the global order;
  order is never "subclass listeners first". The same method is never invoked twice for one
  publication (a union `A | Base` with `A extends Base` is reported by the compiler as a warning and
  registered once).
- Inline listeners run in that order, one after the other, each awaited before the next starts.
  Detached listeners start in that order, then run concurrently.

### 5.7 Inline dispatch (normative)

`publish(event)`:

1. Looks the listeners up (§5.6). None: resolves (the promise is already settled; no hook is
   called).
2. Resolves each inline listener's host from the container **in the caller's async context**: a
   request-scoped host gets the instance of the publisher's scope; a singleton host its singleton; a
   transient host a new instance per invocation. When no scope is active (a publication from a
   provider's `onStart`; HTTP requests, message deliveries and scheduled runs always have one) and an
   inline listener is request-scoped, `publish()` opens a scope for the duration of the inline phase
   and closes it afterwards.
3. Invokes them in order, awaiting each. The first error stops the inline phase: `publish()` rejects
   with that error, **unchanged** (an `HttpError` thrown by a listener still maps to its status; a
   domain error keeps its class), and no detached listener is scheduled. The failing listener is
   recorded on the hook event (§5.12) and in the error log of the observability plugin, not by
   wrapping the error.
4. When every inline listener succeeded, schedules the detached listeners (§5.8) and resolves.

Rationale for stop-at-first-error: inline listeners are, by definition, part of the operation; a
failure means the operation failed, and running more of it (or sending the welcome e-mail of a user
whose creation is being rolled back) is the wrong default. This is Spring's behaviour. An
application that wants isolation marks the listener `detached`.

A publication made inside an inline listener is a nested `publish()`, dispatched depth-first in the
same scope, like a nested method call.

### 5.8 Detached dispatch (normative)

- Detached listeners are started on a macrotask (`setImmediate`, on Node.js and Bun) after the
  inline phase succeeded, so they never run before `publish()` resolves and never delay the
  publisher's continuation.
- Each runs in a **fresh scope** opened with `container.runInScope()`, explicitly, so that it does
  not inherit the publisher's scope, which may close before the listener ends (resolving in it would
  throw ZNIGHT013). Request-scoped providers are new instances; request-scoped externals of the
  publisher (`HttpContext`, `InboundMessage`, `JobContext`) are not available, and resolving one
  fails at runtime with ZNIGHT013. The compiler reports it earlier when it can: a detached listener
  whose host depends, directly or transitively, on a request-scoped external is ZNIGHT070 ("pass
  what you need in the event").
- The OpenTelemetry context is a separate `AsyncLocalStorage` and is inherited: a detached listener's
  span is a child of the publication's span (with a link, §5.12).
- Detached listeners of one publication run concurrently; there is no concurrency limit in v1
  (Q8).
- Their errors are isolated: one failing listener does not affect the others. Each error is passed
  to `EventsPlugin.configure({ onError })` (default: `logger.error` with the event name, the
  listener and the error), recorded on the `events:listener` hook event, and never rethrown. An
  `onError` that throws is logged.
- `emit(event)` is `publish(event)` run in the background in a fresh scope: inline listeners still
  run in order (sharing that scope), detached ones after them, and any error, inline included, goes
  to `onError` instead of a caller.

### 5.9 Error handling summary

| Listener         | Called from | Runs in                       | A failure                                                                |
| ---------------- | ----------- | ----------------------------- | ------------------------------------------------------------------------ |
| inline (default) | `publish()` | the publisher's scope         | rejects `publish()` with the original error; later listeners are skipped |
| `detached: true` | `publish()` | a fresh scope per listener    | `onError` + hook + log; others unaffected; `publish()` already resolved  |
| inline           | `emit()`    | one fresh scope for the phase | `onError`; later inline listeners and detached ones skipped              |
| `detached: true` | `emit()`    | a fresh scope per listener    | `onError`; others unaffected                                             |

No retries: a listener that needs them is a job for `@znight/messaging` (§5.15).

### 5.10 Scopes

- A listener host follows its own scope rules: a singleton host never depends on a request-scoped
  provider (ZNIGHT003); the escape hatch is `Lazy<T>`, as anywhere.
- Inline listeners see the publisher's request scope (§5.7). That is what makes "same unit of work"
  possible: a request-scoped `UnitOfWork` or transaction handle injected in both the use case and
  the listener is the same instance.
- Detached listeners never see it (§5.8). This is also Spring's `@Async` behaviour, and the only
  one that is safe once the request has ended.

### 5.11 Lifecycle and shutdown

- `register`: supplies `EventPublisher`. `onBootstrap`: builds the registry maps; from then on
  `publish()` works. No `onStart` work: listening needs no traffic to begin.
- `onStop`: waits for in-flight detached listeners (including `emit()` work), bounded by
  `drainTimeout` (default 10 s), then logs the ones still running. Plugins stop in reverse order:
  listing `EventsPlugin` before `HttpPlugin`, `MessagingPlugin` and `SchedulePlugin` makes it stop
  after them, once no request, message or job can publish any more. The guide recommends it.
- After `onStop`, publications still work (providers' `onStop` may publish), but detached listeners
  are awaited by `publish()` itself (still isolated, still reported), so that no listener outlives
  provider disposal; `emit()` work started after `onStop` is awaited by the plugin's `onDispose`,
  with a warning.
- The plugin keeps no handle open: detached work is tracked, not kept alive with timers.

### 5.12 Observability

Two hooks in core (`ZnightHooks`), produced only when wrappers or listeners exist:

```ts
/** One publication (`publish` or `emit`) of `@znight/events`; wraps the inline phase. */
'events:publish': EventPublishEvent
/** One listener invocation of `@znight/events`, inline or detached. */
'events:listener': EventListenerEvent

export interface EventPublishEvent {
  /** Class name of the event. */
  readonly event: string
  /** The published object. */
  readonly payload: object
  readonly mode: 'publish' | 'emit'
  /** Number of inline and detached listeners matched. */
  readonly inline: number
  readonly detached: number
  readonly startTime: number
  /** First inline error, set before `next()` rejects in the wrappers. */
  error?: unknown
  /** `Class.method` of the inline listener that failed. */
  failedListener?: string
}

export interface EventListenerEvent {
  readonly event: string
  readonly payload: object
  /** `Class.method`. */
  readonly listener: string
  readonly detached: boolean
  readonly startTime: number
  error?: unknown
}
```

`@znight/observability` maps them to:

- **Traces**: a span `publish UserCreated` (internal kind) around the inline phase; a span per
  listener (`UserCreated → WelcomeMail.send`), detached ones as children with a link to the
  publication span, so a trace shows the mail sent after the HTTP response.
- **Metrics**: `znight_events_published_total{event}`,
  `znight_event_listener_duration_seconds{event,listener,detached,outcome}`.
- **Logs**: `debug` per publication, `error` per failed detached listener (the default `onError`
  defers to the observability logger when present).

Without observers, no event object is allocated (the `hasWrappers` / `hasListeners` pattern of
`MessageBroker.publish()`).

### 5.13 Testing

- **Unit tests (`TestBed`).** `EventPublisher` is an abstract class, so it is auto-mocked like any
  dependency: `expect(events.publish).toHaveBeenCalledWith(expect.any(UserCreated))`, the same
  assertion the NestJS specs make on `createMock<EventBus>()`. A listener is a method of a provider:
  `TestBed` builds its host and the test calls the method with an event.
- **Application tests (`TestApp`).** Listener hosts become default roots, like consumers and job
  hosts, so `TestApp` instantiates them. `@znight/events/testing` adds a recorder built on the two
  hooks:

  ```ts
  import { recordEvents } from '@znight/events/testing'

  const events = recordEvents(app)
  await request.post('/users').send(input)
  await events.idle() // detached listeners settled
  expect(events.of(UserCreated)).toHaveLength(1)
  expect(events.failures()).toEqual([])
  ```

  `idle()` waits for in-flight detached listeners and `emit()` work (with a timeout), like the
  memory driver's `idle()`.
- **Swapping a listener** uses the existing `TestApp` overrides of a provider; no events-specific
  API.

### 5.14 Transactions

Znight leaves the ORM to the application (`docs/guide/data-access.md`), so it has no transaction
manager to synchronise with, and v1 has no `@TransactionalEventListener`. What the guide documents
instead, as tested recipes in an example:

1. **Publish after commit** (the common case, and what the wishlist use cases do): call
   `publish()` after the transaction callback returned. Inline listeners then run after commit,
   detached ones too.
2. **Inside the transaction**: an inline listener and the use case share a request-scoped
   transaction handle (§5.10), so the listener's writes commit or roll back with the use case's.
3. **Deferred until commit**, when the publication happens deep inside a transaction: a
   request-scoped `AfterCommit` buffer collects events, and the application's transaction helper
   publishes them once the commit succeeded (and drops them on rollback). About 25 lines with
   Drizzle.

If the recipe is copied by several applications, a follow-up adds a port, not an ORM dependency:
`EventsPlugin.configure({ transactions })` with an interface the application implements
(`active()`, `afterCommit(fn)`, `afterRollback(fn)`), and `@OnEvent({ phase: 'after-commit' })`. The
option name `phase` is reserved for it (Q4).

### 5.15 Bridge to `@znight/messaging`

Out-of-process delivery is a detached listener that publishes to the broker:

```ts
export class OrderEventsRelay {
  constructor(private readonly broker: MessageBroker) {}

  @OnEvent({ detached: true })
  async relay(event: OrderPlaced): Promise<void> {
    await this.broker.publish('orders', { id: event.orderId, total: event.total }, { type: 'order.placed' })
  }
}
```

It states the serialisation explicitly, which is the point: the in-process event is a class, the
message is a contract. It is not durable (a crash between the commit and the relay loses the
message); durability needs an outbox, which is application territory today. The guide documents
the relay and the outbox caveat. A decorator (`@Externalized('orders', { type })` on the event
class, Spring Modulith style) is a follow-up only when several applications write the relay by hand
(Q7).

## 6. Compiler extension

- **Decorators**: `OnEvent` (target `method`, params: `[object?]`), declared in the extension's
  `decorators` with its identity `@znight/events#OnEvent`.
- **`analyzeClass`**: for each `@OnEvent` method, validate the target and the options; read the
  parameter `TypeInfo`; strip `| undefined` / `| null` with a ZNIGHT070 error (an event is never
  absent); split unions; require a `reference` whose identity resolves (`classInfo`) to a class
  declaration; reject type arguments; check the class can be imported (`importRoute`, else the
  ZNIGHT070 "export the event class" hint); register the host (deferred registration, as for job
  hosts) and `addRoot` it; `store` the listener data.
- **`validate`**: duplicate registrations of one method for one class (union with a supertype,
  warning); detached listeners whose host's closure reaches a request-scoped external (error);
  listeners inherited from abstract classes with no concrete provider (warning).
- **`generate`**: imports the event classes and the host classes, emits the `events` extension data
  with one typed `invoke` per listener (strict-clean under the flags of
  `packages/compiler/test/codegen/typecheck.test.ts`).
- No change to `@znight/compiler` itself.

## 7. Diagnostics

One new code, the package's catch-all, in a new block `ZNIGHT070`–`ZNIGHT079` for `@znight/events`
(the next free block after graphql; renumbered if another accepted RFC takes it first):

- **ZNIGHT070** (invalid event listener): wrong parameter count; parameter without a class type
  (interface, alias, primitive, `object`, `unknown`, `any`, inline type, no annotation); class with
  type arguments; optional or nullable event; event class not importable; invalid or unknown options;
  string argument (NestJS form); detached listener depending on a request-scoped external. Warnings:
  a union whose members overlap by inheritance; `@OnEvent` inherited by no concrete provider.

Reused codes: ZNIGHT005 for `@OnEvent` on a non-method, a static or private method; ZNIGHT003 for
scope mismatches of listener hosts; ZNIGHT013 at runtime for a request-scoped external resolved in a
detached scope; ZNIGHT021 for `publish()` before bootstrap or after disposal. Runtime listener errors
are the listeners' own errors, never wrapped (§5.7).

When accepted, the code needs, in the same change: the `ErrorCode` entry and description, a row in
§4.8 of the specification, the summary row and `## ZNIGHT070` section of
`docs/reference/error-codes.md`, the range in its frontmatter, and the block in the ranges of
`docs/test/site.test.ts`.

## 8. Specification impact

- **§5** decorator catalogue: a `@znight/events` section (`@OnEvent`).
- **§4.8** validations: the ZNIGHT070 row.
- **§7** manifest: `provides: [{ export: 'EventPublisher', plugin: 'EventsPlugin', scope: 'singleton' }]`.
- **§8.3** hooks: `events:publish`, `events:listener` and their event types.
- **New §9.8** events runtime contract: the `extensions.events` shape (§5.5), matching and ordering
  (§5.6), inline and detached dispatch (§5.7, §5.8), scopes, shutdown (§5.11).
- **§10** testing: listener hosts as default `TestApp` roots; `extensions.events` read structurally by
  `@znight/testing`, which keeps depending on no feature package.

## 9. Performance

- **No listener for an event**: one `Map` lookup on `event.constructor` after the first publication
  of that class (the first one walks the prototype chain once), then an already settled promise. No
  scope, no hook, no allocation besides the promise.
- **Inline listeners on singletons, no observers**: per listener, one container lookup of a cached
  singleton and the generated `invoke`; awaiting each listener adds one microtask per async
  listener, as a hand-written `for … await` loop would. Target, measured by a micro-benchmark in the
  package tests (not in CI): within 2× of calling the listeners directly.
- **Detached listeners**: one `setImmediate` and one `runInScope` per listener; `runInScope` has a
  fast path when no request-scoped instance is created.
- **Observers**: hook events are built only when wrappers or listeners exist.
- **Build time**: one pass over decorated methods; no call-site analysis.

## 10. Migration

### 10.1 From `@nestjs/cqrs` `EventBus`

| NestJS (`@nestjs/cqrs`)                                        | Znight (`@znight/events`)                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `CqrsModule.forRoot()` in a module                             | `EventsPlugin.configure()` in `Application.create({ plugins })`                     |
| `class UserCreatedEvent { constructor(...) {} }`               | Unchanged                                                                           |
| `@EventsHandler(UserCreatedEvent)` on a class                  | Remove it; put `@OnEvent({ detached: true })` on the method                         |
| `implements IEventHandler<UserCreatedEvent>`                   | Remove it                                                                           |
| `handle(event: UserCreatedEvent)`                              | Keep the method (rename at will); its parameter type is the subscription            |
| `@EventsHandler(A, B)` + `handle(event: A \| B)`               | `@OnEvent({ detached: true }) handle(event: A \| B)`                                |
| `constructor(private readonly eventBus: EventBus)`             | `constructor(private readonly events: EventPublisher)`                              |
| `await this.eventBus.publish(e)` or `this.eventBus.publish(e)` | `await this.events.publish(e)` (same behaviour with detached listeners, §2.4)       |
| `publishAll([a, b])`                                           | `for (const e of [a, b]) await this.events.publish(e)`                              |
| `UnhandledExceptionBus` subscription                           | `EventsPlugin.configure({ onError })`, or the `events:listener` hook                |
| Request-scoped handler with `AsyncContext`                     | An inline listener on a request-scoped host (same scope as the publisher)           |
| `AggregateRoot.apply()` + `mergeObjectContext()` + `commit()`  | The aggregate returns its events; the use case publishes them after saving          |
| `@Saga()` stream → command                                     | A listener calling the service the command handler was                              |
| Custom `IEventPublisher` to a broker                           | A relay listener to `MessageBroker` (§5.15)                                         |
| `createMock<EventBus>()` in unit specs                         | `TestBed` auto-mock of `EventPublisher`; the `toHaveBeenCalledWith` assertions stay |

Every cqrs handler maps to a **detached** listener to keep today's behaviour (§2.4). Making one
inline is a deliberate change, worth it when the handler's work must succeed for the operation to
succeed. For the wishlist: the eight handlers become detached listeners; their own `try/catch` around
e-mails can stay or move to `onError`.

### 10.2 From `@nestjs/event-emitter`

| NestJS (`@nestjs/event-emitter`)                                   | Znight (`@znight/events`)                                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `EventEmitterModule.forRoot({ wildcard: true })`                   | `EventsPlugin.configure()`                                                                     |
| `emit('order.created', new OrderCreatedEvent(...))`                | `emit(new OrderCreated(...))` (fire and forget) or `await publish(...)`                        |
| `emitAsync('order.created', payload)`                              | `await publish(new OrderCreated(...))`                                                         |
| `@OnEvent('order.created')` + `handle(payload: OrderCreatedEvent)` | `@OnEvent()` + `handle(event: OrderCreated)`: the class replaces the name (ZNIGHT070 hints it) |
| `@OnEvent('order.*')` / `'**'` (wildcards)                         | A base class (`OrderEvent`) listened to by the listener (§5.6)                                 |
| `@OnEvent(..., { async: true })`                                   | `@OnEvent({ detached: true })`                                                                 |
| `suppressErrors: true` (default)                                   | `detached: true` (errors reported, not thrown); inline errors are never suppressed             |
| `prependListener: true`                                            | `order: -1` (or lower)                                                                         |
| Payloads as plain objects                                          | Wrap them in a class                                                                           |
| `EventEmitterReadinessWatcher.waitUntilReady()`                    | Not needed: listeners are generated, ready at bootstrap                                        |

## 11. Implementation plan (milestones)

1. **M1, core prerequisites.** Hook names and event types, `ErrorCode.InvalidEventListener`
   (ZNIGHT070), spec §8.3 and error reference.
2. **M2, package.** Decorator, compiler extension (analysis, validation, codegen), `EventsPlugin`,
   `EventPublisher` with inline and detached dispatch, shutdown drain, `onError`. Compiler tests
   (fixtures per diagnostic), runtime tests on Node.js and Bun, codegen typecheck, golden test.
3. **M3, testing and observability.** `@znight/events/testing` (`recordEvents`), listener roots in
   `TestApp`, spans, metrics and logs in `@znight/observability`.
4. **M4, docs and example.** Package page, a guide page ("Application events", with the transaction
   recipes and the messaging relay), the migration guide's cqrs and event-emitter sections, an
   example using it (the `rest-api` example: an `OrderPlaced` event with an inline and a detached
   listener), the roadmap.
5. **Later, on demand**: the transaction port (Q4), `@Externalized` (Q7), a concurrency limit for
   detached listeners (Q8), typed publishers (Q6).

The wishlist migration needs M2 and M3.

## 12. Alternatives considered

- **The messaging memory driver only.** Rejected (§3): serialised payloads, no shared scope, errors
  lost to the publisher, one queue per handler for fan-out, and one driver per application.
- **A runtime emitter** (an `EventEmitter`-like service with `on(Class, fn)` registrations in
  `onStart`). Works, but discovers handlers at runtime, checks nothing at build time, loses events
  published before registration (the NestJS readiness problem), and contradicts principle 1.
- **A recipe with multi injection** (an `EventHandler<E>` interface, `handlers: EventHandler[]`
  injected in a dispatcher, `instanceof` filtering). About 30 lines, and the right stopgap today. But
  the event type is not checked against the handler, every publication loops over every handler,
  ordering and scopes are hand-made, and the dispatcher depends on every handler (a cycle as soon as
  a handler's service publishes). Kept as the documented workaround until the package ships.
- **In `@znight/core`.** Rejected for v1 (§5.1); revisited if other packages need to publish
  application events themselves.
- **Publisher-side mode only** (`publish` vs `emit`, no `detached` option). Rejected: whether a
  reaction is part of the operation is a property of the reaction, and a publisher should not need to
  know its listeners. `emit()` stays for the publisher that does not care about any outcome.
- **Isolated inline errors** (run every inline listener, then reject with an aggregate). Rejected:
  it runs the rest of a failed operation, and an `AggregateError` hides the domain error from error
  mappers. Listeners that want isolation are detached.

## 13. Open questions (decided: the recommended answers)

The owner took every recommended answer on 2026-11-04 (see the decisions under the header table).

1. **Package or core?** Recommended: package `@znight/events` (§5.1).
2. **Decorator name: `@OnEvent` or `@EventListener`?** Recommended: `@OnEvent`, consistent with
   `@OnMessage` and familiar to NestJS users; the different argument (none) is caught at build time
   with a hint.
3. **Default mode: inline or detached?** Recommended: inline (Spring, Micronaut, method-call
   semantics, errors not lost); NestJS cqrs users add `detached: true`, and the migration guide says
   so in its first line.
4. **Transaction phases.** Recommended: recipes in v1, a port plus `phase: 'after-commit'` when at
   least two applications copy the recipe.
5. **Inline error policy.** Recommended: stop at the first error and rethrow it unchanged (§5.7).
6. **Typed publishers** (`EventPublisher<UserCreated>`, Micronaut style), which would let the
   compiler resolve listeners per injection and report "published but never listened to".
   Recommended: not in v1; `publish()` call sites are not analysed. Reconsider with a `znight
   events` command listing events and listeners.
7. **`@Externalized` bridge to messaging.** Recommended: recipe first (§5.15).
8. **Concurrency limit for detached listeners.** Recommended: none in v1; add
   `EventsPlugin.configure({ detachedConcurrency })` if a burst of publications overloads a resource.
9. **Request-scoped detached listeners.** Recommended: allowed, with a fresh scope per invocation;
   a dependency on a request-scoped external is a build error (§5.8).
10. **Error code block.** Recommended: `070`–`079`, one code allocated (ZNIGHT070).

## 14. Out of scope

Command and query buses, sagas, string names and wildcards, conditions in decorators, republishing
return values, durable delivery and outbox, lifecycle events, cross-process fan-out. Each has a
mapping in §10 or a home in another package.
