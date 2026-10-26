---
description: Build and run Znight applications in production on Node.js 24 or Bun, in Docker and Kubernetes, and on serverless platforms where cold starts matter.
---

# Deployment

A Znight application builds to a plain ESM bundle. There is no runtime compiler, no reflection and no
decorator code left: the output runs anywhere Node.js 24+ or Bun 1.3+ runs.

## Build

```sh
vite build   # or: znight build
```

With the default `app` options, the Vite plugin produces a server build:

| Setting                   | Value                              |
| ------------------------- | ---------------------------------- |
| Entry                     | `src/main.ts`                      |
| Output                    | `dist/main.js`                     |
| Target                    | `node24`                           |
| Source maps               | on (`dist/main.js.map`)            |
| Provider source locations | omitted (`sourceLocations: 'dev'`) |

Like any Vite server build, dependencies from `node_modules` stay **external** by default: install
production dependencies next to `dist/` at runtime. To ship a single self-contained file (handy for
serverless), bundle them:

::: code-group

```ts [vite.config.ts]
export default defineConfig({
  plugins: [znight()],
  ssr: { noExternal: true }, // bundle node_modules too (native addons must stay external)
})
```

:::

The build fails on any Znight error, so a broken dependency graph never reaches an artifact.

## Run

::: code-group

```sh [Node.js]
NODE_ENV=production node --enable-source-maps dist/main.js
```

```sh [Bun]
NODE_ENV=production bun dist/main.js
```

:::

- `NODE_ENV=production` disables development-only checks (such as the interceptor sync/async check).
- `--enable-source-maps` makes Node.js stack traces point to your TypeScript sources.
- Bun can also run the sources directly (`bun src/main.ts`) if you generate the container first
  (`znight generate` or the [Bun preload](./compiler#bun-preload)); the build output is still the most
  predictable artifact.

## Docker

A multi-stage image that builds with the full toolchain and ships only the bundle and production
dependencies:

::: code-group

```dockerfile [Node.js]
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/main.js"]
```

```dockerfile [Bun]
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && rm -rf node_modules && bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "dist/main.js"]
```

:::

Use the **exec form** of `CMD` (a JSON array) so the runtime is PID 1 and receives `SIGTERM`
directly. With the shell form, the signal goes to `/bin/sh` and your application is killed without a
graceful shutdown.

## Graceful shutdown in orchestrators

On `SIGTERM`, Znight stops ingress first (the HTTP server stops accepting connections and drains
in-flight requests, consumers stop pulling and finish their messages), then stops your providers,
then closes infrastructure. See [Lifecycle](./lifecycle#graceful-shutdown-app-stop).

Align the timeouts with your platform:

```ts
const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins,
  shutdown: { timeoutMs: 25_000, hookTimeoutMs: 10_000 },
})
```

| Platform               | Grace period before `SIGKILL`                     | Suggested `timeoutMs` |
| ---------------------- | ------------------------------------------------- | --------------------- |
| Kubernetes             | `terminationGracePeriodSeconds` (30 s by default) | 25 s                  |
| Docker (`docker stop`) | 10 s by default (`--time`)                        | 8 s                   |
| AWS ECS                | `stopTimeout` (30 s by default)                   | 25 s                  |

On Kubernetes, endpoints are removed asynchronously: a short `preStop` sleep (a few seconds) before
`SIGTERM` avoids sending new requests to a pod that is already draining.

When a signal-triggered shutdown fails, the process exits with code `1`; a second signal forces exit
code `130`.

## Configuration and secrets

Configuration classes from [`@znight/config`](/packages/config) are validated when the application
boots: every missing or invalid value is reported at once
([`ZNIGHT006`](/reference/error-codes#znight006)) and the process fails before accepting traffic,
which is exactly what a rolling deployment needs to stop a bad release.

## Serverless and cold starts

Cold starts are where compile-time DI pays off most. At startup, a Znight application:

- imports the bundle (no `reflect-metadata` polyfill, no decorator side effects);
- reads a precomputed resolution order (no graph discovery, no sorting of user code);
- calls generated factories, starting independent async singletons **concurrently**.

Make the most of it:

- **Create the application once**, outside the handler, and reuse it across invocations.
- **Instantiate only what the function needs** with `init.only`.
- **Prune** providers unreachable from your entry points with the compiler's `prune` option.
- **Bundle dependencies** (`ssr.noExternal: true`) to avoid resolving `node_modules` at startup.
- Disable signal handlers (`shutdown.signals: false`) where the platform manages the process.

A queue-triggered function (AWS Lambda with SQS) using a single service:

::: code-group

```ts [src/lambda.ts]
import { Application } from '@znight/core'
import type { SQSEvent } from 'aws-lambda'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { OrderService } from './orders/order.service.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  init: { only: [OrderService] }, // build OrderService and its dependencies only
  shutdown: { signals: false },
})
await app.start()
const orders = app.get(OrderService)

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) await orders.process(JSON.parse(record.body))
}
```

:::

::: code-group

```ts [vite.config.ts]
export default defineConfig({
  plugins: [znight({ app: { entry: 'src/lambda.ts' }, prune: true })],
  ssr: { noExternal: true },
})
```

:::

For HTTP functions and edge runtimes, use an HTTP adapter able to handle a request without opening a
port (such as Hono's fetch-style handler).

<!-- TODO(api): verify against implementation (serverless/fetch handler of @znight/http adapters) -->

## Checklist

1. `vite build` passes (no `ZNIGHT` errors); run `znight generate --check` in CI if `tsc` runs before
   the build.
2. `NODE_ENV=production` is set.
3. The runtime is PID 1 or otherwise receives signals (exec form `CMD`).
4. `shutdown.timeoutMs` is below the platform's grace period.
5. Configuration is validated at boot (`@znight/config`); secrets come from the environment or a
   secret store.
6. Logs, metrics and traces are wired with [`@znight/observability`](/packages/observability).
