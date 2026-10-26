---
description: How to contribute to Znight - repository layout, tooling (Bun, TypeScript 7, Biome, tsdown), conventions, tests and the documentation site.
---

# Contributing

Thanks for your interest in Znight! Issues, discussions and pull requests are welcome on
[GitHub](https://github.com/ugho49/Znight).

## Setup

The repository is a [Bun](https://bun.sh) workspace. You need Bun 1.3+ and Node.js 24+.

```sh
git clone https://github.com/ugho49/Znight.git
cd Znight
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

## Repository layout

```txt
packages/
  core/           runtime: container, application, plugins, hooks, AOP, scopes, decorators, errors
  compiler/       Vite plugin + programmatic API + Bun preload: analysis, binding, validation, codegen
  http/           decorators, compiler extension, HttpPlugin, adapters (node, fastify, express, hono)
  messaging/      decorators, compiler extension, MessagingPlugin, drivers
  config/         decorators, compiler extension, ConfigPlugin, loaders
  observability/  logger (pino), metrics (prom-client), tracing (OpenTelemetry)
  testing/        TestBed, TestApp, mock helpers
  cli/            the znight binary
examples/         runnable example applications (rest-api, microservice, worker, monorepo), with their tests
tests/            repository-wide tests: package boundaries, golden test of the examples
docs/             this site (VitePress); docs/internals holds the architecture specification
```

## The specification comes first

[`docs/internals/architecture.md`](/contributing/architecture) is the **normative contract** between
packages: the compiler generates code that runtime packages consume, so both sides must follow it.
When an implementation needs to deviate, update the specification in the same change.

## Conventions

- **Source condition.** Each package exposes a `@znight/source` export condition pointing to its
  TypeScript sources; repository scripts run with `--conditions=@znight/source`, so nothing needs to
  be built to test.
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
- **Integrations** (fastify, amqplib, pino...) are optional peer dependencies, loaded from subpath
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

All `@znight/*` packages are versioned in lockstep. The release process is planned, not set up yet:
Changesets with a fixed group, CI packing every package, installing the tarballs into a clean
application, running it on Node.js 24 and Bun, then publishing with npm provenance.
