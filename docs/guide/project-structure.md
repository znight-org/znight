---
description: How a Znight application is laid out, which files the compiler scans, where the generated container lives and how to share providers between applications.
---

# Project structure

Znight has no modules, so there is no structure to declare: the compiler scans your sources and
every decorated class becomes a provider. You are free to organise files as you like. This page shows
the layout we recommend and the few rules that do matter.

## Recommended layout

Group code by **feature**, not by technical layer:

```txt
my-service/
├─ src/
│  ├─ main.ts                      # entry point: Application.create() + start()
│  ├─ .znight/
│  │  └─ container.generated.ts    # generated, git-ignored
│  ├─ config/
│  │  └─ app.config.ts             # @Config classes
│  ├─ db/
│  │  └─ db.factory.ts             # @Factory with @Provides methods (pools, clients)
│  ├─ users/
│  │  ├─ user.controller.ts        # @Controller
│  │  ├─ user.service.ts           # @Injectable
│  │  ├─ user.repository.ts        # interface UserRepository
│  │  ├─ pg-user.repository.ts     # @Injectable implements UserRepository
│  │  └─ user.schemas.ts           # validation schemas (Zod, Valibot...)
│  ├─ orders/
│  │  ├─ order.consumer.ts         # @Consumer
│  │  └─ order.service.ts
│  └─ shared/
│     ├─ auth.guard.ts
│     └─ timing.interceptor.ts
├─ test/
│  ├─ users/user.service.test.ts
│  └─ e2e/users.e2e.test.ts
├─ vite.config.ts                   # plugins: [znight(options)]
├─ znight.config.ts                 # compiler options (Vite plugin, Bun preload, znight generate)
├─ bunfig.toml                      # Bun: preloads @znight/compiler/bun for bun test
├─ tsconfig.json
└─ package.json
```

File names such as `*.service.ts` or `*.controller.ts` are a convention for humans: the compiler
finds providers by their **decorators**, never by file name.

## What the compiler scans

The compiler analyses the files matched by `include` minus `exclude` (both relative to the project
root):

| Option    | Default                                                |
| --------- | ------------------------------------------------------ |
| `include` | `['src/**/*.{ts,tsx,mts}']`                            |
| `exclude` | `['**/*.{test,spec}.*', '**/*.d.ts', '**/.znight/**']` |

`node_modules`, dot-directories and the generated file are always excluded. Tests live next to the
code or in `test/`: they are never scanned, so test doubles never become providers by accident.

A class must be **exported** to be a provider: the generated module imports it
([`ZNIGHT005`](/reference/error-codes#znight005) otherwise).

```ts
@Injectable()
class Hidden {} // ✗ ZNIGHT005: not exported

@Injectable()
export class Visible {} // ✓
```

## The entry point

`src/main.ts` is the only file that needs to know about the generated module. It creates the
application, chooses plugins and starts it:

::: code-group

```ts [src/main.ts]
import { Application } from '@znight/core'
import { ConfigPlugin } from '@znight/config'
import { HttpPlugin } from '@znight/http'
import { ObservabilityPlugin } from '@znight/observability'
import { AppConfig } from './config/app.config.js'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    ObservabilityPlugin.configure({ logging: { level: 'info' } }), // first: its hooks wrap everything
    ConfigPlugin.configure(), // .env files + environment, every @Config class validated at boot
    HttpPlugin.configure(container => ({ port: container.get(AppConfig).port })),
  ],
})

await app.start()
```

:::

`ConfigPlugin.configure()` defaults to the loaders `[dotenv(), env()]`; plugin options computed from
the container (`HttpPlugin.configure(container => ...)`) are evaluated at bootstrap, once the config
classes exist. The Vite plugin uses `src/main.ts` as the server entry by default (option
`app.entry`).

::: danger Never import the generated module from a provider
`container.generated.ts` imports every provider module. If a provider module imports it back
(directly, or through `main.ts`), the ESM cycle makes classes undefined at load time. The compiler
reports it as [`ZNIGHT020`](/reference/error-codes#znight020). Inject the `Container` or use
plugins instead.
:::

## The generated module

| Path                                 | Committed? | Created by                                                                       |
| ------------------------------------ | ---------- | -------------------------------------------------------------------------------- |
| `src/.znight/container.generated.ts` | No         | Vite plugin (`vite build`, `znight dev`, Vitest), `znight generate`, Bun preload |

The file is regenerated from sources, so it is git-ignored. Create it before running `tsc` or tests
in CI (`znight generate`), and check it is up to date with `znight generate --check`. See
[The compiler](./compiler#git-and-ci).

## Sharing providers between applications

In a monorepo, a package can contain providers used by several applications. Two options:

**Source library**: the application compiler analyses the package from its TypeScript sources. List
it in the `libraries` option, or let the package opt in through its manifest:

::: code-group

```json [packages/auth/package.json]
{
  "name": "@acme/auth",
  "exports": { ".": "./src/index.ts" },
  "znight": { "apiVersion": 1, "library": "source" }
}
```

:::

**Compiled library**: the package is built with the compiler's `library: true` option, which emits
`dist/znight.providers.json`, and points to it from its manifest:

```json
{
  "znight": { "apiVersion": 1, "providers": "./dist/znight.providers.json" }
}
```

In both cases, providers keep package identities (`@acme/auth#JwtService`) and are imported from the
package's public entry, so dev and production builds agree. Details in
[The compiler](./compiler#provider-libraries).

## Tests

Keep tests outside of the scanned files (the default `exclude` already ignores `*.test.*` and
`*.spec.*`). Unit tests rarely need the container at all; when they do, use
[`@znight/testing`](./testing).

```txt
test/
├─ users/user.service.test.ts     # TestBed: real UserService, auto-mocked dependencies
└─ e2e/users.e2e.test.ts          # TestApp: real app, in-memory HTTP requests
```
