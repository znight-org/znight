# Examples

Seven applications built with Znight, production-shaped rather than minimal: configuration validated
at boot, structured logs, graceful shutdown, and tests at every level, including end-to-end tests of
the production build on Node.js **and** Bun. Several guides are written from them: their code
samples are files of these examples.

| Example                              | What it shows                                                                                                           | Stack                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| [`rest-api`](./rest-api)             | The reference HTTP service: Drizzle on PostgreSQL behind a repository interface, API keys, uploads and downloads        | Fastify, Drizzle, PGlite    |
| [`secure-api`](./secure-api)         | Security end to end, the source of the security guide: JWT, API keys, cookie sessions, CSRF, rate limiting, webhooks    | `node:http`, `jose`         |
| [`storefront-api`](./storefront-api) | An OpenAPI 3.1 document generated from the code, committed, served with Scalar and checked; a typed client              | Hono, Zod, Valibot          |
| [`uptime-monitor`](./uptime-monitor) | Scheduled and dynamic jobs, one runner across instances, live results over Server-Sent Events, tests on a virtual clock | Hono, PGlite                |
| [`microservice`](./microservice)     | HTTP and messaging in one service: retries, dead letters, tracing from the request to the consumer                      | Hono, RabbitMQ or in memory |
| [`worker`](./worker)                 | Message consumers without HTTP: a request scope per message, an async factory, draining on shutdown                     | RabbitMQ or in memory       |
| [`monorepo`](./monorepo)             | Two services sharing a provider library, one of them overriding its providers; the compiled-library flow                | Express, messaging          |

Each example has its own README: what it demonstrates, its endpoints with `curl` commands, its
configuration variables and its tests. The [examples page](../docs/examples.md) of the documentation
describes them in more detail.

## Running an example

The examples use the framework from this repository. Install and build the packages once (the
`znight` CLI and the production builds load their `dist`), then start an example:

```sh
git clone https://github.com/znight-org/znight.git
cd znight
bun install
bun run build

cd examples/rest-api
bun run dev        # rebuilds and restarts on every change
```

Run `bun run build` at the root again after changing a package. In the monorepo, start each service
from its folder (`cd examples/monorepo/services/users-api && bun run dev`).

Every example has the scripts of a project created by `znight new`, plus `test:e2e`:

| Script      | Does                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| `dev`       | `znight dev`: build in watch mode, restart on every change              |
| `build`     | `znight build`: the production bundle `dist/main.js`                    |
| `start`     | `znight start`: run the bundle (`--runtime node` or `--runtime bun`)    |
| `test`      | Unit and application tests with `bun test`                              |
| `test:e2e`  | Build, then run the bundle on Node.js and Bun and test it over the wire |
| `typecheck` | `znight generate && tsc --noEmit`                                       |
| `generate`  | Write `src/.znight/container.generated.ts` (`--check` in CI)            |

The applications run on Node.js 24+ or Bun 1.3+; the tests use `bun:test`. From the repository
root, `bun run test:examples` runs the tests of every example, and `bun run test:e2e` builds the
packages and runs every example end to end.

## Start your own

`znight new` creates a smaller application with the same layout and scripts, and the features you
pick (configuration, observability, messaging, scheduling, OpenAPI):

```sh
npx @znight/cli new my-service        # npm
pnpm dlx @znight/cli new my-service   # pnpm
bunx @znight/cli new my-service       # Bun
```

See the [getting started guide](../docs/guide/getting-started.md).
