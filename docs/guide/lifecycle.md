---
description: How a Znight application boots, starts and shuts down gracefully, the OnStart/OnReady/OnStop hooks, disposal, timeouts and signals.
---

# Lifecycle

An application goes through three calls: `Application.create()`, `app.start()` and `app.stop()`.
Providers take part by implementing lifecycle methods; plugins have hooks at every step.

```ts
const app = await Application.create({ metadata: __ZNIGHT_METADATA__, plugins }) // build
await app.start() // accept traffic
// ...
await app.stop() // graceful shutdown (also triggered by SIGINT / SIGTERM)
```

## Provider hooks

Singletons are **duck-typed**: implement a method and it is called, no registration needed. The
interfaces are optional, they only help the type checker.

```ts
import { Injectable, type OnReady, type OnStart, type OnStop } from '@znight/core'

@Injectable()
export class Scheduler implements OnStart, OnReady, OnStop {
  #timer: NodeJS.Timeout | undefined

  async onStart() {
    // dependencies have started; plugins do not accept traffic yet
    await this.loadJobs()
  }

  onReady() {
    // every provider and plugin started
    this.#timer = setInterval(() => this.tick(), 60_000)
  }

  onStop() {
    // shutdown: called before the providers this one depends on stop
    clearInterval(this.#timer)
  }
}
```

| Hook                              | When                                                  | Order                                 |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| `onStart()`                       | `app.start()`, before plugins start accepting traffic | Resolution order (dependencies first) |
| `onReady()`                       | `app.start()`, once every provider and plugin started | Resolution order                      |
| `onStop()`                        | `app.stop()`, after plugins stopped accepting traffic | Reverse resolution order              |
| `dispose` / `Symbol.asyncDispose` | `app.stop()`, and when a failed boot is rolled back   | Reverse resolution order              |

