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

Cache the result of an expensive async method for a while: the key is derived from the arguments,
the time to live comes from the options, and the values live in a store you inject, in memory to
start with.

::: code-group

```ts [src/cache/cache.store.ts]
import { Injectable } from '@znight/core'

/** Where cached values live. Swap the implementation (Redis...) without touching the interceptor. */
export interface CacheStore {
  /** The entry, or `undefined` when absent or expired (a cached `undefined` is `{ value: undefined }`) */
  get(key: string): Promise<{ value: unknown } | undefined>
  set(key: string, value: unknown, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
}

@Injectable()
export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, { value: unknown; expiresAt: number }>()

  async get(key: string) {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return { value: entry.value }
  }

  async set(key: string, value: unknown, ttlMs: number) {
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  async delete(key: string) {
    this.#entries.delete(key)
  }
}
```

```ts [src/cache/cache.interceptor.ts]
import { Injectable, type MethodInterceptor, type MethodInvocation } from '@znight/core'
import type { CacheStore } from './cache.store.js'

export interface CacheOptions {
  /** Time to live of an entry, in milliseconds. */
  ttlMs: number
  /** Key prefix. Default: `<Class>.<method>`. */
  prefix?: string
}

/** The cache key of a call: the prefix and the arguments (ids, strings, plain objects). */
export function cacheKey(invocation: MethodInvocation, options: CacheOptions): string {
  const prefix = options.prefix ?? `${invocation.className}.${invocation.methodName}`
  return `${prefix}:${JSON.stringify(invocation.args)}`
}

@Injectable()
export class CacheInterceptor implements MethodInterceptor<CacheOptions> {
  /** Calls in flight: concurrent identical calls share one execution. */
  readonly #pending = new Map<string, Promise<unknown>>()

  constructor(private readonly store: CacheStore) {}

  intercept(invocation: MethodInvocation, options: CacheOptions) {
    if (!invocation.isAsync) return invocation.proceed() // a synchronous method must stay synchronous
    const key = cacheKey(invocation, options)
    let pending = this.#pending.get(key)
    if (pending === undefined) {
      pending = this.#load(key, invocation, options.ttlMs).finally(() => this.#pending.delete(key))
      this.#pending.set(key, pending)
    }
    return pending
  }

  async #load(key: string, invocation: MethodInvocation, ttlMs: number): Promise<unknown> {
    const hit = await this.store.get(key)
    if (hit !== undefined) return hit.value
    const value = await invocation.proceed() // a failure is not cached
    await this.store.set(key, value, ttlMs)
    return value
  }
}
```

```ts [src/products/product.service.ts]
import { Injectable, Intercept } from '@znight/core'
import { CacheInterceptor } from '../cache/cache.interceptor.js'

@Injectable()
export class ProductService {
  constructor(private readonly products: ProductRepository) {}

  @Intercept(CacheInterceptor, { ttlMs: 60_000 })
  async findById(id: string): Promise<Product | undefined> {
    return this.products.findById(id) // runs at most once a minute per id
  }
}
```

:::

- `CacheInterceptor` injects the `CacheStore` **interface**: the compiler binds it to its only
  implementation. To use Redis in production, add a `RedisCacheStore implements CacheStore` and
  mark it `@Primary()` (or remove the memory store); two implementations without `@Primary()` are
  [`ZNIGHT008`](/reference/error-codes#znight008).
- The memory store is per process and only drops an expired entry when it is read again: bound it
  (an LRU) for keys that never come back, or use a shared store when you run several instances.
- Keys serialise the arguments with `JSON.stringify`: fine for ids, strings and plain objects, not
  for class instances or `bigint`. Pass a `prefix` to share entries between methods, and invalidate
  an entry after a write by injecting `CacheStore` and calling `delete(key)`.
- Cached values are shared between callers: return immutable data (or copy it).
- Options are evaluated at build time, so they are literals or exported constants
  (`{ ttlMs: PRODUCT_TTL_MS }`).

A dedicated `@znight/cache` package is on the [roadmap](/roadmap#znight-cache). Until it lands,
this recipe is the recommended way to cache method results; declare a shorthand such as `@Cached()`
for it in a package manifest ([below](#shorthand-decorators-in-your-own-packages)).

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
`MetricInterceptor`, provided at runtime by `ObservabilityPlugin`. Their options are literals,
validated when the application is created (a bad option fails `Application.create()` with
[`ZNIGHT005`](/reference/error-codes#znight005)):

| Decorator   | Options                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Logged()` | `level` (`'debug'`), `errorLevel` (`'error'`), `args` / `result` (log them, `false`), `message` (`<Class>.<method>()`)                        |
| `@Traced()` | `name` (`<Class>.<method>`), `attributes` (static span attributes), `kind` (`'internal'`, `'server'`, `'client'`, `'producer'`, `'consumer'`) |
| `@Metric()` | `type` (`'histogram'` of durations, or `'counter'`), `name`, `help`, `labels` (static), `buckets`                                             |

Synchronous methods stay synchronous; async methods are measured until their promise settles. See
[observability](/packages/observability).

### Shorthand decorators in your own packages

A wrapper function such as `const Timed = () => Intercept(TimingInterceptor)` is **not** visible to
the compiler (it reads decorators from the source, it does not run them) and triggers a
[`ZNIGHT005`](/reference/error-codes#znight005) warning, like a `const` alias
(`export const Service = Injectable`). Renaming works through a re-export
(`export { Injectable as Service } from '@znight/core'`), also from a package of yours (a preset
re-exporting Znight decorators: the compiler extension of the package declaring them is loaded).
Packages declare shorthand decorators in their manifest instead, which is how `@Logged()` works:

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
