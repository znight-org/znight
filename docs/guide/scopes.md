---
description: Singleton, request and transient scopes, the rules the compiler enforces between them, request scopes with AsyncLocalStorage and Lazy<T>.
---

# Scopes

A provider's **scope** decides how long its instances live.

| Scope                 | Instances                                                   | Typical use                                    |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `singleton` (default) | One for the whole application, created during startup       | Services, repositories, clients, controllers   |
| `request`             | One per request scope (HTTP request, message delivery)      | Current user, per-request caches, unit of work |
| `transient`           | A new one for every injection (and every `container.get()`) | Stateful helpers owned by their consumer       |

```ts
@Injectable({ scope: 'request' })
export class CurrentUser {
  constructor(private readonly context: HttpContext) {}

  get id(): string {
    // read from the request (e.g. a header set by an auth guard)
  }
}

@Injectable({ scope: 'transient' })
export class QueryBuilder {}
```

## Rules between scopes

A provider must not outlive what it depends on. The compiler checks every edge of the graph,
including edges through transients, arrays, guards, interceptors and plugin-provided values:

| Dependent ↓ / dependency → | singleton | request                                           | transient             |
| -------------------------- | --------- | ------------------------------------------------- | --------------------- |
| **singleton**              | ✓         | ✗ [`ZNIGHT003`](/reference/error-codes#znight003) | ✓ (owns its instance) |
| **request**                | ✓         | ✓ (same scope)                                    | ✓                     |
| **transient**              | ✓         | ✓ only when used from a request-scoped consumer   | ✓                     |

A singleton is created once, at startup, outside of any request: it cannot hold the instance of one
particular request. The compiler rejects it:

```txt
✗ ZNIGHT003: Scope mismatch: AuditService (singleton) depends on CurrentUser (request)
  --> src/audit/audit.service.ts:7:40
   = hint: Inject Lazy<CurrentUser> and call get() while handling a request
   = hint: Or make AuditService request-scoped
```

## Using request data from a singleton: `Lazy<T>`

Most services should stay singletons. When one needs the current request's data, inject a
`Lazy<T>` handle and resolve it **while the request is being handled**:

```ts
@Injectable()
export class AuditService {
  constructor(
    private readonly log: AuditLog,
    private readonly currentUser: Lazy<CurrentUser>,
  ) {}

  async record(action: string) {
    await this.log.append({ action, userId: this.currentUser.get().id }) // this request's CurrentUser
  }
}
```

Alternatively, pass the value as a method argument, or make the consumer request-scoped (its own
dependents then need to be request-scoped or use `Lazy` too).

## Request scopes

Request scopes are opened by plugins: `@znight/http` opens one per HTTP request and
`@znight/messaging` one per message delivery. Inside, request-scoped providers are created on first
use and shared by everything resolved in the same scope; concurrent requests never share instances
(scopes are isolated with `AsyncLocalStorage`).

Plugins seed the scope with **request-scoped externals**, such as `HttpContext` or `InboundMessage`,
that your request-scoped providers can inject.

You can open a scope yourself, for example in a script or a custom plugin:

```ts
const report = await app.container.runInScope(
  async () => app.container.get(ReportService).generate(),
  [['@acme/jobs#JobContext', { jobId: 'nightly-report' }]], // seed values: [token or class, value]
)
```

- When `fn` settles, instances created in the scope are disposed in reverse creation order
  (`[Symbol.asyncDispose]()` / `[Symbol.dispose]()`).
- `container.currentScope()` returns the active scope (`get`, `set`, `has`), or `undefined`.
- Resolving a request-scoped provider outside of any scope throws
  [`ZNIGHT013`](/reference/error-codes#znight013). So does resolving it after the scope closed: await
  everything a request starts inside the `runInScope()` callback.

## Transient providers

A transient provider gives every consumer its own instance. Use it for objects with per-consumer
state:

```ts
@Injectable({ scope: 'transient' })
export class RateLimiter {
  #tokens = 10
  tryAcquire(): boolean {
    return this.#tokens-- > 0
  }
}

@Injectable()
export class EmailService {
  constructor(private readonly limiter: RateLimiter) {} // its own RateLimiter
}
```

Transient instances belong to their consumer: the container never calls their lifecycle hooks nor
disposes them.

## Async providers and scopes

Async factories (`@Provides()` returning `Promise<T>`) are awaited once, during startup, so they are
only allowed for singletons. An async request-scoped or transient factory is
[`ZNIGHT014`](/reference/error-codes#znight014): make it a singleton, or provide a synchronous object
with async methods (a connection pool rather than a connection).

## Controllers and consumers

Controllers and consumers are singletons by default, which is the fastest option. They accept a
`scope` too, for example `@Controller({ path: '/me', scope: 'request' })`; prefer `Lazy<T>` or
request-scoped collaborators when only part of the logic needs request data.