Hooks may be async; each one is awaited before the next. Hooks must not require parameters and must
be instance methods ([`ZNIGHT009`](/reference/error-codes#znight009)). Request-scoped and transient
instances do not receive `onStart`/`onReady`/`onStop`.

## Disposal

Release what a constructor or a factory acquired in a **dispose** method. Unlike `onStop()`, disposal
also runs when the application was never started, or failed to start:

```ts
@Injectable()
export class RedisCache {
  readonly #client = createClient()

  async [Symbol.asyncDispose]() {
    await this.#client.quit()
  }
}

@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'end' }) // calls pool.end() on shutdown
  async createPool(config: DatabaseConfig): Promise<Pool> {
    return new Pool({ connectionString: config.url })
  }
}
```

The container calls the `dispose` method named with `@Provides({ dispose })`, otherwise
`[Symbol.asyncDispose]()`, otherwise `[Symbol.dispose]()`. Values you register yourself
(`providers`, `overrides`, `registerValue`) are never disposed by the container: you own them.

## Boot: `Application.create()`

1. Creates the container from the metadata and supplies your `providers`.
2. Runs every plugin's `register()` (in order): plugins supply their externals.
3. Applies `overrides` (highest precedence, ideal for tests).
4. `container.init()`: validates the merged graph and creates every singleton. A factory starts as
   soon as its dependencies are ready, so independent async singletons are created **concurrently**.
5. Runs every plugin's `onBootstrap()` (routes and consumers are registered, no traffic yet).

If any step fails, everything created so far is disposed (plugins receive `onDispose()`) and the
error is rethrown. A failing factory gives a
[`ZNIGHT015`](/reference/error-codes#znight015) error with the dependency path and the original
`cause`.

## Start: `app.start()`

1. Providers' `onStart()`, in resolution order.
2. Plugins' `onStart()`: the HTTP server listens, consumers subscribe.
3. Providers' `onReady()`, then plugins' `onReady()`.
4. `app.state === 'ready'`.

Signal handlers are installed as soon as the start begins, so `Ctrl+C` during a slow boot shuts down
cleanly. If a step fails, what was started is stopped, everything is disposed, `app.state` becomes
`'failed'` and the error is rethrown.

### Stopping from a start hook

A start hook may stop the application itself: a one-shot job that does its work in `onReady()`, or
a provider giving up in `onStart()`. Call `app.stop()` (inject `Application`), awaited or not:

```ts
import { Application, Injectable, type OnReady } from '@znight/core'

@Injectable()
export class MigrationJob implements OnReady {
  constructor(
    private readonly app: Application,
    private readonly migrations: Migrator,
  ) {}

  async onReady() {
    await this.migrations.run()
    await this.app.stop() // the job is done: shut down
  }
}
```

`stop()` normally waits for an in-progress start, but the start is waiting for this very hook: called
from a start hook (or from work the hook awaits), the shutdown runs **right away** instead. What
completed its `onStart()` is stopped, the remaining start hooks are skipped, and `app.start()`
resolves once the application is `stopped` (it rejects if the hook throws afterwards). A `SIGTERM`
received during the boot does not deadlock either.

## Graceful shutdown: `app.stop()`

`stop()` is idempotent (it waits for an in-progress start, unless a start hook calls it) and runs
three phases:

| Phase | What runs                                                                                | Purpose                                             |
| ----- | ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1     | Plugins' `onStop()`, in reverse order                                                    | Stop ingress, drain in-flight requests and messages |
| 2     | For each provider in reverse resolution order: `onStop()` (if it started), then disposal | Stop your services, release resources               |
| 3     | Plugins' `onDispose()`, in reverse order                                                 | Close connections, flush logs and telemetry         |

Every step is attempted even if a previous one failed. Each step has its own timeout
(`hookTimeoutMs`, 5 s by default) and the whole shutdown a global deadline (`timeoutMs`, 10 s).
`Infinity` disables a budget (so does any value above 2^31 − 1 ms, about 24.8 days, the longest
delay a timer accepts); negative and `NaN` values are rejected
([`ZNIGHT005`](/reference/error-codes#znight005)).
Failures are collected into one `ZnightAggregateError`
([`ZNIGHT021`](/reference/error-codes#znight021)) whose `errors` lists each failed step.

```ts
const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins,
  shutdown: {
    signals: ['SIGINT', 'SIGTERM'], // default; false disables signal handling
    timeoutMs: 25_000, // global deadline (keep it below your orchestrator's grace period)
    hookTimeoutMs: 5_000, // per step
  },
})
```

### Signals

After `start()`, `SIGINT` and `SIGTERM` trigger `app.stop()`:

- the shutdown logs `Application stopped` once it completed (at `info` after a signal, at `debug`
  after an explicit `app.stop()`);
- when the signal-triggered shutdown fails, `process.exitCode` is set to `1`;
- a **second** signal forces `process.exit(130)`;
- an explicit `app.stop()` never touches the exit code: your code decides.

::: tip Containers and Kubernetes
Run Node.js or Bun as PID 1 with the exec form (`CMD ["node", "dist/main.js"]`) so it receives
`SIGTERM`, and keep `shutdown.timeoutMs` below `terminationGracePeriodSeconds` (30 s by default). See
[Deployment](./deployment).
:::

## Application states

`app.state` is one of:

```txt
created ──start()──▶ starting ──▶ ready ──stop()──▶ stopping ──▶ stopped
                        │
                        └── failure ──▶ failed
```

## Partial initialisation

`init: { only: [...] }` creates only the dependency closure of the given providers. Other singletons
are created on first use (synchronously, so async factories must be in the closure), outside of any
request scope even when a request uses them first. It is handy for CLI commands or serverless
handlers that only need part of the graph:

```ts
const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  init: { only: [ReportService] },
  shutdown: { signals: false },
})
await app.get(ReportService).generate()
await app.stop()
```

## Hot module replacement

When the entry module can be replaced (`import.meta.hot`), pass it so the application stops before the
new one starts:

```ts
const app = await Application.create({ metadata: __ZNIGHT_METADATA__, plugins, hot: import.meta.hot })
```

The dispose callback returns the `stop()` promise: HMR runtimes that await it (Vite's module runner,
Bun) load the new module only once the old application released its port and its consumers. A
failed stop is logged (`Failed to stop the application`), not thrown at the HMR runtime.

`znight dev` restarts the whole process on every rebuild instead, which is the recommended
development loop.

## Errors attached to errors

When a cleanup fails while handling another error (a dispose failing during a boot rollback, for
instance), the cleanup error is attached instead of hiding the original one. Read it with
`getSuppressedErrors(error)`:

```ts
import { getSuppressedErrors } from '@znight/core'

try {
  await Application.create({ metadata: __ZNIGHT_METADATA__, plugins })
} catch (error) {
  console.error(error)
  for (const cleanup of getSuppressedErrors(error)) console.error('while cleaning up:', cleanup)
  process.exitCode = 1
}
```
