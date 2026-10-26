# @znight/core

The runtime of [Znight](../../README.md): a dependency injection container driven by **compile-time
metadata**, the application lifecycle, plugins, hooks, request scopes, method interceptors (AOP) and
the marker decorators.

`@znight/compiler` analyses your sources at build time and generates `__ZNIGHT_METADATA__`: every
provider, its dependencies, its scope and a precomputed resolution order. `@znight/core` only executes
that plan. There is no `reflect-metadata`, no runtime type lookup, and resolving a singleton is a
single `Map` lookup.

```sh
bun add @znight/core
bun add -d @znight/compiler vite
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only). Decorators require
`"experimentalDecorators": true` in your `tsconfig.json`.

## Quick start

```ts
// src/users/user.service.ts
import { Injectable, type OnStart } from '@znight/core'

@Injectable()
export class UserService implements OnStart {
  constructor(private readonly repository: UserRepository) {}

  async onStart() {
    await this.repository.warmUp()
  }

  findById(id: string) {
    return this.repository.findById(id)
  }
}
```

```ts
// src/main.ts
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000 })],
})
await app.start() // SIGINT / SIGTERM trigger a graceful app.stop()
```

## Decorators

Decorators are **markers**: they do nothing at runtime (each returns the same shared no-op function)
and the compiler reads them from the AST. Arguments must be statically evaluable (literals, `const`
references...).

| Decorator                                          | Target                              | Purpose                                                    |
| -------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `@Injectable({ scope?, name?, primary? })`         | class                               | Declares a provider (`singleton` by default)               |
| `@Factory()`                                       | class                               | A singleton whose `@Provides` methods produce providers    |
| `@Provides({ scope?, name?, primary?, dispose? })` | method of a `@Factory`              | Provides the method's return type (`Promise<T>` → async)   |
| `@Inject(name)`                                    | constructor / `@Provides` parameter | Injects the provider qualified with `name`                 |
| `@Optional()`                                      | constructor / `@Provides` parameter | Injects `undefined` when no provider exists                |
| `@Named(name)` / `@Primary()`                      | class / `@Provides` method          | Qualifier / preferred candidate                            |
| `@Intercept(Interceptor, options?)`                | method                              | Wraps calls with an interceptor provider (see [AOP](#aop)) |

```ts
@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'end' })
  async createPool(config: DatabaseConfig): Promise<Pool> {
    const pool = new Pool({ connectionString: config.url })
    await pool.query('select 1')
    return pool
  }
}
```

## Application

`Application.create(options)` builds the container and runs the plugins:

1. supplies `providers`, runs each plugin's `register` (in order), applies `overrides`;
2. `container.init()`: validates the graph and instantiates singletons;
3. runs each plugin's `onBootstrap`.

If anything fails, everything created so far is disposed (plugins receive `onDispose`) and the error
is rethrown.

`providers` and `overrides` accept a `Map`, an iterable of `[key, value]` pairs or a record keyed by
token; keys may be tokens or classes. Override values that look like a provider definition
(`{ scope, deps, factory }`) are registered as definitions.

| Option      | Description                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `metadata`  | The generated `__ZNIGHT_METADATA__`.                                                            |
| `plugins`   | Runtime features (`HttpPlugin`, `MessagingPlugin`, `ConfigPlugin`...).                          |
| `providers` | Values for externals or replacements of compiled providers (see below).                         |
| `overrides` | Same shape as `providers`, applied last with the highest precedence. Ideal for tests.           |
| `logger`    | Initial `CoreLogger` (console by default). Replace it later with `app.setLogger()`.             |
| `shutdown`  | `{ signals?: ShutdownSignal[] \| false, timeoutMs?: 10_000, hookTimeoutMs?: 5_000, process? }`. |
| `init`      | Forwarded to `container.init()`, e.g. `{ only: [UserController] }`.                             |
| `hot`       | Pass `import.meta.hot` to stop the application when the module is replaced.                     |

**`app.start()`** runs providers' `onStart` (resolution order: dependencies first), plugins' `onStart`
(start listening), then providers' and plugins' `onReady`. Signal handlers are installed when the start
begins. If a step fails, what was started is stopped, everything is disposed and the error is rethrown.

**`app.stop()`** is idempotent and waits for an in-progress start. It runs three phases:

1. plugins' `onStop`, in reverse order (stop ingress, drain in-flight work);
2. for each provider in reverse resolution order: `onStop` (if it was started), then disposal;
3. plugins' `onDispose`, in reverse order (close connections, flush buffers).

Every step is attempted, each within `hookTimeoutMs` and all within `timeoutMs`. Failures are collected
into a `ZnightAggregateError` (`ZNIGHT021`, `error.errors`).

On `SIGINT`/`SIGTERM` the application stops gracefully. `process.exitCode` is set to `1` when this
shutdown fails, and a second signal forces `process.exit(130)`. An explicit `app.stop()` never touches
the exit code.

`app.state` is one of `created`, `starting`, `ready`, `stopping`, `stopped` or `failed`.

## Lifecycle

Singletons are duck-typed: implement any of these methods, no registration needed.

```ts
@Injectable()
export class Scheduler implements OnStart, OnReady, OnStop {
  onStart() {} // after the container is ready, dependencies first
  onReady() {} // once every provider and plugin started
  onStop() {} // on shutdown, dependents first (only if onStart ran)
  async [Symbol.asyncDispose]() {} // always called on shutdown / rollback
}
```

Disposal calls the `dispose` method declared with `@Provides({ dispose })`, otherwise
`[Symbol.asyncDispose]()`, otherwise `[Symbol.dispose]()`. Release resources acquired in a constructor
or a factory there: unlike `onStop`, disposal also runs when the application was never started or
failed to start. Transient instances belong to their consumer and are never disposed by the
container. Values you register (`providers`, `registerValue`, `overrides`) are not disposed either.

## Container

The `Container` is created by the application (`app.container`); you can also use it directly, e.g.
in tests:

```ts
const container = Container.create(__ZNIGHT_METADATA__)
container.registerValue('@znight/observability#Logger', fakeLogger)
await container.init()

