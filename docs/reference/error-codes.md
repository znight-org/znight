---
description: Every Znight error code (ZNIGHT001 to ZNIGHT021) with its meaning, an example that triggers it and how to fix it.
outline: [ 2, 2 ]
---

# Error codes

Every problem Znight can detect has a stable code, shared by the compiler (build-time diagnostics)
and the runtime (`ZnightError`). Messages link here: each code has its own anchor
(`/reference/error-codes#znight001`).

| Code                    | Meaning                                             | Severity                                | Reported          |
| ----------------------- | --------------------------------------------------- | --------------------------------------- | ----------------- |
| [ZNIGHT001](#znight001) | Missing provider                                    | error                                   | build, startup    |
| [ZNIGHT002](#znight002) | Circular dependency                                 | error                                   | build, startup    |
| [ZNIGHT003](#znight003) | Scope mismatch (singleton → request)                | error                                   | build, startup    |
| [ZNIGHT004](#znight004) | Duplicate provider                                  | error                                   | build, startup    |
| [ZNIGHT005](#znight005) | Invalid decorator usage                             | error / warning                         | build, runtime    |
| [ZNIGHT006](#znight006) | Missing required configuration value                | error                                   | startup           |
| [ZNIGHT007](#znight007) | Invalid route                                       | error                                   | build             |
| [ZNIGHT008](#znight008) | Ambiguous injection                                 | error                                   | build, runtime    |
| [ZNIGHT009](#znight009) | Invalid lifecycle hook                              | error / warning                         | build             |
| [ZNIGHT010](#znight010) | Unresolvable injection type                         | error / warning                         | build             |
| [ZNIGHT011](#znight011) | Invalid message consumer                            | error                                   | build             |
| [ZNIGHT012](#znight012) | Invalid config property                             | error                                   | build             |
| [ZNIGHT013](#znight013) | Request-scoped provider outside of a request scope  | error                                   | runtime           |
| [ZNIGHT014](#znight014) | Async factory on a non-singleton provider           | error                                   | build, startup    |
| [ZNIGHT015](#znight015) | Provider instantiation failed                       | error                                   | startup, runtime  |
| [ZNIGHT016](#znight016) | Container sealed                                    | error                                   | runtime           |
| [ZNIGHT017](#znight017) | Unvalidated input                                   | warning (error with `strictValidation`) | build             |
| [ZNIGHT018](#znight018) | Version mismatch                                    | error                                   | build, startup    |
| [ZNIGHT019](#znight019) | Unused provider                                     | warning (with `reportUnused`)           | build             |
| [ZNIGHT020](#znight020) | Generated module imported by a provider module      | error                                   | build             |
| [ZNIGHT021](#znight021) | Lifecycle hook or shutdown step failed or timed out | error                                   | startup, shutdown |
| [ZNIGHT022](#znight022) | Syntax error in a source file                       | error                                   | build             |

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
token, `registerValue()` on a compiled provider (use `override()`), or the same plugin added twice to
`Application.create()`.

## ZNIGHT005: Invalid decorator usage {#znight005}

A decorator is used where it is not allowed, or with arguments the compiler cannot use. Common cases:

| Situation                                                     | Fix                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Provider class not exported (or anonymous default export)     | `export class X`                                                          |
| Static argument not evaluable: `@Controller(process.env.X)`   | Use a literal or `export const X = '...'`                                 |
| Inline value argument not evaluable: `@Body(z.object({...}))` | Extract it: `export const Schema = z.object({...})`, then `@Body(Schema)` |
| `@Provides()` outside a `@Factory()` class                    | Move it to a `@Factory()` class                                           |
| `@Provides()` without an explicit return type                 | Annotate the return type: it is what the method provides                  |
| Private, `#private` or static handler / `@Provides` method    | Make it a public instance method                                          |
| `@Injectable()` on an abstract class                          | Decorate the concrete subclasses                                          |
| `@Injectable()` on a class with unbound type parameters       | Subclass with concrete type arguments, or use `@Provides`                 |
| Class registered by several provider decorators               | Keep one (`@Injectable()` **or** `@Controller()`...)                      |
| `@Validate()` and `@Body()` on the same route                 | Use one of them                                                           |
| Composite decorator (warning)                                 | See below                                                                 |

A **composite decorator** is a function of yours returning a Znight decorator:

```ts
export const Timed = () => Intercept(TimingInterceptor) // ⚠ ZNIGHT005 (warning)
```

The compiler reads decorators from the source and never runs your code, so it cannot see through
this function. Use `@Intercept(TimingInterceptor)` directly, or declare a shorthand in a package
manifest ([AOP](/guide/aop#shorthand-decorators-in-your-own-packages)).

**At runtime**, the same code reports invalid runtime inputs: a plugin without a `name`, an invalid
provider definition passed to `register()`, an interceptor without an `intercept()` method, or an
interceptor returning a promise for a synchronous method (in development).

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
reports the same code: use the class or the full token.

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

```txt
ZNIGHT018: Unsupported metadata version 2 (generated by @znight/compiler 0.2.0): @znight/core expects version 1
  hint: Regenerate the metadata (znight generate) with a @znight/compiler version matching @znight/core
```

**How to fix**: align every `@znight/*` package on the same version, reinstall, and regenerate the
container.

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
([Deployment](/guide/deployment#graceful-shutdown-in-orchestrators)).

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
