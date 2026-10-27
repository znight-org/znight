---
description: Every Znight error code (ZNIGHT001 to ZNIGHT044) with its meaning, an example that triggers it and how to fix it.
outline: [ 2, 2 ]
---

# Error codes

Every problem Znight can detect has a stable code, shared by the compiler (build-time diagnostics)
and the runtime (`ZnightError`). Messages link here: each code has its own anchor
(`/reference/error-codes#znight001`).

Codes `ZNIGHT001` to `ZNIGHT029` belong to the core, the compiler and the features of the first
release (HTTP, messaging, configuration, observability). From `ZNIGHT030`, each package owns a block
of ten: `ZNIGHT030`–`039` for `@znight/openapi`, `ZNIGHT040`–`049` for `@znight/schedule`. Codes are
allocated in order inside a block, so the numbering has gaps between blocks.

| Code                    | Meaning                                             | Severity                                             | Reported                   |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------- | -------------------------- |
| [ZNIGHT001](#znight001) | Missing provider                                    | error                                                | build, startup             |
| [ZNIGHT002](#znight002) | Circular dependency                                 | error                                                | build, startup             |
| [ZNIGHT003](#znight003) | Scope mismatch (singleton → request)                | error                                                | build, startup             |
| [ZNIGHT004](#znight004) | Duplicate provider                                  | error                                                | build, startup             |
| [ZNIGHT005](#znight005) | Invalid decorator usage                             | error / warning                                      | build, runtime             |
| [ZNIGHT006](#znight006) | Missing required configuration value                | error                                                | startup                    |
| [ZNIGHT007](#znight007) | Invalid route                                       | error                                                | build                      |
| [ZNIGHT008](#znight008) | Ambiguous injection                                 | error                                                | build, runtime             |
| [ZNIGHT009](#znight009) | Invalid lifecycle hook                              | error / warning                                      | build                      |
| [ZNIGHT010](#znight010) | Unresolvable injection type                         | error / warning                                      | build                      |
| [ZNIGHT011](#znight011) | Invalid message consumer                            | error                                                | build, startup, runtime    |
| [ZNIGHT012](#znight012) | Invalid config property                             | error                                                | build, startup             |
| [ZNIGHT013](#znight013) | Request-scoped provider outside of a request scope  | error                                                | runtime                    |
| [ZNIGHT014](#znight014) | Async factory on a non-singleton provider           | error                                                | build, startup             |
| [ZNIGHT015](#znight015) | Provider instantiation failed                       | error                                                | startup, runtime           |
| [ZNIGHT016](#znight016) | Container sealed                                    | error                                                | runtime                    |
| [ZNIGHT017](#znight017) | Unvalidated input                                   | warning (error with `strictValidation`)              | build                      |
| [ZNIGHT018](#znight018) | Version mismatch                                    | error / warning                                      | build, startup             |
| [ZNIGHT019](#znight019) | Unused provider                                     | warning (with `reportUnused`)                        | build                      |
| [ZNIGHT020](#znight020) | Generated module imported by a provider module      | error                                                | build                      |
| [ZNIGHT021](#znight021) | Lifecycle hook or shutdown step failed or timed out | error                                                | startup, runtime, shutdown |
| [ZNIGHT022](#znight022) | Syntax error in a source file                       | error                                                | build                      |
| [ZNIGHT023](#znight023) | Missing route decision                              | error (a warning at boot with `enforcement: 'warn'`) | build, startup             |
| [ZNIGHT030](#znight030) | Invalid OpenAPI definition                          | error / warning                                      | build, startup             |
| [ZNIGHT031](#znight031) | Undocumented response                               | warning (error with `strict`)                        | build                      |
| [ZNIGHT032](#znight032) | Unrepresentable type                                | warning / error (error with `strict`)                | build                      |
| [ZNIGHT033](#znight033) | Duplicate operation id                              | error                                                | build                      |
| [ZNIGHT034](#znight034) | Schema name conflict                                | error                                                | build, startup, runtime    |
| [ZNIGHT035](#znight035) | Inconsistent operation                              | error / warning                                      | build                      |
| [ZNIGHT036](#znight036) | Invalid security requirement                        | error / warning                                      | build                      |
| [ZNIGHT037](#znight037) | Schema conversion failed                            | error (warning with `unrepresentable: 'warn'`)       | build, startup, runtime    |
| [ZNIGHT040](#znight040) | Invalid schedule                                    | error / warning                                      | build, startup, runtime    |
| [ZNIGHT041](#znight041) | Duplicate job                                       | error                                                | build, startup, runtime    |
| [ZNIGHT042](#znight042) | Unknown job                                         | error                                                | startup, runtime           |
| [ZNIGHT043](#znight043) | Missing lock store                                  | error                                                | startup                    |
| [ZNIGHT044](#znight044) | Job aborted                                         | error value (never thrown)                           | runtime                    |

## Reading an error

**Build-time diagnostics** have a code, a message, a location with a code frame, hints and sometimes
related locations:

```txt
✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService
  --> src/notification/notification.service.ts:12:5
   |
12 |     private readonly email: EmailService,
   |                             ^^^^^^^^^^^^
   = hint: Add @Injectable() to EmailService (src/email/email.service.ts:3)
```

**Runtime errors** are `ZnightError` instances: `error.code` (`'ZNIGHT001'`), `error.hints`, and
`error.cause` when they wrap another error. Errors raised while cleaning up after a failure are
attached to the original error: read them with `getSuppressedErrors(error)`.

```ts
import { ErrorCode, ZnightError } from '@znight/core'

try {
  await Application.create({ metadata: __ZNIGHT_METADATA__, plugins })
} catch (error) {
  if (error instanceof ZnightError && error.code === ErrorCode.MissingProvider) {
    console.error(error.message, error.hints)
  }
  throw error
}
```

::: info
Messages on this page illustrate the format; the exact wording of build-time diagnostics may evolve.
Codes never change meaning.
:::

## ZNIGHT001: Missing provider {#znight001}

A dependency is required but nothing provides it.

**At build time**, the compiler found no candidate for a constructor or `@Provides` parameter:

```ts
export class EmailService {} // no @Injectable()

@Injectable()
export class NotificationService {
  constructor(private readonly email: EmailService) {}
}
```

```txt
✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService
  --> src/notification/notification.service.ts:3:39
   = hint: Add @Injectable() to EmailService (src/email/email.service.ts:1)
```

The message includes a **near-miss analysis**: a class with the same name in another file (both
import paths shown), an undecorated class, a matching class excluded by `include`/`exclude`, a class
with the right name but no `implements` clause, candidates removed by a qualifier.

**At startup**, a value expected from a plugin or from `providers` was not supplied:

```txt
ZNIGHT001: A required provider is missing:
  - Logger (@znight/observability#Logger), provided by ObservabilityPlugin, required by UserService
  hint: Add ObservabilityPlugin to Application.create({ plugins })
```

**How to fix**

- Decorate the class (`@Injectable()`, `@Controller()`...) and export it.
- Check that its file is matched by `include` and not by `exclude`.
- For an interface, make sure an implementation declares `implements TheInterface`.
- For a plugin-provided type, add the plugin; for your own runtime values, list the identity in the
  compiler's `externals` option and supply it in a plugin or in `Application.create({ providers })`.
- If the dependency is genuinely optional, mark it optional (`?`, `| undefined` or `@Optional()`).

## ZNIGHT002: Circular dependency {#znight002}

Providers depend on each other in a cycle, so none of them can be created first.

```ts
@Injectable()
export class OrderService {
  constructor(private readonly payments: PaymentService) {}
}

@Injectable()
export class PaymentService {
  constructor(private readonly orders: OrderService) {}
}
```

```txt
✗ ZNIGHT002: Circular dependency: OrderService -> PaymentService -> OrderService
  --> src/orders/order.service.ts:3:40
   = hint: Inject one of these dependencies as Lazy<T> and call get() when needed
```

At runtime, the same code is used when runtime definitions form a cycle, or when `Lazy<T>.get()` is
called from a constructor or factory while that provider is being created.

**How to fix**

- Break one edge with `Lazy<T>`:
  `constructor(private readonly orders: Lazy<OrderService>) {}`, then `this.orders.get()` in a method.
- Often better: extract the shared logic into a third provider both depend on, or decouple with
  events.
- Never call `Lazy.get()` in a constructor: call it later (in a method or `onStart()`).

## ZNIGHT003: Scope mismatch {#znight003}

A singleton depends on a request-scoped provider (directly, or through transients, arrays, guards,
interceptors or plugin-provided values). A singleton lives for the whole application and cannot hold
the instance of one request.

```ts
@Injectable({ scope: 'request' })
export class CurrentUser {}

@Injectable() // singleton
export class AuditService {
  constructor(private readonly user: CurrentUser) {}
}
```

```txt
✗ ZNIGHT003: Scope mismatch: singleton AuditService depends on request-scoped CurrentUser
  --> src/audit/audit.service.ts:3:39
   = hint: Inject it as Lazy<T> and call get() inside the request, or make AuditService request-scoped
```

**How to fix**

- Inject `Lazy<CurrentUser>` and call `get()` while handling the request.
- Or make the dependent request-scoped (its own dependents must then follow).
- Or pass the value as a method argument.

Singleton → transient is allowed: the singleton owns its transient instance. See
[Scopes](/guide/scopes#rules-between-scopes).

## ZNIGHT004: Duplicate provider {#znight004}

Several providers provide the **exact same type** and nothing tells the compiler which one to inject.

```ts
@Factory()
export class DatabaseFactory {
  @Provides()
  primary(): Pool {
    return new Pool({ connectionString: process.env.DATABASE_URL })
  }

  @Provides()
  replica(): Pool {
    return new Pool({ connectionString: process.env.REPLICA_URL })
  }
}

@Injectable()
export class ReportRepository {
  constructor(private readonly pool: Pool) {} // which one?
}
```

**How to fix**

- Name them (`@Provides({ name: 'replica' })`) and select with `@Inject('replica')`.
- Or mark the default one `@Primary()` (`@Provides({ primary: true })`).

**At runtime**, the same code reports conflicting registrations: two plugins registering the same
token, `registerValue()` on a compiled provider (use `override()`), the same plugin added twice to
`Application.create()`, or one `HttpPlugin.configure()` instance used by a second application while
the first one still runs (call `HttpPlugin.configure()` once per application; an instance can serve
another application once the previous one stopped).

## ZNIGHT005: Invalid decorator usage {#znight005}

A decorator is used where it is not allowed, or with arguments the compiler cannot use. Common cases:

| Situation                                                                                            | Fix                                                                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Provider class not exported (or anonymous default export)                                            | `export class X`                                                          |
| Static argument not evaluable: `@Controller(process.env.X)`                                          | Use a literal or `export const X = '...'`                                 |
| Inline value argument not evaluable: `@Body(z.object({...}))`                                        | Extract it: `export const Schema = z.object({...})`, then `@Body(Schema)` |
| `@Provides()` outside a `@Factory()` class                                                           | Move it to a `@Factory()` class                                           |
| `@Provides()` without an explicit return type                                                        | Annotate the return type: it is what the method provides                  |
| Private, `#private` or static handler / `@Provides` method                                           | Make it a public instance method                                          |
| `@Injectable()` on an abstract class                                                                 | Decorate the concrete subclasses                                          |
| `@Injectable()` on a class with unbound type parameters                                              | Subclass with concrete type arguments, or use `@Provides`                 |
| Class registered by several provider decorators                                                      | Keep one (`@Injectable()` **or** `@Controller()`...)                      |
| Provider exported as a type only (`export type { X }`)                                               | Export it as a value: `export { X }` or `export class X`                  |
| Parameter decorator imported from another package (`Headers` of `@znight/http` on a message handler) | Import it from the package of the handler (`@znight/messaging` here)      |
| `@Validate()` and `@Body()` on the same route                                                        | Use one of them                                                           |
| Composite decorator or `const` alias of a decorator (warning)                                        | See below                                                                 |

A **composite decorator** is a function of yours returning a Znight decorator:

```ts
export const Timed = () => Intercept(TimingInterceptor) // ⚠ ZNIGHT005 (warning)
```

The compiler reads decorators from the source and never runs your code, so it cannot see through
this function. Use `@Intercept(TimingInterceptor)` directly, or declare a shorthand in a package
manifest ([AOP](/guide/aop#shorthand-decorators-in-your-own-packages)).

A `const` alias is not followed either (`export const Service = Injectable`: classes decorated with
`@Service()` are **not** providers). Re-export the decorator under another name instead, which the
compiler follows:

```ts
export const Service = Injectable // ⚠ ZNIGHT005 (warning): @Service() is ignored

// instead: a re-export, followed by the compiler
export { Injectable as Service } from '@znight/core'
```

**At runtime**, the same code reports invalid runtime inputs: a plugin without a `name`, an invalid
provider definition passed to `register()`, an interceptor without an `intercept()` method, an
interceptor returning a promise for a synchronous method (in development), a negative or `NaN`
shutdown budget (`shutdown.timeoutMs` / `hookTimeoutMs`; `Infinity` means no limit), or invalid
options of the observability interceptors and metrics.

## ZNIGHT006: Missing required configuration value {#znight006}

A `@Config()` class has required properties with no value in any configured source. The
`ConfigPlugin` validates every config class when it registers and reports all problems at once.

```ts
@Config('mail')
export class MailConfig {
  @Secret('MAIL_API_KEY')
  apiKey!: string // required: no default, not optional
}
```

```txt
ZNIGHT006: Missing required configuration values:
  - MailConfig.apiKey (env MAIL_API_KEY)
```

**How to fix**

- Provide the value (environment, `.env` file, config file or secret store, depending on your
  loaders).
- Or give it a default (`@Default(...)` or an initializer), or make it optional (`apiKey?: string`).

## ZNIGHT007: Invalid route {#znight007}

A route cannot be served as declared.

```ts
@Controller('/users')
export class UserController {
  @Get('/:id(\\d+)') // ✗ regular expressions are not part of the path grammar
  get(@Param('id') id: number) {}

  @Get('/:id') // ✗ duplicate GET /users/:id
  other(@Param('id') id: string) {}

  @Get('/:id/posts/:postId') // ✗ :postId has no @Param()
  posts(@Param('id') id: number) {}

  @Get('/by-date/:date')
  byDate(@Param('date') date: Date) {} // ✗ Date cannot be coerced from a path segment
}
```

**How to fix**

- Paths use static segments, `:name` parameters and a trailing `*` only. Validate formats with a
  schema instead: `@Param('id', IdSchema)`.
- Remove or rename duplicate method + path pairs.
- Declare a `@Param()` for every `:name` of the path.
- Type path and query parameters as `string`, `number`, `boolean`, literal unions or arrays of those,
  or use a schema to transform the value.

## ZNIGHT008: Ambiguous injection {#znight008}

Several providers implement or extend the requested type, none is an exact match, and none is
`@Primary()`.

```ts
@Injectable()
export class StripeGateway implements PaymentGateway {}

@Injectable()
export class PaypalGateway implements PaymentGateway {}

@Injectable()
export class CheckoutService {
  constructor(private readonly payments: PaymentGateway) {} // ✗ Stripe or PayPal?
}
```

**How to fix**

- Mark the default implementation `@Primary()`.
- Or qualify: `@Named('paypal')` on the class, `@Inject('paypal')` on the parameter.
- Or inject the concrete class, or all of them with `PaymentGateway[]`.

**At runtime**, `container.get('UserService')` with a display name shared by several providers
reports the same code: use the class or the full token. A class that is not a registered key
(`container.get(PaymentGateway)` for an abstract class without alias) is looked up by its name too,
but only among the candidates of its class hierarchy (candidates whose class is unknown, such as a
plugin value, count only when none matches): ZNIGHT008 then means several providers of that
hierarchy share the name.

## ZNIGHT009: Invalid lifecycle hook {#znight009}

A lifecycle method (`onStart`, `onReady`, `onStop`) cannot be called by the container.

```ts
@Injectable()
export class Scheduler {
  onStart(config: SchedulerConfig) {} // ✗ hooks receive no arguments
  static onStop() {} // ✗ must be an instance method
}

@Injectable({ scope: 'request' })
export class RequestCache {
  onStart() {} // ⚠ warning: never called on request-scoped or transient providers
}
```

**How to fix**: inject what the hook needs through the constructor, make hooks instance methods
without required parameters, and only rely on hooks in singletons (use `[Symbol.asyncDispose]()` for
request-scoped cleanup).

## ZNIGHT010: Unresolvable injection type {#znight010}

The compiler cannot turn a parameter type into something it can bind.

```ts
@Injectable()
export class Notifier {
  constructor(
    private readonly send: (to: string) => Promise<void>, // ✗ function type: opaque
    private readonly options: { retries: number }, // ✗ object literal type: opaque
    private readonly region: string, // ✗ primitive without a qualifier
    private readonly client, // ✗ no type annotation
  ) {}
}
```

Other causes: an import that does not resolve, or a class inheriting its constructor from something
that cannot be analysed (`class X extends Mixin(Base)`). An import whose casing differs from the file
on disk is reported as a warning.

**How to fix**

- Give every parameter a named type: a class, an interface or a type alias of one.
- Qualify primitives: `@Inject('region') region: string`, provided by
  `@Provides({ name: 'region' })`, or use a `@Config()` class.
- Declare an explicit constructor in classes extending mixins.
- Fix the import path or its casing.

## ZNIGHT011: Invalid message consumer {#znight011}

A `@Consumer()` cannot be subscribed as declared.

```ts
@Consumer('orders')
export class OrderConsumer {} // ✗ no @OnMessage() handler

@Consumer('payments')
export class PaymentConsumer {
  @OnMessage('payment.done') a() {}
  @OnMessage('payment.done') b() {} // ✗ two handlers for the same type

  @OnMessage('payment.failed')
  @Retry({ attempts: 0 }) // ✗ invalid retry options
  c() {}
}
```

**How to fix**: give each consumer at least one handler, make handler types unique (one default
handler without type at most), and use positive `attempts`, `delay` and `maxDelay` values.

**At startup**, `MessagingPlugin` reports with the same code what only the runtime knows, and
`Application.create()` (or `app.start()` for the subscriptions) fails:

- invalid plugin options: a `driver` that is not a messaging driver, a `defaults.concurrency` that
  is not a positive integer, a `defaults.deadLetter` that is neither a function nor `false`...;
- a `@Retry` policy the driver cannot honour (a delay longer than its native delayed redelivery,
  such as Kafka's `maxRetryDelayMs`);
- a topology the driver cannot use when it subscribes: a queue that does not exist (SQS, RabbitMQ
  with `assertTopology: false`), a queue RabbitMQ refuses to declare, a Kafka consumer group shared
  by two topics.

**At runtime**, the first delayed publication of a RabbitMQ connection rejects with ZNIGHT011 when
the shared delay levels (`znight.delays.*`) cannot be declared, e.g. because they exist with other
arguments (another `queueType`): set `rabbitmq({ delayLevelPrefix })`.

## ZNIGHT012: Invalid config property {#znight012}

A configuration property cannot be loaded.

```ts
@Config('cache')
export class CacheConfig {
  @Env('CACHE_EXPIRES_AT')
  expiresAt!: Date // ✗ unsupported type
}

@Injectable()
export class Mailer {
  @Env('SMTP_HOST') // ✗ @Env outside a @Config class
  host!: string
}
```

**How to fix**: use a supported type (`string`, `number`, `boolean`, `string[]`, `number[]`, `URL`,
literal unions, JSON) and parse richer values in your code, and keep `@Env` / `@Secret` / `@Key` /
`@Default` inside `@Config()` classes.

**At startup**, the same code reports invalid runtime inputs of `@znight/config`: invalid
`ConfigPlugin.configure()` options, invalid loader options (`vault({ kvVersion: 3 })`...) and config
metadata that is not what the compiler generates (hand-written or corrupted). Missing or invalid
**values** are [`ZNIGHT006`](#znight006).

## ZNIGHT013: Request-scoped provider outside of a request scope {#znight013}

A request-scoped provider (or request-scoped value such as `HttpContext`) was resolved where no
request scope is active.

```ts
const app = await Application.create({ metadata: __ZNIGHT_METADATA__, plugins })
app.get(CurrentUser) // ✗ no request is being handled
```

```txt
ZNIGHT013: CurrentUser (src/auth/current-user.ts#CurrentUser) is request-scoped and was resolved outside of a request scope
  hint: Resolve it inside container.runInScope()
  hint: In singletons, inject it as Lazy<T> and call get() during the request
```

Variants: the scope was already closed (work started by a request kept running after the response),
or a request-scoped external was never seeded in the scope.

**How to fix**

- Resolve it inside `container.runInScope(fn, values)`, or while handling a request/message.
- In singletons, inject `Lazy<T>` and call `get()` during the request.
- Await everything a request starts inside the scope; pass plain values to background work.

## ZNIGHT014: Async factory on a non-singleton provider {#znight014}

Async factories are awaited once during startup, so they are only allowed for singletons.

```ts
@Factory()
export class TxFactory {
  @Provides({ scope: 'request' })
  async begin(pool: Pool): Promise<Transaction> {
    // ✗ async + request scope
    return pool.begin()
  }
}
```

**How to fix**: make it a singleton, or provide a synchronous object with async methods (a
`TransactionManager` whose `run(fn)` opens the transaction) and await inside the consumer.

## ZNIGHT015: Provider instantiation failed {#znight015}

A constructor or factory threw (or rejected). The error is an `InstantiationError` carrying the
failing `token`, the dependency `path`, the `source` location when known, and the original error as
`cause`.

```txt
ZNIGHT015: Failed to instantiate DatabaseFactory.createPool: connect ECONNREFUSED 127.0.0.1:5432
  token: src/db/db.factory.ts#DatabaseFactory.createPool
  at: src/db/db.factory.ts:8:3
  dependency path: UserController -> UserService -> PgUserRepository -> DatabaseFactory.createPool
```

Instances created before the failure are disposed in reverse order; cleanup failures are attached
(`getSuppressedErrors(error)`). The same code is used when resolving from a container that is not
initialised, failed to initialise or was disposed.

**How to fix**: read `error.cause` (the real failure: network, configuration, a bug in the
constructor). Keep constructors cheap; move I/O to async factories or `onStart()`.

## ZNIGHT016: Container sealed {#znight016}

A registration (`register`, `registerValue`, `provide`, `override`, `registerExternal`) happened after
`container.init()`: the graph is validated and frozen at that point.

```ts
const app = await Application.create({ metadata: __ZNIGHT_METADATA__ })
app.container.registerValue(ClockToken, fakeClock) // ✗ too late
```

**How to fix**: pass values to `Application.create({ providers, overrides })`, or register them in a
plugin's `register()` hook.

## ZNIGHT017: Unvalidated input {#znight017}

A non-primitive `@Body()`, `@Query()` or `@Message()` parameter has no schema: its type is only a
compile-time promise, nothing checks what clients actually send.

```ts
@Post('/')
create(@Body() input: CreateUserDto) {} // ⚠ ZNIGHT017
```

**How to fix**: pass a schema and derive the type from it:

```ts
export const CreateUserSchema = z.object({ email: z.email(), name: z.string() })

@Post('/')
create(@Body(CreateUserSchema) input: z.infer<typeof CreateUserSchema>) {}
```

It is a warning by default; enable the compiler's `strictValidation` option to make it an error.

## ZNIGHT018: Version mismatch {#znight018}

Incompatible versions were combined:

- the metadata format version is not supported by `@znight/core` (metadata generated by another
  compiler version);
- `@znight/*` packages with different minor versions (they are released in lockstep);
- a compiler extension or a package manifest with an unsupported `apiVersion`, or two extensions with
  the same name.

The same code reports broken contracts between packages, which usually come from a version skew
too:

- a malformed `package.json#znight` manifest entry, or a malformed entry of a compiled provider
  library (`dist/znight.providers.json` of another version): the entry is skipped and the compile
  goes on;
- a compiler extension that fails to load, throws or produces invalid code (the message names it);
- a third-party compiler extension that is not listed in `trustedExtensions` (a warning: the
  extension is not loaded).

```txt
ZNIGHT018: Unsupported metadata version 2 (generated by @znight/compiler 0.2.0): @znight/core expects version 1
  hint: Regenerate the metadata (znight generate) with a @znight/compiler version matching @znight/core
```

**How to fix**: align every `@znight/*` package on the same version, reinstall, rebuild provider
libraries with the same compiler, and regenerate the container.

## ZNIGHT019: Unused provider {#znight019}

With `reportUnused: true`, the compiler warns about providers that are not reachable from any
**root**. Roots are:

- providers registered by compiler extensions: controllers (with their guards and interceptors),
  consumers, config classes...;
- providers with an `onStart`, `onReady` or `onStop` hook;
- providers referenced as a **value** in your code, outside of types, imports, decorators and
  `extends` (`app.get(UserService)`, an `overrides` entry...); referencing an abstract class or an
  interface counts for the provider it is aliased to.

Everything a root depends on (constructor parameters, `@Provides` parameters, multi, lazy,
interceptors, guards...) is used.

```ts
@Injectable()
export class LegacyExporter {} // ⚠ ZNIGHT019 when nothing injects it
```

String lookups (`container.get('LegacyExporter')`) are not seen by the compiler: reference the class
instead, or keep `reportUnused` off.

**How to fix**: delete dead code, or keep it on purpose. Providers that do work on their own through
lifecycle hooks may legitimately have no dependents. `prune: true` drops unreachable providers from
the generated module instead of warning.

## ZNIGHT020: Generated module imported by a provider module {#znight020}

A provider module imports the generated container, directly or through another module (often
`main.ts`). The generated module imports every provider module, so this creates an ESM cycle: some
classes are still uninitialised when they are used (`Cannot access 'UserService' before
initialization`).

```ts
// src/users/user.service.ts
import { __ZNIGHT_METADATA__ } from '../.znight/container.generated.js' // ✗
```

**How to fix**: import the generated module only from entry points (`main.ts`, tests, scripts). A
provider that needs the container injects `Container` from `@znight/core`.

The check does not depend on the generated file being on disk (fresh checkout): relative imports
and imports through an alias of a directory (`@/.znight/container.generated.js` with tsconfig
`paths: { "@/*": ["./src/*"] }`, package `imports`, Vite aliases) are recognised before the file
exists. An alias pointing at the generated file itself is only recognised once the file exists.

## ZNIGHT021: Lifecycle hook or shutdown step failed or timed out {#znight021}

A provider hook (`onStart`, `onReady`, `onStop`), a plugin hook or a disposal threw or exceeded its
timeout.

- During **start**, the first failure stops what was started, disposes everything and is rethrown
  (`app.state === 'failed'`).
- During **stop**, every step is still attempted; failures are collected into a
  `ZnightAggregateError` whose `errors` lists each failed step.

```txt
ZNIGHT021: The application stopped with 2 error(s)
  1. ZNIGHT021: Plugin "messaging" onStop() timed out after 5000ms
  2. ZNIGHT021: Disposing DatabaseFactory.createPool failed: Connection terminated
```

**How to fix**: inspect `error.errors` (and each `cause`). For timeouts, make hooks finish faster or
raise `shutdown.hookTimeoutMs` / `shutdown.timeoutMs`, keeping them below your platform's grace period
([Deployment](/guide/deployment#graceful-shutdown-in-orchestrators)); `Infinity` disables a budget.

The same code reports lifecycle misuse:

- an HTTP adapter instance bootstrapped by a second application: create one per application, e.g.
  `HttpPlugin.configure(() => ({ adapter: fastifyAdapter() }))`;
- **at runtime**, an operation on something already stopped (`MessageBroker.publish()` once the
  messaging plugin is disposed, `inject()` on a stopped `HttpPlugin`) and a failing disposal of a
  request-scoped instance.

## ZNIGHT022: Syntax error in a source file {#znight022}

A file matched by `include` (or a provider library file) could not be parsed. The compiler reports
it before any other diagnostic and skips the file, so its providers are missing from the graph —
which usually causes ZNIGHT001 errors elsewhere. Fix the syntax error first.

```txt
✗ ZNIGHT022: Unexpected token, expected ";"
  --> src/users/user.service.ts:14:12
```

**How to fix**: correct the syntax error (your editor or `tsc --noEmit` shows the same location),
or exclude the file with the compiler `exclude` option if it is not application code.

## ZNIGHT023: Missing route decision {#znight023}

<!-- TODO(api): verify against implementation (RFC 0001, route decision groups) -->

A route decorator group declared `required` must have a decision on every route, and a guard must
enforce it. Decorators of one group are alternatives: one decision per route, the route's decision
replacing the controller's.

```ts
export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })

@Controller('/books')
export class BookController {
  @Get() @Public() list() {}
  @Delete('/:id') remove() {} // ✗ ZNIGHT023: no "access" decision
}
```

```txt
✗ ZNIGHT023: Route DELETE /books/:id (BookController.remove) has no "access" decision
  --> src/books/book.controller.ts:8:3
   = hint: Add @Public() or @Roles(...) to the route or to BookController
```

**At startup**, `HttpPlugin` checks that each decision is enforced: a guard of the route's chain
(global, controller or route guards) must list the group's decorators in its static `enforces`.
This catches a forgotten `guards: [AuthGuard]`, and a required group the compiler did not see
(no decorator of the group is applied in the application). All routes are reported in one error:

```txt
ZNIGHT023: No guard enforces the required "access" group on 9 routes: GET /books (BookController.list), POST /books (BookController.create), ...
  hint: Register a guard declaring `static enforces = [Public, Roles]`: HttpPlugin.configure({ guards: [AuthGuard] })
```

**How to fix**

- Add a decision of the group to the route, or to its controller for every route at once.
- Register a guard that enforces the group, usually a global one
  (`HttpPlugin.configure({ guards: [AuthGuard] })`), and declare what it enforces:
  `static readonly enforces = [Public, Roles]`.
- A test that runs without guards on purpose turns the boot check into a warning:
  `HttpPlugin.configure({ enforcement: 'warn' })`.

Two decisions of one group on the same target, or decorators of a group disagreeing on `required`,
are [`ZNIGHT005`](#znight005).

## ZNIGHT030: Invalid OpenAPI definition {#znight030}

<!-- TODO(api): verify against implementation (RFC 0002, @znight/openapi) -->

The catch-all code of `@znight/openapi`: a documentation decorator or option the compiler or the
plugin cannot use. Common cases:

| Situation                                                                                                               | Fix                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `@ApiResponse`, `@ApiQuery`... on a class that is not a `@Controller()`, or on a method that is not a route handler     | Move it to a route handler (or its controller) |
| A second `@OpenApiDocument()` class                                                                                     | Keep one per application                       |
| Invalid `@OpenApiDocument()` options (unknown key, wrong type, a value that is not static)                              | Use the documented options with literal values |
| An invalid static value: status code, media type, tag, header name, operation id, `x-` key, a `$znight` key in a schema | Use a valid value                              |
| A malformed `securityScheme()` definition                                                                               | Follow the OpenAPI Security Scheme Object      |

```ts
@OpenApiDocument({ info: { title: 'Bookshelf' } })
export class BookshelfApi {}

@OpenApiDocument({ info: { title: 'Admin' } }) // ✗ ZNIGHT030: a second @OpenApiDocument
export class AdminApi {}

@Controller('/books')
export class BookController {
  @Get()
  @ApiOperation({ operationId: 'list books' }) // ✗ ZNIGHT030: an operation id matches ^[A-Za-z_][\w.-]*$
  list() {}
}
```

**At startup**, `OpenApiPlugin` reports with the same code: invalid plugin options, an application
without `HttpPlugin`, and metadata without an OpenAPI section (import `@znight/openapi` in a scanned
file and regenerate). Two warnings: declared relative `servers` that do not end with the HTTP
prefix, and a prebuilt document (`document: { file }`) generated from other metadata than the
running application's.

## ZNIGHT031: Undocumented response {#znight031}

<!-- TODO(api): verify against implementation (RFC 0002, @znight/openapi) -->

The success response of an operation comes from the annotated return type of its handler. The
compiler cannot document it when the return type is missing, `any`, `unknown`, an `HttpResponse`
without type argument or a Web `Response`, or when the handler writes the reply itself (`@Res()`).

```ts
@Post()
async create(@Body(CreateBook) input: CreateBook): Promise<HttpResponse> {} // ⚠ ZNIGHT031
```

```txt
⚠ ZNIGHT031: The 201 response of POST /books (BookController.create) cannot be documented: HttpResponse has no body type
  --> src/books/book.controller.ts:96:54
   = hint: Give the body type: Promise<HttpResponse<BookResponse>>
   = hint: Or declare it: @ApiResponse<BookResponse>(201)
```

**How to fix**: annotate the body type (`Promise<HttpResponse<BookResponse>>`), or declare the
response with `@ApiResponse<BookResponse>(201)` (the only way for a Web `Response`). It is a warning
by default; `@OpenApiDocument({ strict: true })` makes it an error.

## ZNIGHT032: Unrepresentable type {#znight032}

<!-- TODO(api): verify against implementation (RFC 0002, @znight/openapi) -->

A documented type has no JSON Schema, or the JSON the route sends is not what the type says.

| Type                                                                                                     | Severity                                                 |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `bigint` in a JSON body                                                                                  | error: `JSON.stringify` throws, so the route answers 500 |
| `Map`, `Set`, `WeakMap`, `RegExp`, `Error`, typed arrays inside JSON                                     | warning: serialised as `{}` or with numeric keys         |
| Mapped and conditional types other than `Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `NonNullable` | warning                                                  |
| A class with a `toJSON()` method whose return type is not annotated                                      | warning                                                  |
| Functions, symbols, unbound type parameters, opaque types                                                | warning, documented as `{}`                              |
| A JSDoc tag with an invalid value (`@minimum ten`)                                                       | warning, at the tag                                      |

```ts
export interface ShelfStats {
  readonly total: bigint // ✗ ZNIGHT032
}
```

```txt
✗ ZNIGHT032: ShelfStats.total is a bigint: JSON.stringify throws on bigint, so GET /books/stats (BookController.stats) would answer 500
  --> src/books/book.ts:58:19
  ::: src/books/book.controller.ts:140:12
   = note: returned by BookController.stats
   = hint: Return a number or a string (String(total)), or give ShelfStats a toJSON() method
```

**How to fix**: send JSON-friendly types (numbers, strings, plain objects and arrays), give classes
a `toJSON(): X` method with an annotated return type, or document the response with a schema
(`@ApiResponse(200, { schema })`). With `strict: true`, the warnings are errors.

## ZNIGHT033: Duplicate operation id {#znight033}

<!-- TODO(api): verify against implementation (RFC 0002, @znight/openapi) -->

Two operations have the same `operationId`. Ids name the functions of generated clients, so they
must be unique. By default an id is `<controller>.<handler>` (`book.list`): two controllers with
the same name in different folders collide.

```txt
✗ ZNIGHT033: Duplicate operation id "book.list": admin/BookController.list and catalog/BookController.list
  --> src/admin/book.controller.ts:14:3
  ::: src/catalog/book.controller.ts:22:3
   = hint: Rename one controller, or set an id: @ApiOperation({ operationId: 'adminBook.list' })
```

**How to fix**: rename one controller or handler, set an explicit id with
`@ApiOperation({ operationId })`, or pick another naming strategy
(`@OpenApiDocument({ operationIds })`).

## ZNIGHT034: Schema name conflict {#znight034}

<!-- TODO(api): verify against implementation (RFC 0002, @znight/openapi) -->

Two different schemas would get the same name in `components.schemas`. At build time, two
declarations with the same name (two `Book` interfaces in different modules); when the document is
assembled, a schema hoisted from the `$defs` of a converted schema, or the `XInput` variant of a
schema, that clashes with another component.

```ts
// src/catalog/book.ts
export interface Book {
  readonly id: number
  readonly title: string
}

// src/admin/book.ts
export interface Book {
  readonly id: number
  readonly archived: boolean // ✗ ZNIGHT034 when both are documented
}
```

**How to fix**: rename one of the declarations (`AdminBook`). For converted schemas, rename the
schema export or the definition it names in its `$defs`. `HttpErrorBody` and `ValidationErrorBody`
are reserved while standard error responses are on.

## ZNIGHT035: Inconsistent operation {#znight035}

<!-- TODO(api): verify against implementation (RFC 0002, @znight/openapi) -->

The documentation contradicts what the route does.

| Situation                                                                                  | Severity |
| ------------------------------------------------------------------------------------------ | -------- |
| A response body declared on 204 or 304                                                     | error    |
| A success status other than the route's (`@HttpCode`, else 201 for POST and 200 otherwise) | error    |
| `@ApiQuery('x')` next to `@Query('x')`, `@ApiBody` next to `@Body(S)`                      | error    |
| A documented `accept`, `content-type` or `authorization` header                            | error    |
| `@ApiBody` on a GET or HEAD route                                                          | warning  |
| `@ApiExclude()` together with other `@Api*` decorators                                     | warning  |

```ts
@Delete('/:id')
@ApiResponse<BookResponse>(204) // ✗ ZNIGHT035: a 204 response has no body
remove(@Param('id') id: number): Promise<void> {}
```

**How to fix**: let the signature speak (parameters, `@Body(S)`, the return type) and keep the
`@Api*` decorators for what it cannot say. Document authentication with a security scheme
(`securityScheme()`, `@ApiSecurity`) instead of an `authorization` header.

## ZNIGHT036: Invalid security requirement {#znight036}

<!-- TODO(api): verify against implementation (RFC 0002, @znight/openapi) -->

A security requirement or a security decision cannot be documented:

- a requirement that is not a `securityScheme()`;
- scopes on a scheme other than `oauth2` and `openIdConnect`, or scopes no flow of the scheme
  declares;
- one scheme name for two different definitions;
- a `decisions[].when` that is not a route decorator, or `scopes: 'value'` on a decorator whose
  value is not a static string array;
- a decision that no route uses (warning).

```ts
export const OAuth = securityScheme('oauth2', {
  type: 'oauth2',
  flows: { clientCredentials: { tokenUrl: 'https://id.example.com/token', scopes: { reader: 'Read books' } } },
})

@Post()
@ApiSecurity({ scheme: OAuth, scopes: ['admin'] }) // ✗ ZNIGHT036: 'admin' is not a scope of oauth2
create() {}
```

**How to fix**: declare every scope in the flows of the scheme, give each scheme a unique name, and
point `decisions` at the route decorators your routes use.

## ZNIGHT037: Schema conversion failed {#znight037}

<!-- TODO(api): verify against implementation (RFC 0002, @znight/openapi) -->

A schema of the application (`@Body(S)`, `@Query(S)`, `@ApiResponse(200, { schema })`...) could not
be converted to JSON Schema while the document was assembled: at boot (or on the first request with
`build: 'first-request'`), when `znight openapi` writes the file, or in a test. The message names
the schema, its library, the direction (input or output) and its source location.

- No converter answers: the library implements neither Standard JSON Schema nor a built-in
  fallback.
- A converter throws, or returns something other than an object.
- A whole-object `@Query(S)`, `@Param(S)` or `@Headers(S)` schema is not an object schema, so it
  cannot be split into parameters.

**How to fix**: use a schema library that implements Standard JSON Schema (Zod, for example) or has a
built-in fallback (Valibot, with the optional `@valibot/to-json-schema`), or pass a converter:
`OpenApiPlugin.configure({ converters: [myConverter] })`. With `unrepresentable: 'warn'`, a schema
that cannot be converted is documented as `{}` with a warning instead of failing.

## ZNIGHT040: Invalid schedule {#znight040}

<!-- TODO(api): verify against implementation (RFC 0004, @znight/schedule) -->

The catch-all code of `@znight/schedule`: a job whose schedule or options cannot be used. The
compiler checks every literal it can read, and reports the field at fault.

| Situation                                                                                         | Example message                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Cron syntax: field count, unknown token, value out of range, step 0, reversed range               | `hour 24 is out of range (0-23)`                                                    |
| A cron expression that never fires                                                                | `'0 0 30 2 *' never fires: February has no day 30`                                  |
| `@reboot`                                                                                         | `use runOnStart: true or @Timeout(0)`                                               |
| A wildcard minute under a fixed hour (warning)                                                    | `'* 9 * * *' fires every minute from 09:00 to 09:59`                                |
| An invalid duration: unit, negative, fractional ms, over 366 days, `@Interval(0)`                 | `'5 min' is not a duration: use '5m' (ms, s, m, h, d)`                              |
| A bare number below 100 for `@Interval` or `maxDuration` (warning)                                | `@Interval(5) runs every 5 ms: did you mean '5s'?`                                  |
| An unknown time zone                                                                              | `Unknown time zone 'Europe/Pari' (did you mean 'Europe/Paris'?)`                    |
| An unknown option, a wrong option type, an invalid job name, `lock: true` with `overlap: 'allow'` | `Unknown option 'timezone' (did you mean 'timeZone'?)`                              |
| A job method with parameters other than `ctx: JobContext`                                         | `OutboxJobs.flush(batch: Batch) is called with (ctx: JobContext)`                   |
| A request-scoped host depending on an HTTP or messaging request value (warning)                   | `CatalogImport depends on HttpContext, which does not exist during a scheduled run` |

```ts
export class DigestJobs {
  @Cron('0 25 * * *', { name: 'digest.daily' }) // ✗ ZNIGHT040: hour 25 is out of range (0-23)
  sendDaily() {}
}
```

```txt
✗ ZNIGHT040: Invalid cron expression for job 'digest.daily': hour 25 is out of range (0-23)
  --> src/digest/digest.jobs.ts:2:15
```

**At startup**, `SchedulePlugin` reports with the same code what only the runtime knows: invalid
plugin options, invalid `jobs` overrides (`{ 'digest.daily': { cron: '...' } }`), hand-written
metadata, and a time zone the runtime's `Intl` does not know. **At runtime**, `parseCron`,
`parseDuration`, `registry.addCron` / `addInterval` / `addTimeout` and `reschedule` throw it for
invalid values.

**How to fix**: follow the message and the hint. Cron expressions have 5 fields (6 with seconds),
durations are a number of milliseconds or a number with a unit (`'500ms'`, `'30s'`, `'5m'`, `'1h'`,
`'1d'`), and time zones are IANA names (`'Europe/Paris'`), `'UTC'`, `'local'` or an offset
(`'+02:00'`).

## ZNIGHT041: Duplicate job {#znight041}

<!-- TODO(api): verify against implementation (RFC 0004, @znight/schedule) -->

Two jobs share a name. Names identify jobs in the registry, in overrides, in locks and in
metrics, so they are unique across the application and its libraries. The default name is
`<Class>.<method>`; a method with several triggers needs a name for each.

```ts
export class ReportJobs {
  @Cron('0 8 * * *', { name: 'sync' })
  daily() {}

  @Interval('1h', { name: 'sync' }) // ✗ ZNIGHT041: Job name 'sync' is used twice
  hourly() {}
}
```

**How to fix**: give each job its own `name`. At runtime, `registry.addCron()` (and the other `add*`
methods) throw it for a name already taken: `remove()` the job first, or use `reschedule()`.

## ZNIGHT042: Unknown job {#znight042}

<!-- TODO(api): verify against implementation (RFC 0004, @znight/schedule) -->

No job has this name: a key of the `jobs` overrides of `SchedulePlugin.configure()` (at startup,
with a did-you-mean hint), or the name given to `registry.trigger()` or `registry.remove()`.

```ts
SchedulePlugin.configure({ jobs: { 'digest.dialy': { enabled: false } } }) // ✗ ZNIGHT042
```

```txt
ZNIGHT042: No job named 'digest.dialy' (jobs option of SchedulePlugin)
  hint: Did you mean 'digest.daily'?
```

**How to fix**: use the job's name: its `name` option, else `<Class>.<method>`.
`registry.jobs()` lists every job, dynamic ones included.

## ZNIGHT043: Missing lock store {#znight043}

<!-- TODO(api): verify against implementation (RFC 0004, @znight/schedule) -->

A job requires a lock (`lock: true`: one runner per occurrence across instances), but
`SchedulePlugin` has no lock store. Running the job on every replica would break the guarantee it
asks for, so the application does not start.

```ts
@Cron('0 2 * * *', { name: 'invoices.send', lock: true }) // ✗ ZNIGHT043 without a lock store
send() {}
```

**How to fix**: configure a store shared by the instances
(`SchedulePlugin.configure({ lock: { store: new PostgresLockStore(db) } })`, see the scheduling
guide for Postgres and Redis recipes), or `memoryLockStore()` for a single instance and tests.
Remove `lock: true` if every instance may run the job.

## ZNIGHT044: Job aborted {#znight044}

<!-- TODO(api): verify against implementation (RFC 0004, @znight/schedule) -->

The code of `JobAbortedError`, the `reason` of `ctx.signal` when a run is aborted. The framework
never throws it: a job sees it through its signal, and stops at its next checkpoint.

| `reason`    | When                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| `timeout`   | The run exceeded its `maxDuration`                                          |
| `lock-lost` | The lease of a locked job could not be renewed: another instance may run it |
| `removed`   | The job was removed from the registry while it ran                          |
| `shutdown`  | The application stops and the run did not finish within the drain timeout   |

```ts
@Cron('*/10 * * * * *', { name: 'outbox.flush', maxDuration: '30s' })
async flush(ctx: JobContext): Promise<void> {
  for (const batch of await this.outbox.pendingBatches()) {
    ctx.signal.throwIfAborted() // throws the JobAbortedError (ZNIGHT044)
    await this.broker.publishAll(batch)
  }
}
```

**How to fix**: nothing is wrong with the scheduler. Check `ctx.signal` between steps and pass it to
the APIs that accept one, so an aborted run stops quickly; raise `maxDuration` if runs are
legitimately slower; keep the lock `ttl` comfortably above the time a heartbeat may be delayed.