container.get(UserService) // by class
container.get('src/users/user.service.ts#UserService') // by token
container.get('UserService') // by unique display name
container.get(UserRepository) // abstract class / alias
container.getOptional(Cache) // undefined when there is no provider
container.has(Cache)
container.tokenOf(UserService)
```

Registrations are only allowed before `init()` (afterwards they throw `ZNIGHT016`). When several
registrations target the same token, the highest precedence wins:

`override()` > plugin `register()` / `registerValue()` > `Application.create({ providers })` > compiled providers

`registerValue()` on a compiled provider throws (`ZNIGHT004`, use `override()`), and registering the
same token twice at the same level throws as well.

`init()` validates the merged graph (compiled and runtime definitions) and reports every missing
dependency at once (`ZNIGHT001`, naming the plugin expected to provide it), cycles (`ZNIGHT002`) and
scope mismatches (`ZNIGHT003`). A singleton factory starts as soon as its dependencies are ready, so
independent async singletons (database pools, caches...) are created concurrently. If a factory fails,
the error is a `ZNIGHT015` `InstantiationError` carrying the token, the dependency path, the source
location and the original `cause`; already created instances are disposed in reverse creation order.

`init({ only: [UserController] })` instantiates only the dependency closure of the given providers;
other singletons are created synchronously on first use (async factories must be in the closure) and
only receive lifecycle hooks if they exist when the application starts.

## Scopes

| Scope       | Lifetime                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `singleton` | One instance for the application (default). Async factories are allowed. |
| `request`   | One instance per `runInScope()` call, disposed when the scope ends.      |
| `transient` | A new instance for every injection or `get()`.                           |

```ts
const user = await container.runInScope(
  async () => container.get(CurrentUser).load(),
  [['@znight/http#HttpContext', ctx]], // seed values (request-scoped externals)
)
```

Scopes are isolated with `AsyncLocalStorage` (concurrent requests never share instances). Resolving a
request-scoped provider outside of a scope throws `ZNIGHT013`. `container.currentScope()` exposes the
active scope (`get`, `set`, `has`). Plugins (HTTP, messaging) open the scopes for you.

## Lazy dependencies

`Lazy<T>` injects a handle resolved at call time, in the current scope. It breaks cycles and lets a
singleton use a request-scoped value:

```ts
@Injectable()
export class AuditService {
  constructor(private readonly context: Lazy<HttpContext>) {}

