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

| Command                 | What it does                                         |
| ----------------------- | ---------------------------------------------------- |
| `bun run test`          | All tests (`bun test`, packages used from source)    |
| `bun run test:coverage` | Tests with coverage                                  |
| `bun run typecheck`     | `tsc --noEmit` for every package (sources and tests) |
| `bun run check`         | Biome lint + format check                            |
| `bun run check:fix`     | Biome with fixes                                     |
| `bun run build`         | Build every package with tsdown                      |
| `bun run docs:dev`      | Documentation site in development mode               |
| `bun run docs:build`    | Build the documentation site (fails on dead links)   |

## Repository layout

```txt
packages/
  core/           runtime: container, application, plugins, hooks, AOP, scopes, decorators, errors
  compiler/       Vite plugin + programmatic API + Bun preload: analysis, binding, validation, codegen
  http/           decorators, compiler extension, HttpPlugin, adapters (fastify, express, hono)
  messaging/      decorators, compiler extension, MessagingPlugin, drivers
  config/         decorators, compiler extension, ConfigPlugin, loaders
  observability/  logger (pino), metrics (prom-client), tracing (OpenTelemetry)
  testing/        TestBed, TestApp, mock helpers
  cli/            the znight binary
examples/         runnable example applications
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
  `test/fixtures/`.
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
- Sections describing APIs that are not implemented yet are marked with
  `<!-- TODO(api): verify against implementation -->`: search for it when a package lands.
- The brand assets (logo, mark, favicons, social preview) live in `docs/public`.

## Releases

All `@znight/*` packages are versioned in lockstep with Changesets. CI packs every package, installs
the tarballs into a clean application, runs it on Node.js 24 and Bun, then publishes with npm
provenance.
