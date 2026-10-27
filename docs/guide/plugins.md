---
description: Write Znight plugins - lifecycle hooks, supplying runtime values to the container, options computed from the container, HTTP routes served for a plugin, and the typed hooks bus (http:request, messaging:message, schedule:run).
---

# Plugins & hooks

Every runtime feature of Znight (HTTP server, message consumers, configuration, observability) is a
**plugin**. Your own infrastructure can be one too: a heartbeat, a gRPC server, a tenant resolver...

```ts
const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [ConfigPlugin.configure(), HttpPlugin.configure({ port: 3000 }), HeartbeatPlugin.configure()],
})
```

## Anatomy of a plugin

A plugin is a plain object with a unique `name` and optional hooks. By convention, packages export a
`XxxPlugin.configure(options)` function returning it.

```ts
import type { Plugin } from '@znight/core'

export const HeartbeatPlugin = {
  configure(options: { tickMs?: number } = {}): Plugin {
    let timer: NodeJS.Timeout | undefined
    return {
      name: 'heartbeat',
      onStart(ctx) {
        timer = setInterval(() => ctx.logger.debug('tick'), options.tickMs ?? 1_000)
      },
      onStop() {
        clearInterval(timer)
      },
    }
  },
}
```

| Hook          | When                                        | Typical work                                              |
| ------------- | ------------------------------------------- | --------------------------------------------------------- |
| `register`    | Before `container.init()`                   | Supply externals (`registerValue`, `register`)            |
| `onBootstrap` | After `container.init()`, before `start()`  | Read metadata, register routes/consumers, resolve options |
| `onStart`     | `app.start()`, after providers' `onStart()` | Start ingress: listen, subscribe                          |
| `onReady`     | Everything started                          | Announce readiness                                        |
| `onStop`      | `app.stop()`, first                         | Stop ingress, drain in-flight work                        |
| `onDispose`   | `app.stop()`, last (also on a failed boot)  | Close connections, flush buffers                          |

Hooks run in plugin order; `onStop` and `onDispose` run in **reverse** order. Every hook may be
async. A plugin that ran `register` always receives `onDispose`, even when the boot fails later, so
release there whatever `register` acquired. See [Lifecycle](./lifecycle) for the full sequence.

## The plugin context

Every hook receives a `PluginContext`:

