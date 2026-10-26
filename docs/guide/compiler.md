---
description: How the Znight compiler analyses your code, its options, the generated container module, the Vite plugin, the Bun preload, Git/CI policy and provider libraries.
---

# The compiler

`@znight/compiler` is the heart of Znight. It reads your TypeScript sources, understands decorators
and types, binds every dependency, validates the graph and writes a plain TypeScript module that the
runtime executes. It runs as a **Vite plugin**, from the **CLI** (`znight generate`), as a **Bun
preload**, or programmatically.

## How it works

```txt
scan ─▶ parse ─▶ per-file facts ─▶ resolve identities ─▶ analyse classes ─▶ bind ─▶ validate ─▶ emit
 │        │            │                                   (core + extensions)
 │        └────────────┴─ cached by content hash
 └─ include / exclude globs + provider libraries
```

1. **Scan** the files matched by `include` / `exclude`, plus provider libraries.
2. **Parse** them with [oxc](https://oxc.rs) (a native parser) and extract per-file facts: imports,
   exports, declarations. Both are cached by content hash, so a rebuild only re-parses what changed.
3. **Resolve identities**: every class, interface and decorator gets a canonical identity
   (`src/users/user.service.ts#UserService`, `@znight/http#Get`) independent of how it is imported.
4. **Analyse classes**: decorators are recognised by identity (renamed imports and barrels work),
   constructor parameter types are resolved, decorator arguments are evaluated statically. Feature
   packages contribute **compiler extensions** (routes, consumers, config classes).
5. **Bind** every injection point to a provider ([algorithm](./dependency-injection#how-a-dependency-is-bound)).
6. **Validate** the graph: missing providers, cycles, scope mismatches, ambiguities...
   ([error codes](/reference/error-codes)).
7. **Emit** the module (deterministic output), re-parse it as a safety check, and write it only if its
   content changed.

Only parsing and per-file facts are cached; everything from resolution onwards is recomputed on each
compile, which is cheap and keeps incremental builds correct.

### What the compiler reads

- **Decorators** as markers: they are never executed. Static arguments (paths, names, scopes, queue
  and env names) must be evaluable at build time: literals, `const` references across files and
  packages, template literals, arithmetic, `as const`... Value arguments (schemas, guards, options)
  are evaluated when possible, otherwise they must reference an **exported** binding, which the
  generated module imports.
- **Types** of constructor and `@Provides` parameters, `extends` / `implements` clauses (with generic
  arguments), and method signatures for routes and handlers.

```ts
export const API_PREFIX = '/api/v1'

@Controller(`${API_PREFIX}/users`) // ✓ evaluated: '/api/v1/users'
export class UserController {}

@Controller(process.env.PREFIX) // ✗ ZNIGHT005: not statically evaluable
export class AdminController {}
```

## Options

The Vite plugin (`znight(options)`), the Bun preload, `znight generate` and `compile()` /
`generate()` take the same options. Keep them in a `znight.config.ts` (what `znight new` generates):
the Bun preload and `znight generate` read it, and `vite.config.ts` passes it to the plugin, so
every tool generates the same container.

::: code-group

```ts [znight.config.ts]
import type { ZnightOptions } from '@znight/compiler'

export default {
  include: ['src/**/*.ts'],
  strictValidation: true,
} satisfies ZnightOptions
```

```ts [vite.config.ts]
import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

import options from './znight.config.ts'

export default defineConfig({ plugins: [znight(options)] })
```

:::

`znight.config.ts` (or `.mts`, `.js`, `.mjs`) default-exports the options, or a function returning
them; the `ZNIGHT_CONFIG` environment variable names another file. A relative `root` is resolved
against the file's directory.

| Option              | Type                          | Default                                                | Description                                                                                                        |
| ------------------- | ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `root`              | `string`                      | Vite root / `process.cwd()`                            | Project root. Globs and `outFile` are relative to it.                                                              |
| `include`           | `string[]`                    | `['src/**/*.{ts,tsx,mts}']`                            | Sources to analyse.                                                                                                |
| `exclude`           | `string[]`                    | `['**/*.{test,spec}.*', '**/*.d.ts', '**/.znight/**']` | Excluded from `include` and provider libraries. `node_modules`, dot-directories and `outFile` are always excluded. |
| `outFile`           | `string`                      | `'src/.znight/container.generated.ts'`                 | The generated module.                                                                                              |
| `tsconfig`          | `string \| false`             | nearest tsconfig of each file                          | tsconfig used for `paths` resolution, or `false` to ignore tsconfig files.                                         |
| `conditions`        | `string[]`                    | `[]`                                                   | Extra export conditions used to find sources (e.g. a workspace "source" condition).                                |
| `importExtension`   | `'js' \| 'ts' \| 'none'`      | `'js'`                                                 | Extension of relative imports in the generated module.                                                             |
| `sourceLocations`   | `'dev' \| 'always' \| false`  | `'dev'`                                                | Emit provider source locations (used in runtime errors) in serve/test only, always, or never.                      |
| `stripDecorators`   | `boolean`                     | `true`                                                 | Remove Znight decorators from the bundle.                                                                          |
| `extensions`        | `CompilerExtension[]`         | `[]`                                                   | Additional compiler extensions.                                                                                    |
| `trustedExtensions` | `string[]`                    | `[]`                                                   | Third-party packages allowed to load a compiler extension from their manifest.                                     |
| `externals`         | `string[]`                    | `[]`                                                   | Identities provided at runtime by your own plugins (`'src/clock.ts#Clock'`, `'@acme/x#Y'`).                        |
| `libraries`         | `string[]`                    | `[]`                                                   | Packages analysed from source ([provider libraries](#provider-libraries)).                                         |
| `library`           | `boolean`                     | `false`                                                | Library mode: emit `dist/znight.providers.json`.                                                                   |
| `strictValidation`  | `boolean`                     | `false`                                                | Unvalidated inputs ([`ZNIGHT017`](/reference/error-codes#znight017)) are errors instead of warnings.               |
| `reportUnused`      | `boolean`                     | `false`                                                | Warn about providers unreachable from any root ([`ZNIGHT019`](/reference/error-codes#znight019)).                  |
| `prune`             | `boolean`                     | `false`                                                | Drop unreachable providers from the generated module.                                                              |
| `app`               | `false \| { entry?: string }` | `{}` (entry `'src/main.ts'`)                           | Vite build defaults for a server application, or `false` to leave the Vite config alone.                           |

## The generated module

The output is a regular TypeScript module exporting `__ZNIGHT_METADATA__` (also the default export):

::: code-group

```ts [src/.znight/container.generated.ts]
// AUTO-GENERATED by @znight/compiler 0.1.0. Do not edit.
// biome-ignore-all lint: generated file
/* eslint-disable */
import type { ZnightMetadata } from '@znight/core'
import type { HttpContext } from '@znight/http'
import { coerce } from '@znight/http'
import { DbFactory } from '../db/db.factory.js'
import { PgUserRepository } from '../users/pg-user.repository.js'
import { UserController } from '../users/user.controller.js'
import { UserService } from '../users/user.service.js'

export const __ZNIGHT_METADATA__: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {
    ['src/db/db.factory.ts#DbFactory']: {
      scope: 'singleton',
      class: DbFactory,
      deps: [],
      factory: () => new DbFactory(),
    },
    ['src/db/db.factory.ts#DbFactory.createPool']: {
      scope: 'singleton',
      deps: ['src/db/db.factory.ts#DbFactory'],
      factory: d => d[0].createPool(),
    },
    ['src/users/pg-user.repository.ts#PgUserRepository']: {
      scope: 'singleton',
      class: PgUserRepository,
      deps: ['src/db/db.factory.ts#DbFactory.createPool'],
      factory: d => new PgUserRepository(d[0]),
    },
    ['src/users/user.controller.ts#UserController']: {
      scope: 'singleton',
      class: UserController,
      deps: ['src/users/user.service.ts#UserService'],
      factory: d => new UserController(d[0]),
    },
    ['src/users/user.service.ts#UserService']: {
      scope: 'singleton',
      class: UserService,
      deps: [
        'src/users/pg-user.repository.ts#PgUserRepository',
        '@znight/observability#Logger',
        '@znight/observability#LoggedInterceptor',
      ],
      factory: d => new UserService(d[0], d[1]),
      interceptors: { ['findById']: { async: true, chain: [{ dep: 2, options: { ['level']: 'debug' } }] } },
    },
  },
  resolutionOrder: [
    'src/db/db.factory.ts#DbFactory',
    'src/db/db.factory.ts#DbFactory.createPool',
    'src/users/pg-user.repository.ts#PgUserRepository',
    'src/users/user.service.ts#UserService',
    'src/users/user.controller.ts#UserController',
  ],
  aliases: {
    ['src/db/db.factory.ts#Pool']: 'src/db/db.factory.ts#DbFactory.createPool',
    ['src/users/user.repository.ts#UserRepository']: 'src/users/pg-user.repository.ts#PgUserRepository',
  },
  externals: [
    { token: '@znight/observability#LoggedInterceptor', providedBy: 'ObservabilityPlugin' },
    { token: '@znight/observability#Logger', providedBy: 'ObservabilityPlugin' },
  ],
  extensions: {
    ['http']: {
      ['controllers']: [
        {
          ['token']: 'src/users/user.controller.ts#UserController',
          ['basePath']: '/users',
          ['guards']: [],
          ['interceptors']: [],
          ['meta']: {},
          ['routes']: [
            {
              ['method']: 'GET',
              ['path']: '/:id',
              ['fullPath']: '/users/:id',
              ['handler']: 'getUser',
              ['meta']: {},
              ['guards']: [],
              ['interceptors']: [],
              ['params']: [{ ['index']: 0, ['source']: 'param', ['name']: 'id', ['type']: 'number' }],
              ['invoke']: (c: UserController, ctx: HttpContext) =>
                c.getUser(coerce.number(ctx.params['id'], 'param "id"')),
            },
          ],
        },
      ],
    },
  },
}
export default __ZNIGHT_METADATA__
```

:::

Properties of the output:

- **Readable**: factories are ordinary `new X(...)` calls (`d => d[0].createPool()` for a
  `@Provides` method); route handlers are ordinary method calls. Put a breakpoint in it.
- **Safe keys**: every key that comes from your code or from an extension (tokens, method names,
  extension data) is a computed string key (`['findById']`), so names such as `__proto__` stay
  plain properties.
- **Type-checked**: it compiles under strict settings (`exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`...), and `invoke` keeps typed
  parameters, so a handler signature that does not match its decorators fails `tsc`.
- **Deterministic**: no timestamps, stable ordering, identical on every OS and for incremental and
  full builds. Diffs are meaningful.
- **Lean**: source locations are omitted in production builds (`sourceLocations: 'dev'`).

## The Vite plugin

::: code-group

```ts [vite.config.ts]
import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

import options from './znight.config.ts'

export default defineConfig({ plugins: [znight(options)] })
```

:::

The plugin keeps one incremental compiler for the server environments of Vite (SSR builds, Vitest's
Node.js environment); client environments are left alone.

- **Server builds by default.** Unless you configured `build.ssr` or `build.lib` yourself (or set
  `app: false`), the plugin sets `build.ssr` to `src/main.ts` (`app.entry`), `build.outDir` to
  `dist`, `build.target` to `node24`, enables source maps and targets Node. Values you set are kept.
- **`vite build`** compiles before bundling. Any error fails the build with the formatted
  diagnostics and nothing is written. Provider source locations are omitted (`build` mode).
- **`vite build --watch`** (what `znight dev` runs) and the **dev server** recompile only the files
  that changed (events are debounced) and print the diagnostics. While there are errors, the
  generated module is replaced by one that throws a `ZnightError` with the diagnostics when
  imported: the bundle is still written, so a broken graph never runs silently, and `znight dev`
  keeps the last good process running instead of restarting into the error.
- **Vitest** uses your Vite config: the container is compiled (`test` mode) before the tests import
  it and recompiled in watch mode.
- **Decorator stripping**: the Znight decorators found by the analysis are removed from the
  transformed code, with high-resolution source maps. Only the exact ranges recorded for that file
  content are removed; files that were not analysed, and your other decorators, are untouched.
- The generated module is **served from memory** (also before it exists on disk, on a fresh
  checkout); the copy on disk exists for `tsc` and your editor, is only rewritten when its content
  changes and never while there are errors. Import it by path (relative), not through an alias.
- Tools read the plugin state through `plugin.api`: `options`, `compiler`, `result` (the latest
  compile result) and `ready()` (compiles the pending changes).

## Diagnostics

Diagnostics are printed with a code frame and hints:

```txt
✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService
  --> src/notification/notification.service.ts:12:5
   |
12 |     private readonly email: EmailService,
   |                             ^^^^^^^^^^^^
   = hint: Add @Injectable() to EmailService (src/email/email.service.ts:3)
```

Errors fail the build; warnings (such as [`ZNIGHT017`](/reference/error-codes#znight017) without
`strictValidation`) are printed and the build continues. Every code is documented in the
[error reference](/reference/error-codes).

## Git and CI

The generated module is derived from your sources: **do not commit it**.

::: code-group

```txt [.gitignore]
.znight
```

:::

Generate it before anything that needs it without going through Vite:

```sh
znight generate          # write src/.znight/container.generated.ts
znight generate --check  # CI: exit 1 when the file is missing or stale
znight generate --watch  # keep it up to date for your editor
```

A typical CI pipeline:

```sh
znight generate   # or let `vite build` do it
tsc --noEmit
bun test          # or vitest
vite build
```

## Development workflow

`znight dev` runs the Vite build in watch mode and **restarts the process** after every successful
rebuild. There is no partial hot replacement of providers: a restart is fast (no reflection, a
precomputed graph) and always consistent.

::: code-group

```json [package.json]
{
  "scripts": {
    "dev": "znight dev",
    "build": "znight build",
    "start": "znight start"
  }
}
```

:::

## Bun preload

Bun runs TypeScript (decorators included) directly. The compiler's Bun preload regenerates the
container before your tests or your application start, and serves it from memory:

::: code-group

```toml [bunfig.toml]
[test]
preload = ["@znight/compiler/bun"]
```

:::

```sh
bun test                                             # regenerated before the tests run
bun --preload @znight/compiler/bun --watch src/main.ts  # before the app starts, on every restart
```

The preload reads [`znight.config.ts`](#options), generates the container (`test` mode under
`bun test`, `build` with `NODE_ENV=production`, `serve` otherwise; the disk copy is written when it
changed), prints the diagnostics on stderr and, on errors, throws a `ZnightError`: `bun test` exits
with code 1 and `bun --watch` waits for a fix. The Znight decorators of the analysed files are
blanked out (replaced by spaces: line and column numbers are unchanged, no source map needed).

Bun restarts `--watch` processes only for files it loaded: the preload makes Bun watch every file
the container depends on (also after a failed compile), but a newly created provider file is picked
up at the next restart. The preload-only option `logLevel` (`'info'` adds a summary line, `'warn'`
by default, `'silent'`) goes in `znight.config.ts` too.

Importing `@znight/compiler/bun` **runs** the preload. Custom preload files use the side-effect-free
functions of the package root:

```ts
// preload.ts (bunfig.toml: preload = ["./preload.ts"])
import { createPreload, loadZnightConfig } from '@znight/compiler'

const { options } = await loadZnightConfig()
await createPreload({ ...options, logLevel: 'info' })
```

Under Vitest, the Vite plugin plays the same role.

## Programmatic API

```ts
import { compile, formatDiagnostics, generate } from '@znight/compiler'

// Analyse and generate in memory: reads sources, writes nothing
const result = await compile({ root: process.cwd() })
console.log(formatDiagnostics(result.diagnostics, { color: true }))
console.log(result.stats) // { files, providers, durationMs, parsed }

// Same, and write outFile (or only check it is up to date)
await generate({ check: process.env.CI === 'true' })
```

| Export                     | Description                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `znight(options)`          | The Vite plugin (also the default export)                                                              |
| `compile(options)`         | Pure compile: `{ ok, code, outFile, diagnostics, graph, stats, watchFiles, decorators }`               |
| `generate(options)`        | Compile and write `outFile` when it changed (`written`); `check: true` only compares (`stale`)         |
| `createCompiler(options)`  | Incremental compiler for watchers: `compile(changes)` / `generate(changes)` re-read only changed files |
| `formatDiagnostics`        | Pretty-prints diagnostics with code frames (`{ color?, cwd?, summary? }`)                              |
| `renderErrorModule`        | The module served instead of the container when the compilation fails                                  |
| `createPreload(options)`   | The Bun preload with these options (Bun only)                                                          |
| `znightBunPlugin(options)` | The Bun plugin alone: serves the container from memory, blanks the decorators                          |
| `loadZnightConfig(cwd?)`   | `{ file, options }` of `znight.config.*` / `ZNIGHT_CONFIG`                                             |

## Provider libraries

Providers can live in other packages of a monorepo, or in published libraries.

**Source libraries** are analysed from their TypeScript sources, like your own code. Opt in with the
`libraries` option or from the library's manifest:

::: code-group

```json [packages/auth/package.json]
{
  "name": "@acme/auth",
  "exports": { ".": "./src/index.ts" },
  "znight": { "apiVersion": 1, "library": "source" }
}
```

:::

**Compiled libraries** are built with `library: true`: the compiler emits
`dist/znight.providers.json` (providers, scopes, injection points, heritage, interceptors, extension
data). The library references it from its manifest and applications merge it before binding:

```json
{
  "znight": { "apiVersion": 1, "providers": "./dist/znight.providers.json" }
}
```

Library providers get package identities (`@acme/auth#JwtService`) and are imported from the
package's public entry: never through a path into the package.

## Compiler extensions

Feature packages teach the compiler new decorators through **extensions**: `@znight/http` analyses
controllers and routes, `@znight/messaging` consumers, `@znight/config` config classes. They are found
through each package's manifest (`"znight": { "compiler": "@znight/http/compiler" }`), so installing
the package is enough. Third-party extensions must be listed in `trustedExtensions`.

Writing an extension is an advanced topic covered by the
[specification](/contributing/architecture).
