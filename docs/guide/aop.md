---
description: Method interceptors (AOP) in Znight - @Intercept, MethodInterceptor, ordering, sync and async methods, and the observability decorators built on them.
---

# Method interceptors (AOP)

Cross-cutting concerns (timing, caching, retries, auditing, transactions) do not belong in business
code. Znight lets you wrap any provider method with **interceptors**: providers that receive the call,
decide what to do, and `proceed()` to the original method.

```ts
@Injectable()
export class UserService {
  @Intercept(TimingInterceptor, { label: 'users.find' })
  async findById(id: string): Promise<User | undefined> {
    // ...
  }
}
```

There is no runtime decorator magic: the compiler records the interceptor chain of each method in the
metadata, and the container installs it right after creating the instance.

## Writing an interceptor

An interceptor is a provider implementing `MethodInterceptor<O>`, where `O` is the type of its
options:

```ts
import { Injectable, type MethodInterceptor, type MethodInvocation } from '@znight/core'

@Injectable()
export class TimingInterceptor implements MethodInterceptor<{ label?: string }> {
  constructor(private readonly metrics: MetricsClient) {} // interceptors are injected like any provider

  async intercept(invocation: MethodInvocation, options: { label?: string }) {
    const started = performance.now()
    try {
      return await invocation.proceed()
    } finally {
      this.metrics.timing(
        options.label ?? `${invocation.className}.${invocation.methodName}`,
        performance.now() - started,
      )
    }
  }
}
```

`MethodInvocation` describes the call:

| Member           | Description                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `target`         | The instance the method is called on                                                                         |
| `className`      | Display name of the provider (`UserService`)                                                                 |
| `methodName`     | Name of the intercepted method                                                                               |
| `args`           | Arguments of this call                                                                                       |
| `isAsync`        | Whether the method is async (the interceptor must then return a promise)                                     |
| `proceed(args?)` | Calls the next interceptor, or the method itself; optionally with new arguments. May be called several times |

## Applying interceptors

`@Intercept(Interceptor, options?)` goes on a method. Options are type-checked against the
interceptor (`MethodInterceptor<O>`); they are required when `O` does not accept `undefined`.

```ts
@Injectable()
export class InvoiceService {
  @Intercept(AuditInterceptor, { action: 'invoice.issue' })
  @Intercept(RetryInterceptor, { attempts: 3 })
  async issue(order: Order): Promise<Invoice> {
    // ...
  }
}
```

- **Order**: the top-most `@Intercept` is the **outermost** interceptor. Above, `AuditInterceptor`
  sees one call, `RetryInterceptor` may call the method three times.
- **Options** are evaluated by the compiler (literals, `const` references, or a reference to an
  exported value).
- **Scopes**: interceptors are dependencies of the intercepted provider, so the
  [scope rules](./scopes#rules-between-scopes) apply: a singleton cannot be intercepted by a
  request-scoped interceptor.

## Sync and async methods

The compiler knows whether a method is async (`async` keyword or `Promise` return type) and tells the
interceptor through `invocation.isAsync`:

- for an **async** method, return a promise (an `async intercept()` is the easiest);
- for a **synchronous** method, return synchronously. In development
  (`NODE_ENV !== 'production'`), returning a promise for a sync method throws a
  [`ZNIGHT005`](/reference/error-codes#znight005) error naming the interceptor.

An interceptor meant for both can branch:

```ts
intercept(invocation: MethodInvocation) {
  const started = performance.now()
  const done = () => this.log(invocation.methodName, performance.now() - started)
  if (!invocation.isAsync) {
    try {
      return invocation.proceed()
    } finally {
      done()
    }
  }
  return (invocation.proceed() as Promise<unknown>).finally(done)
}
```

## How it works

Interceptors are installed as **own properties** of the instance, right after the factory runs, for
every scope. There is no `Proxy`:

- `#private` fields keep working;
- self-invocation is intercepted: `this.findById()` inside the class goes through the chain;
- `instance.method.name` is preserved.

Calls are dispatched through a pre-built chain, so an intercepted call costs a few function calls,
not a reflection lookup.

## Recipes

### Retry

```ts
@Injectable()
export class RetryInterceptor implements MethodInterceptor<{ attempts: number; delayMs?: number }> {
  async intercept(invocation: MethodInvocation, { attempts, delayMs = 100 }: { attempts: number; delayMs?: number }) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await invocation.proceed()
      } catch (error) {
        if (attempt >= attempts) throw error
        await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** (attempt - 1)))
      }
    }
  }
}
```

### Cache

```ts
@Injectable()
export class CacheInterceptor implements MethodInterceptor<{ ttlMs: number }> {
  constructor(private readonly cache: Cache) {}

  async intercept(invocation: MethodInvocation, { ttlMs }: { ttlMs: number }) {
    const key = `${invocation.className}.${invocation.methodName}:${JSON.stringify(invocation.args)}`
    const hit = await this.cache.get(key)
    if (hit !== undefined) return hit
    const value = await invocation.proceed()
    await this.cache.set(key, value, ttlMs)
    return value
  }
}
```

### Rewriting arguments

```ts
@Injectable()
export class TrimInterceptor implements MethodInterceptor {
  intercept(invocation: MethodInvocation) {
    return invocation.proceed(invocation.args.map(arg => (typeof arg === 'string' ? arg.trim() : arg)))
  }
}
```

## Built-in interceptor decorators

`@znight/observability` ships shorthand decorators backed by interceptors:

```ts
import { Logged, Metric, Traced } from '@znight/observability'

@Injectable()
export class PaymentService {
  @Logged({ level: 'debug' })
  @Traced()
  @Metric()
  async charge(order: Order): Promise<Receipt> {
    // ...
  }
}
```

`@Logged()` maps to `LoggedInterceptor`, `@Traced()` to `TracedInterceptor` and `@Metric()` to
`MetricInterceptor`. See [observability](/packages/observability).

<!-- TODO(api): verify against implementation (options of @Logged, @Traced, @Metric) -->

### Shorthand decorators in your own packages

A wrapper function such as `const Timed = () => Intercept(TimingInterceptor)` is **not** visible to
the compiler (it reads decorators from the source, it does not run them) and triggers a
[`ZNIGHT005`](/reference/error-codes#znight005) warning. Packages declare shorthand decorators in
their manifest instead, which is how `@Logged()` works:

::: code-group

```json [package.json]
{
  "name": "@acme/timing",
  "znight": {
    "apiVersion": 1,
    "interceptors": [{ "decorator": "Timed", "interceptor": "TimingInterceptor" }]
  }
}
```

:::

## Interceptors outside of the container

`interceptMethod()` and `applyInterceptors()` (from `@znight/core`) apply a chain to any object.
They are what the container uses, and they are handy to unit test an interceptor:

```ts
import { interceptMethod } from '@znight/core'

const service = {
  async find(id: string) {
    return { id }
  },
}
interceptMethod(service, 'find', [{ interceptor: new RetryInterceptor(), options: { attempts: 2 } }], { async: true })
await service.find('42')
```

::: info HTTP interceptors are different
`@UseInterceptor()` in `@znight/http` wraps a **route** (it sees the HTTP context and the response).
`@Intercept()` wraps a **method** of any provider. Use the former for request/response concerns and
the latter for business-level concerns.
:::