  record(action: string) {
    const { user } = this.context.get() // resolved in the current request scope
  }
}
```

## Plugins

```ts
import { type Plugin, type PluginOptions, resolveOptions } from '@znight/core'

export const CronPlugin = {
  configure(options: PluginOptions<{ timezone: string }>): Plugin {
    let timer: NodeJS.Timeout | undefined
    return {
      name: 'cron',
      register(ctx) {
        ctx.container.registerValue('@acme/cron#Clock', systemClock)
      },
      onBootstrap(ctx) {
        // options may be a function of the container: CronPlugin.configure(c => ({ timezone: c.get(AppConfig).tz }))
        const { timezone } = resolveOptions(options, ctx.container)
        ctx.logger.info('cron configured', { timezone })
      },
      onStart() {
        timer = setInterval(tick, 1000)
      },
      onStop() {
        clearInterval(timer)
      },
    }
  },
}
```

A plugin receives a `PluginContext` with `app`, `container`, `metadata`, `hooks`, a live `logger`
(follows `app.setLogger()`) and `getPlugin(name)`.

## Hooks

`app.hooks` is a typed event bus. Feature packages declare their hooks by augmenting `ZnightHooks`:

```ts
declare module '@znight/core' {
  interface ZnightHooks {
    'http:request': HttpRequestEvent
  }
}

hooks.on('http:request', event => metrics.count(event.route)) // observe; errors are logged, never thrown
// wrap; the first registered wrapper is the outermost
hooks.wrap('http:request', async (event, next) => {
  const started = performance.now()
  try {
    return await next()
  } finally {
    histogram.observe(performance.now() - started)
  }
})
await hooks.run('http:request', event, () => handle(event))
```

## AOP

Interceptors are providers implementing `MethodInterceptor`. They are installed by the container right
after the factory, as own properties of the instance (no Proxy): `#private` fields keep working and
`this.method()` calls are intercepted too. The top-most `@Intercept` is the outermost interceptor.

```ts
@Injectable()
export class TimingInterceptor implements MethodInterceptor<{ label?: string }> {
  async intercept(invocation: MethodInvocation, options: { label?: string }) {
    const started = performance.now()
    try {
      return await invocation.proceed() // or proceed(newArgs)
    } finally {
      console.log(options.label ?? invocation.methodName, performance.now() - started)
    }
  }
}

@Injectable()
export class UserService {
  @Intercept(TimingInterceptor, { label: 'users.find' })
  async findById(id: string) {}
}
```

For a synchronous method, an interceptor must return synchronously: in development
(`NODE_ENV !== 'production'`) returning a promise throws a `ZNIGHT005` error naming the interceptor.

## Errors

Every runtime error is a `ZnightError` with a `code` (`ZNIGHT001`...), `hints` and, when relevant, a
`cause`. `InstantiationError` (`ZNIGHT015`) adds `token`, `path` and `source`; `ZnightAggregateError`
(`ZNIGHT021`) adds `errors`. Cleanup failures that happened while handling an error are attached to it:
read them with `getSuppressedErrors(error)`. The catalogue is exported as `ErrorCode` /
`ERROR_DESCRIPTIONS` and documented in the [architecture specification](../../docs/internals/architecture.md#48-validations).