| Property          | Description                                                                            |
| ----------------- | -------------------------------------------------------------------------------------- |
| `app`             | The `Application`                                                                      |
| `container`       | The `Container` (registrations only before `init()`, in `register`)                    |
| `metadata`        | The generated metadata, including feature `extensions` (`http`, `messaging`...)        |
| `hooks`           | The application [hooks](#hooks)                                                        |
| `logger`          | A live `CoreLogger`: follows `app.setLogger()` (e.g. when observability installs pino) |
| `getPlugin(name)` | Another plugin of the application                                                      |

## Supplying values to the container

The compiled code may depend on types that only exist at runtime: a logger, a broker connection, the
current request. These are **externals**. A plugin supplies them in `register`:

```ts
import { type Plugin, token } from '@znight/core'

export interface Clock {
  now(): Date
}

/** The token of the Clock interface: '<file>#<name>' for application code. */
export const ClockToken = token<Clock>('src/clock/clock.ts#Clock')

export const ClockPlugin = {
  configure(): Plugin {
    return {
      name: 'clock',
      register(ctx) {
        ctx.container.registerValue(ClockToken, { now: () => new Date() })
      },
    }
  },
}
```

Tell the compiler that `Clock` is provided at runtime, so that injecting it is not a
[`ZNIGHT001`](/reference/error-codes#znight001):

::: code-group

```ts [vite.config.ts]
export default defineConfig({
  plugins: [znight({ externals: ['src/clock/clock.ts#Clock'] })],
})
```

:::

Providers now inject `Clock` like any other dependency, and `Application.create()` fails with a clear
`ZNIGHT001` if no plugin supplied it.

A **published package** declares its runtime-provided types in its `package.json` instead, and the
compiler picks them up automatically:

::: code-group

```json [package.json]
{
  "name": "@acme/clock",
  "znight": {
    "apiVersion": 1,
    "provides": [{ "export": "Clock", "plugin": "ClockPlugin", "scope": "singleton" }]
  }
}
```

:::

The token is then `@acme/clock#Clock`. See the [package manifest](/contributing/architecture) section
of the specification for every field.

### Definitions with dependencies

`registerValue` supplies a ready value. To build it from other providers, register a definition:

```ts
import { CoreTokens } from '@znight/core'

register(ctx) {
  ctx.container.register(MailerToken, {
    scope: 'singleton',
    deps: [CoreTokens.Logger, 'src/mail/smtp.config.ts#SmtpConfig'], // compiled or runtime tokens
    factory: ([logger, config]) => new SmtpMailer(config, logger),
  })
}
```

`deps` uses the same references as compiled providers: tokens, `{ token, optional: true }`,
`{ multi: [...] }` and `{ lazy: token }`.

### Request-scoped values

A request-scoped external is read from the active request scope. Declare it (to the container here,
and to the compiler with `externals` or the manifest's `provides` with `"scope": "request"`), then
seed it when a scope is opened (here from a hook wrapper, see below):

```ts
register(ctx) {
  ctx.container.registerExternal({ token: TenantToken, scope: 'request', providedBy: 'TenantPlugin' })
},
onBootstrap(ctx) {
  ctx.hooks.wrap('http:request', async (event, next) => {
    ctx.container.currentScope()?.set(TenantToken, resolveTenant(event.headers['x-tenant-id']))
    return next()
  })
},
```

### Precedence

When several registrations target the same token, the highest wins:

`overrides` > plugin `register()` > `Application.create({ providers })` > compiled providers

Two plugins registering the same token is an error
([`ZNIGHT004`](/reference/error-codes#znight004)), and any registration after `init()` is
[`ZNIGHT016`](/reference/error-codes#znight016).

## Options computed from the container

Options often depend on configuration that only exists once the container is initialised. Accept
`PluginOptions<O>`: either the options, or a function of the container, resolved with
`resolveOptions` in `onBootstrap`:

```ts
import { type Plugin, type PluginOptions, resolveOptions } from '@znight/core'

export const HeartbeatPlugin = {
  configure(options: PluginOptions<{ tickMs: number }>): Plugin {
    let tickMs = 1_000
    return {
      name: 'heartbeat',
      onBootstrap(ctx) {
        tickMs = resolveOptions(options, ctx.container).tickMs
      },
      // ...
    }
  },
}

// usage
HeartbeatPlugin.configure(container => ({ tickMs: container.get(HeartbeatConfig).tickMs }))
```

This replaces NestJS's `forRootAsync({ useFactory, inject })`: the function receives the container,
fully initialised, and can `get()` any provider.

When your options name provider classes that the plugin resolves in `onBootstrap` (like the global
`guards` of `HttpPlugin`), list them in an optional `initRoots({ metadata })` method returning those
classes (`[]` when the options are a function of the container); a plugin can also derive them from
its own section of the metadata. [`TestApp`](/guide/testing) creates them at boot with their
dependencies, even when a test restricts the boot to the controllers; it must not throw (report
invalid options in `onBootstrap`).

## Serving HTTP routes

A plugin that exposes an endpoint (a status page, a document) does not need its own server: it
implements `PluginHttpRoutes` from `@znight/http`, and `HttpPlugin` serves the routes on its adapter,
in the same pipeline as the controllers (hooks, global guards, exception mappers):

```ts
import type { Plugin } from '@znight/core'
import type { PluginHttpRoutes, PluginRoute } from '@znight/http'

import { Public } from './auth/access.js'

export class StatusPlugin implements Plugin, PluginHttpRoutes {
  readonly name = 'status'

  httpRoutes(): readonly PluginRoute[] {
    return [{ method: 'GET', path: '/status', name: 'status', handler: () => ({ up: true }), meta: [Public.meta()] }]
  }
}
```

Paths are relative to the HTTP `prefix`; `meta` carries the route decisions guards read (see
[Security](./security#route-decisions)). See [plugin routes](/packages/http#plugin-routes).

## Hooks

`app.hooks` (also `ctx.hooks`) is a small, typed event bus that lets plugins observe and wrap what
other plugins do, without depending on each other. Feature packages emit:

| Hook                | Event                  | Emitted by          |
| ------------------- | ---------------------- | ------------------- |
| `http:request`      | `HttpRequestEvent`     | `@znight/http`      |
| `messaging:message` | `MessageDeliveryEvent` | `@znight/messaging` |
| `messaging:publish` | `MessagePublishEvent`  | `@znight/messaging` |
| `schedule:run`      | `ScheduledRunEvent`    | `@znight/schedule`  |

### Observe: `on`

```ts
const off = hooks.on('http:request', event => {
  if (event.status !== undefined && event.status >= 500) alerts.notify(event.route, event.error)
})
off() // unsubscribe
```

Listeners are called synchronously; a failing listener is logged and never breaks the emitter.

### Wrap: `wrap`

Wrappers run **around** the operation (onion model, the first registered wrapper is the outermost).
They must call `next()`:

```ts
hooks.wrap('http:request', async (event, next) => {
  const started = performance.now()
  try {
    return await next()
  } finally {
    histogram.observe({ route: event.route ?? 'unmatched', status: event.status }, performance.now() - started)
  }
})
```

`@znight/observability` uses exactly this to log requests, record RED metrics and create spans.

### Events

```ts
interface HttpRequestEvent {
  readonly method: string
  readonly path: string // without query string
  readonly route: string | undefined // matched pattern, e.g. '/users/:id'
  readonly requestId: string
  readonly headers: Readonly<Record<string, string | undefined>> // lower-cased
  readonly context: unknown // HttpContext
  readonly startTime: number // performance.now()
  status?: number // set before run() resolves
  error?: unknown
  readonly responseHeaders: Record<string, string> // e.g. trace context
}

interface MessageDeliveryEvent {
  readonly queue: string
  readonly type: string | undefined
  readonly messageId: string
  readonly attempt: number // 1-based
  readonly headers: Readonly<Record<string, string>>
  readonly consumer: string
  readonly handler: string | undefined
  readonly message: unknown // InboundMessage
  readonly startTime: number
  outcome?: 'ack' | 'retry' | 'dead-letter'
  error?: unknown
}

interface ScheduledRunEvent {
  readonly job: string // 'digest.daily'
  readonly kind: 'cron' | 'interval' | 'timeout'
  readonly host: string | undefined // host class; undefined for dynamic jobs
  readonly method: string | undefined
  readonly runId: string
  readonly trigger: 'schedule' | 'start' | 'manual' | 'queued'
  readonly scheduledAt: number // epoch ms of the occurrence
  readonly context: unknown // JobContext; undefined when the run did not execute
  readonly startTime: number
  outcome?: 'completed' | 'failed' | 'skipped' | 'not-acquired'
  error?: unknown
  aborted?: 'timeout' | 'lock-lost' | 'removed' | 'shutdown'
}
```

Executed runs go through `hooks.run('schedule:run', ...)`, and every occurrence is then emitted,
including those that did not run (`skipped` by the overlap policy, `not-acquired` because another
instance holds the lock). A `schedule:run` wrapper that does not call `next()` vetoes the run
(outcome `skipped`): a feature flag or a maintenance window.

### Declaring your own hooks

Augment `ZnightHooks` to add typed hooks, then `emit` or `run` them:

```ts
declare module '@znight/core' {
  interface ZnightHooks {
    'heartbeat:tick': { readonly at: number }
  }
}

hooks.emit('heartbeat:tick', { at: Date.now() })
const result = await hooks.run('heartbeat:tick', { at: Date.now() }, () => beat())
```

`run(name, event, fn)` calls `fn` through the wrappers and resolves with its result. Use
`hooks.hasListeners(name)` / `hasWrappers(name)` to skip building costly events.

## A complete example

A plugin that starts an extra HTTP health endpoint, configured from the container, and stops it
gracefully:

```ts
import { createServer, type Server } from 'node:http'
import { type Plugin, type PluginOptions, resolveOptions } from '@znight/core'

export const HealthPlugin = {
  configure(options: PluginOptions<{ port: number }>): Plugin {
    let server: Server | undefined
    let port = 0
    let ready = false
    return {
      name: 'health',
      onBootstrap(ctx) {
        port = resolveOptions(options, ctx.container).port
      },
      onStart(ctx) {
        server = createServer((_req, res) => {
          res.writeHead(ready ? 200 : 503).end(ready ? 'ok' : 'starting')
        })
        server.listen(port)
        ctx.logger.info('health endpoint listening', { port })
      },
      onReady() {
        ready = true
      },
      onStop() {
        ready = false // fail readiness first, so the load balancer drains us
      },
      async onDispose() {
        await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
      },
    }
  },
}
```
