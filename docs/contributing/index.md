---
description: How to contribute to Znight - repository layout, tooling (Bun, TypeScript 7, Biome, tsdown), conventions, tests and the documentation site.
---

# Contributing

Thanks for your interest in Znight! Issues, discussions and pull requests are welcome on
[GitHub](https://github.com/znight-org/znight).

## Setup

The repository is a [Bun](https://bun.sh) workspace. You need Bun 1.4 (the version pinned in
`package.json#packageManager`) and Node.js 24+ (`.nvmrc`). Applications built with Znight only need
Bun 1.3+ or Node.js 24+.

```sh
git clone https://github.com/znight-org/znight.git
cd znight
bun install
```

| Command                    | What it does                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `bun run test`             | Tests of the packages, the docs and the repository (`tests/`), packages used from source                                |
| `bun run test:coverage`    | The same with coverage                                                                                                  |
| `bun run test:examples`    | The `test` script of every example application                                                                          |
| `bun run test:e2e`         | Builds the packages, then the examples with `ZNIGHT_E2E=1`, the golden test of the examples and the CLI end-to-end test |
| `bun run test:integration` | Messaging drivers against real brokers (`ZNIGHT_INTEGRATION=1`, Docker and Testcontainers)                              |
| `bun run typecheck`        | `tsc --noEmit` for every workspace (sources and tests) and `tests/`                                                     |
| `bun run check`            | Biome lint + format check                                                                                               |
| `bun run check:fix`        | Biome with fixes                                                                                                        |
| `bun run build`            | Build every package with tsdown                                                                                         |
| `bun run docs:dev`         | Documentation site in development mode                                                                                  |
| `bun run docs:build`       | Build the documentation site (fails on dead links)                                                                      |

## Run an example

The example applications (`examples/*`) use the `znight` CLI and the production build, which load
the packages' `dist`. Build the framework once, then run an example in development mode:

```sh
bun install
bun run build
cd examples/rest-api
bun run dev
```

`dev` rebuilds and restarts the application on every change. The examples that need development
settings (credentials, sample data) read them from their `.env.development`. Every example README
lists its endpoints with `curl` commands; [Examples](/examples) describes each one. If `znight`
reports that `dist/cli.mjs` is missing, run `bun run build` again from the repository root.

## Repository layout

```txt
znight/
├─ packages/
│  ├─ core/           # runtime: container, application, plugins, hooks, AOP, scopes, decorators, errors
│  ├─ compiler/       # Vite plugin, programmatic API, Bun preload: analysis, binding, validation, codegen
│  ├─ http/           # decorators, compiler extension, HttpPlugin, adapters (node, fastify, express, hono)
│  ├─ openapi/        # decorators, compiler extension, OpenApiPlugin (Scalar, Swagger UI), build-time emit
│  ├─ messaging/      # decorators, compiler extension, MessagingPlugin, drivers
│  ├─ schedule/       # decorators, compiler extension, SchedulePlugin, distributed locks
│  ├─ config/         # decorators, compiler extension, ConfigPlugin, loaders
│  ├─ observability/  # logger (pino), metrics (prom-client), tracing (OpenTelemetry)
│  ├─ testing/        # TestBed, TestApp, mock helpers
│  └─ cli/            # the znight binary
├─ examples/          # runnable applications with their tests: rest-api, secure-api, storefront-api,
│                     # uptime-monitor, microservice, worker, monorepo
├─ rfcs/              # design documents of significant features, with their status
├─ tests/             # repository-wide tests: package boundaries, golden test of the examples
├─ scripts/           # generators of the brand assets and of the documentation diagrams
└─ docs/              # this site (VitePress); docs/internals holds the architecture specification
```

## RFCs

Significant features (a new package, a new cross-package contract) start as an RFC in
[`rfcs/`](https://github.com/znight-org/znight/tree/main/rfcs), discussed before any implementation.
Its README lists every RFC with its status and allocates the error code ranges of the packages. The
[roadmap](/roadmap) summarises where each one stands.

## The specification comes first

[`docs/internals/architecture.md`](/contributing/architecture) is the **normative contract** between
packages: the compiler generates code that runtime packages consume, so both sides must follow it.
When an implementation needs to deviate, update the specification in the same change.

## Conventions

- **Source condition.** Each package exposes a `@znight/source` export condition pointing to its
  TypeScript sources; repository scripts run with `--conditions=@znight/source`, so nothing needs to
  be built to test. A `tsconfig.json` that type-checks the framework sources through the condition
  (`"customConditions": ["@znight/source"]`, as the examples do, or importing them by path, as
  `docs/test` does) also needs
  `"allowImportingTsExtensions": true` (with `noEmit`): the sources import each other with the
  `.ts` suffix, which `tsc` otherwise rejects (TS5097).
- **Sources run as is on Node.js 24 and Bun**: relative imports use the `.ts` suffix;
  `erasableSyntaxOnly` (no parameter properties, enums, namespaces or decorators in `src/`; tests may
  use them); `isolatedDeclarations` (explicit types on exports).
- **Small, focused modules**, ESM only, JSDoc on public APIs, no `any` without a justified
  `biome-ignore`.
- **Tests** live in `packages/<pkg>/test/**/*.test.ts` and use `bun:test`; fixtures in
  `test/fixtures/`. Slow tests are opt-in: `ZNIGHT_INTEGRATION=1` (real brokers),
  `ZNIGHT_CLI_E2E=1` (a scaffolded application, end to end), `ZNIGHT_E2E=1` (the examples end to end
  and the golden test, after `bun run build`). `tests/boundaries.test.ts` enforces the package
  boundaries of the specification (§2).
- **Integrations** (fastify, amqplib, prom-client...) are optional peer dependencies, loaded from subpath
  exports.
- **Generated-code contract**: every helper the compiler-generated code calls is exported from the
  package's root entry, documented in a "Compiler contract" section of its README and kept stable.
- **Errors** use codes from `ErrorCode` in `@znight/core`. A new code needs an entry in
  `ERROR_DESCRIPTIONS`, in the specification and in the [error reference](/reference/error-codes).
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat(core): ...`, `fix(compiler): ...`, `docs: ...`).

## Documentation

The site lives in `docs/` and is built with [VitePress](https://vitepress.dev):

```sh
bun run docs:dev     # http://localhost:5173
bun run docs:build   # production build, fails on dead links
```

- Pages are Markdown with VitePress extensions (`::: tip`, `::: code-group`, `<Badge>`...).
- Link to other pages with absolute paths without extension (`/guide/scopes#rules-between-scopes`).
- Link to repository files with relative paths (`../../packages/core/src/errors.ts`): they are
  rewritten to GitHub links at build time.
- Every error code has an anchor (`/reference/error-codes#znight001`) that runtime and compiler
  messages can link to.
- A section describing an API that is not implemented yet is marked with an HTML comment starting
  with `TODO(api): verify against implementation` (the docs tests reject any other `TODO` comment);
  remove it once the section has been checked against the implementation.
- The brand assets (logo, mark, favicons, social preview) live in `docs/public`.

## Releases

All `@znight/*` packages are versioned in lockstep. Continuous integration, Changesets and the
release procedure are being set up in pull request #1, not merged into `main` yet; this section
will link to the maintainer documentation once it lands.
