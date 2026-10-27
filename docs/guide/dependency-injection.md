---
description: Providers, constructor injection by class and interface, qualifiers, @Primary, multi, optional and lazy dependencies, factories with @Provides and externals.
---

# Dependency injection

Znight wires your application from **type annotations**. You declare what a class needs in its
constructor; the compiler finds a provider for each parameter, checks the whole graph and generates
the code that creates everything in the right order.

## Providers

A provider is a class the container instantiates. Declare it with `@Injectable()` and export it:

```ts
import { Injectable } from '@znight/core'

@Injectable()
export class PasswordHasher {
  hash(password: string): Promise<string> {
    // ...
  }
}
```

`@Injectable()` accepts static options:

| Option    | Default       | Description                                                                   |
| --------- | ------------- | ----------------------------------------------------------------------------- |
| `scope`   | `'singleton'` | `'singleton'`, `'request'` or `'transient'` (see [Scopes](./scopes))          |
| `name`    | —             | A qualifier, same as [`@Named()`](#qualifiers-named-and-inject)               |
| `primary` | `false`       | Preferred candidate, same as [`@Primary()`](#several-implementations-primary) |

Other decorators also declare providers: `@Controller()` ([HTTP](/packages/http)), `@Consumer()`
([messaging](/packages/messaging)), `@Config()` ([config](/packages/config)), `@Factory()`
([below](#factories-factory-and-provides)).

::: info Arguments must be static
Decorators are read by the compiler, not executed. Options such as `scope` or `name` must be
statically evaluable: literals, `const` references (even imported), simple expressions. Something
like `@Injectable({ scope: process.env.SCOPE })` is rejected with
[`ZNIGHT005`](/reference/error-codes#znight005).
:::

## Constructor injection

Each constructor parameter is a dependency. Parameter properties or plain parameters both work:

```ts
@Injectable()
export class SignupService {
  readonly #mailer: Mailer

  constructor(
    private readonly users: UserRepository, // parameter property
    private readonly hasher: PasswordHasher,
    mailer: Mailer, // plain parameter
  ) {
    this.#mailer = mailer
  }
}
```

Rules worth knowing:

- Every parameter **needs a type annotation** the compiler can resolve to a declaration. Function
  types, object literal types or `typeof x` are opaque:
  [`ZNIGHT010`](/reference/error-codes#znight010).
- `import type` is fine: only the generated module imports values.
- A class without its own constructor **inherits** the nearest one in its `extends` chain, with type
  arguments substituted (`class UserRepo extends Repository<User>`).
- `extends Mixin(Base)` cannot be analysed: declare an explicit constructor.

## Tokens

Every provider is identified by a **token**: the canonical identity of its declaration.

| Provider                        | Token                                       |
| ------------------------------- | ------------------------------------------- |
| Class in your application       | `src/users/user.service.ts#UserService`     |
| Class exported by a package     | `@acme/auth#JwtService`                     |
| `@Provides` method              | `src/db/db.factory.ts#DbFactory.createPool` |
| Provided at runtime by a plugin | `@znight/observability#Logger`              |

Two classes named `UserService` in different files never collide. Error messages use the **display
name** (the part after `#`). You rarely write tokens yourself: the public API is class-first.

## Injecting interfaces and base classes

Interfaces and abstract classes are first-class injection types. The compiler collects the
`implements` / `extends` closure of every provider and binds the parameter to the provider that
matches:

```ts
export interface PaymentGateway {
  charge(cents: number, card: string): Promise<string>
}

@Injectable()
export class StripeGateway implements PaymentGateway {
  async charge(cents: number, card: string): Promise<string> {
    // ...
  }
}

@Injectable()
export class CheckoutService {
  constructor(private readonly payments: PaymentGateway) {} // → StripeGateway
}
```

Generic types are matched with their type arguments, so `Repository<User>` and `Repository<Order>`
are different injection types:

```ts
export abstract class Repository<T> {
  abstract findById(id: string): Promise<T | undefined>
}

@Injectable()
export class UserRepository extends Repository<User> {
  /* ... */
}

@Injectable()
export class AuditService {
  constructor(private readonly users: Repository<User>) {} // → UserRepository
}
```

::: tip The binding is structural only through declarations
Znight matches on declared heritage (`implements`, `extends`), not on structural compatibility: a
class that happens to have the right methods but no `implements PaymentGateway` clause is not a
candidate. The `ZNIGHT001` message points it out when it finds such a near miss.
:::

## Several implementations: `@Primary()`

When several providers match an interface, the injection is ambiguous
([`ZNIGHT008`](/reference/error-codes#znight008)). Mark the default one with `@Primary()`:

```ts
@Injectable()
@Primary()
export class StripeGateway implements PaymentGateway {}

@Injectable()
export class PaypalGateway implements PaymentGateway {}

@Injectable()
export class CheckoutService {
  constructor(private readonly payments: PaymentGateway) {} // → StripeGateway
}
```

You can always inject a concrete class directly (`PaypalGateway`): an **exact** match wins over
classes that merely implement the type.

## Qualifiers: `@Named()` and `@Inject()`

Name providers with `@Named()` (or the `name` option) and select one at the injection point with
`@Inject()`:

```ts
@Injectable()
@Named('stripe')
export class StripeGateway implements PaymentGateway {}

@Injectable()
@Named('paypal')
export class PaypalGateway implements PaymentGateway {}

@Injectable()
export class RefundService {
  constructor(@Inject('paypal') private readonly payments: PaymentGateway) {}
}
```

The qualifier narrows the candidates of the declared type: `@Inject('paypal') x: PaymentGateway` only
considers `PaymentGateway` providers named `paypal`.

## Primitives and values

`string`, `number` and other primitives say nothing about _which_ value you want, so they always
need a qualifier. Provide the value with a named `@Provides` method:

```ts
@Factory()
export class ApiFactory {
  @Provides({ name: 'apiBaseUrl' })
  apiBaseUrl(): string {
    return 'https://api.example.com/v2'
  }
}

@Injectable()
export class ApiClient {
  constructor(@Inject('apiBaseUrl') private readonly baseUrl: string) {}
}
```

For configuration values, prefer typed [`@Config()` classes](/packages/config): they are injected by
class, validated at boot and testable.

## Multi injection

A parameter typed as an array receives **every** matching provider:

```ts
export interface HealthIndicator {
  check(): Promise<{ name: string; healthy: boolean }>
}

@Injectable()
export class DatabaseHealth implements HealthIndicator {}

@Injectable()
export class CacheHealth implements HealthIndicator {}

@Injectable()
export class HealthService {
  constructor(private readonly indicators: HealthIndicator[]) {} // [CacheHealth, DatabaseHealth]

  async report() {
    return Promise.all(this.indicators.map(indicator => indicator.check()))
  }
}
```

Multi injection never fails: with no provider you get an empty array. Providers are ordered by token
(deterministic, by file path); sort them yourself if order matters. A qualifier (`@Inject('x')`)
filters the list.

## Optional dependencies

A dependency is optional when it is marked with `?`, typed `| undefined` or `| null`, has a default
value, or is decorated with `@Optional()`. Without a provider, `undefined` is injected instead of
failing the build:

```ts
@Injectable()
export class ReportService {
  constructor(
    private readonly db: Database,
    @Optional() private readonly tracer: Tracer | undefined,
    private readonly cache?: Cache, // undefined when no Cache provider exists
  ) {}
}
```

## Lazy dependencies

`Lazy<T>` injects a handle instead of the instance. `get()` resolves the dependency when called, in
the **current** scope:

```ts
import { Injectable, type Lazy } from '@znight/core'

@Injectable()
export class OrderService {
  constructor(private readonly payments: Lazy<PaymentService>) {}

  async place(order: Order) {
    await this.payments.get().charge(order) // resolved now, not at construction
  }
}
```

It is the escape hatch for two situations the compiler otherwise rejects:

- **cycles** ([`ZNIGHT002`](/reference/error-codes#znight002)): `A → B → A` becomes legal when one of
  the edges is lazy;
- **a singleton using a request-scoped value** ([`ZNIGHT003`](/reference/error-codes#znight003)):
  `Lazy<CurrentUser>` resolves the instance of the request being handled. See [Scopes](./scopes).

Do not call `get()` from a constructor or a factory: call it later, in a method or in `onStart()`.

## Factories: `@Factory()` and `@Provides()`

Some objects are not your classes (database pools, SDK clients) or need setup code. Declare them
with a `@Factory()` class whose `@Provides()` methods build them:

```ts
import { Factory, Provides } from '@znight/core'
import { Pool } from 'pg'

@Factory()
export class DatabaseFactory {
  constructor(private readonly config: DatabaseConfig) {}

  @Provides({ dispose: 'end' })
  async createPool(): Promise<Pool> {
    const pool = new Pool({ connectionString: this.config.url })
    await pool.query('select 1') // fail fast at boot
    return pool
  }
}

@Injectable()
export class PgUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {} // the resolved Pool, not a promise
}
```

- The **explicit return type** is what the method provides. `Promise<T>` makes the provider async: it
  is awaited during startup and consumers receive `T`. Async factories are only allowed for
  singletons ([`ZNIGHT014`](/reference/error-codes#znight014)).
- Method **parameters are injected** like constructor parameters (qualifiers, optional and `Lazy`
  included).
- `@Provides()` accepts `scope`, `name`, `primary` and `dispose`, the name of a method called on
  shutdown (`'end'`, `'close'`, `'quit'`...). Without it, `[Symbol.asyncDispose]()` /
  `[Symbol.dispose]()` are used when present.
- The factory class itself is a singleton provider; `@Provides` outside a `@Factory()` is an error.

Independent async factories start **concurrently** during `init()`: a database pool and a Redis
client connect in parallel.

## Values supplied at runtime (externals)

Some types are provided at runtime rather than compiled: the `Logger` of
`@znight/observability`, the request's `HttpContext`, `MessageBroker`... Packages declare them in
their manifest, so injecting them just works; the generated metadata lists them as **externals** and
the container checks at boot that the corresponding plugin supplied them:

```ts
import { Logger } from '@znight/observability'

@Injectable()
export class UserService {
  constructor(private readonly logger: Logger) {} // supplied by ObservabilityPlugin
}
```

Forgot the plugin? `Application.create()` fails with
[`ZNIGHT001`](/reference/error-codes#znight001) naming it.

You can also supply or replace values yourself when creating the application:

```ts
const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  providers: [[Clock, systemClock]], // keys: classes or tokens
})
```

Your own runtime-provided types (supplied by a custom plugin) are declared to the compiler with the
`externals` option: `znight({ externals: ['src/clock.ts#Clock'] })`. See [Plugins](./plugins).

## Resolving from the container

You rarely need it outside of `main.ts`, plugins and tests, but the container is available:

```ts
const container = app.container

container.get(UserService) // by class
container.get(Repository) // abstract class → its only (or primary) implementation
container.get('PaymentGateway') // interface or class, by unique display name (or full token)
container.getOptional(Cache) // undefined when there is no provider
container.has(Cache)
container.tokenOf(UserService) // 'src/users/user.service.ts#UserService'
```

Providers can inject the container itself (`Container` from `@znight/core`), as well as the
`Application`, `Hooks` and the core logger.

## How a dependency is bound

For each injection point of type `T` (with an optional qualifier), the compiler applies the same
algorithm:

![How a dependency is bound: collect the candidates (providers of T and of its subtypes, only those named q with a qualifier). T[]: all of them, ordered by token. No candidate: a runtime-provided type binds to the external, an optional dependency to undefined, otherwise ZNIGHT001. One or more: the unique exact candidate, else the unique @Primary(), else the single candidate is bound; otherwise ZNIGHT004 (duplicate) or ZNIGHT008 (ambiguous)](/diagrams/binding.svg)

1. **Candidates**: providers providing exactly `T`, plus providers whose `extends`/`implements`
   closure contains `T`.
2. **Qualifier**: with `@Inject('q')`, keep only candidates named `q`.
3. **Array** (`T[]`): inject every candidate, ordered by token.
4. **Single**: one exact candidate → bound; otherwise the unique `@Primary()` → bound; otherwise a
   single candidate → bound; otherwise several providers of the same type →
   [`ZNIGHT004`](/reference/error-codes#znight004), several implementations →
   [`ZNIGHT008`](/reference/error-codes#znight008).
5. **No candidate**: a type declared as runtime-provided by a package → external; an optional
   dependency → `undefined`; otherwise [`ZNIGHT001`](/reference/error-codes#znight001), with hints
   about near misses (same name in another file, missing `@Injectable()`, excluded file, missing
   `implements`...).
6. **Primitives** require a qualifier ([`ZNIGHT010`](/reference/error-codes#znight010) otherwise).
7. **`Lazy<T>`** binds `T` with the same rules.

The full specification lives in the [architecture document](/contributing/architecture).
