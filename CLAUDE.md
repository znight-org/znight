# CLAUDE.md

Guidance for AI coding agents (and humans) working on the Znight repository. It is short on purpose:
it tells you how the repository works today and points to the documents that hold the details.

Everything in this repository is written in **English**: code, comments, documentation, commit
messages, pull requests and this file. Znight is an open-source project.

## What Znight is

Znight is a TypeScript backend framework in the spirit of NestJS and Spring Boot, with one major
difference: **dependencies are resolved at build time, not at runtime**. A compiler (a Vite plugin,
also driven by the `znight` CLI and usable as a Bun preload) parses the application with oxc, binds
every constructor parameter to a provider, validates the whole graph and generates a plain
TypeScript module. At runtime the container only calls the generated factories, in an order computed
ahead of time. It is the approach of Micronaut and Dagger, brought to TypeScript: no
`reflect-metadata`, no `emitDecoratorMetadata`, wiring errors at build time.

- Repository: <https://github.com/znight-org/znight> (MIT), npm scope `@znight`.
- Version `0.1.0`, published on npm, every `@znight/*` package versioned in lockstep.
- Runtime packages run on Node.js >= 24 and Bun >= 1.3, ESM only.

## Principles

Every change must keep these. A change that bends one starts with an RFC (see [RFCs](#rfcs)).

1. **Compile-time DI.** Whatever can be resolved at build time is: providers, bindings (interfaces
   through `implements`, qualifiers, factories, optional, lazy and multi dependencies), scopes,
   routes, consumers, config fields, jobs. No reflection, no runtime type lookup.
2. **Decorators are markers.** Every Znight decorator is a no-op at runtime. The compiler reads it
   from the AST; the Vite plugin strips it from the bundle.
3. **Flat DI.** One global container, no modules: providers are discovered by scanning the
   application and its provider libraries. Scopes are `singleton` (default), `request` and
   `transient`; a singleton never depends on a request-scoped provider (ZNIGHT003, `Lazy<T>` is the
   escape hatch).
4. **Convention over configuration.** `znight()` without options builds a server application from
   `src/main.ts`; an interface with one implementation is bound without annotation; config
   properties map to environment variables by name.
5. **Composable.** Each feature is a package made of marker decorators, a compiler extension
   (`@znight/<pkg>/compiler`, discovered through `package.json#znight`) and a runtime plugin
   (`XxxPlugin.configure()`). Install only what you use.
6. **Adapter-agnostic.** HTTP on the built-in `node:http` server, Fastify, Express or Hono;
   messaging on RabbitMQ, SQS, Kafka or in memory. Same behaviour on every adapter, on Node.js and
   Bun. Integrations are optional peer dependencies behind subpath exports.
7. **Observable by default.** `@znight/observability` wires logs, metrics and traces into every HTTP
   request, message delivery and scheduled run.
8. **Fail loudly, early, precisely.** A misconfiguration detectable at build time is a `ZNIGHTxxx`
   diagnostic with a location and a hint. Runtime errors carry a code, the dependency path and the
   original `cause`.
9. **Enterprise-ready.** Provider libraries (source or compiled), monorepos, microservices, workers,
   graceful shutdown, deterministic generated code that you can read and step through.

## Current state

### v0.1 (in this repository)

| Package                 | What it is                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@znight/core`          | Container, application lifecycle, plugins, hooks, AOP (method interceptors), scopes, marker decorators, error catalogue                                                          |
| `@znight/compiler`      | Analysis, binding, validation, code generation; programmatic API, Vite plugin (`znight()`), Bun preload (`@znight/compiler/bun`)                                                 |
| `@znight/http`          | Controllers, Standard Schema validation, guards, interceptors, uploads, streams, cookies, SSE, route decisions, CORS, security headers; `/node`, `/fastify`, `/express`, `/hono` |
| `@znight/openapi`       | OpenAPI 3.1 document built at compile time, served with Scalar or Swagger UI, emitted by `znight openapi` (RFC 0002)                                                             |
| `@znight/messaging`     | Consumers, retries, dead letters; `/memory`, `/rabbitmq`, `/sqs`, `/kafka` drivers                                                                                               |
| `@znight/schedule`      | `@Cron`, `@Interval`, `@Timeout`, `SchedulerRegistry`, lock stores, virtual clock for tests (RFC 0004)                                                                           |
| `@znight/config`        | Typed config classes loaded from env, `.env`, JSON/YAML, Vault, AWS Secrets Manager                                                                                              |
| `@znight/observability` | Pino logger, Prometheus metrics (prom-client), OpenTelemetry tracing, `@Logged`, `@Traced`, `@Metric`                                                                            |
| `@znight/testing`       | `TestBed` (auto-mocked dependencies), `TestApp` (in-memory end-to-end tests), mocks and spies                                                                                    |
| `@znight/cli`           | The `znight` binary: `new`, `generate`, `g`, `dev`, `build`, `start`, `openapi`                                                                                                  |

Releases: [`RELEASING.md`](RELEASING.md). `main` is protected, so every change goes through a pull
request whose CI (`ci.yml`, every check; the ruleset requires its `all-checks-complete` job)
passes. A push to `main` only starts `release.yml`, which runs CI on the pushed commit. Changesets
feed a "chore: version packages" pull request; merging it publishes to npm after an approval in the
`npm` environment, then deploys the docs site to GitHub Pages (`docs.yml`).

### Product decisions

Respect them; do not reopen them in passing.

- **No `@znight/security` package in v0.1** (RFC 0001). Security lives in `@znight/http`: route
  decision groups (`createRouteDecorator(key, { group, required })`, guards declaring
  `static enforces`) checked at build time (ZNIGHT023) and at boot, CORS, security headers and
  `trustProxy`. JWT, API keys, rate limiting, CSRF and the like are recipes in
  `docs/guide/security.md`, compiled and tested in `examples/secure-api`.
- **Caching**: `@znight/cache` is on the roadmap. Today, caching is a method interceptor (the
  "Cache" recipe of `docs/guide/aop.md`).
- **Data layer**: Znight deliberately leaves the ORM choice to developers. For SQL, Drizzle is
  strongly recommended: `examples/rest-api` shows Drizzle on PGlite, provided through
  `@Factory`/`@Provides` (guide: `docs/guide/data-access.md`). SQL helper decorators or annotations
  (entities, columns, repositories, queries) are explicitly **not** on the roadmap.
- **Built-in sessions and server-side MVC** (a session store, templates, views) are out of scope.
  Signed cookies are built in, and `examples/secure-api` shows a cookie-session recipe.
- **WebSocket and GraphQL** are deferred to v0.2 (RFC 0003, RFC 0005); their error code blocks are
  reserved.

### Roadmap

The roadmap page is [`docs/roadmap.md`](docs/roadmap.md): planned for v0.2, `@znight/websocket`
(RFC 0003) and `@znight/graphql` (RFC 0005); planned without a date or an RFC yet, `@znight/cache`;
then what is considered and what is not planned. RFC statuses live in
[`rfcs/README.md`](rfcs/README.md). There is no TODO list in this file: read the roadmap, the RFCs
and the GitHub issues before starting a feature, and keep the roadmap page up to date when a
decision changes.

## Stack

| Area                  | Choice                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Workspace             | Bun 1.4 workspaces + catalogs (`package.json#workspaces`); `bunfig.toml` pins exact versions on install |
| Runtimes              | Node.js >= 24 (`.nvmrc`), Bun >= 1.3; ESM only                                                          |
| Language              | TypeScript 7 (native `tsc`, `--noEmit` only), `experimentalDecorators`                                  |
| Compiler internals    | `oxc-parser`, `oxc-resolver`, `magic-string`, `tinyglobby`, `picocolors`                                |
| Application build     | Vite 8 with the `znight()` plugin; Bun preload `@znight/compiler/bun` for `bun test` / `bun --watch`    |
| Package build         | tsdown (ESM `.mjs` + `.d.mts`, entries in each `tsdown.config.ts`)                                      |
| Lint and format       | Biome 2.6 (`biome.jsonc`); husky + lint-staged run `biome check --write` on staged files                |
| Tests                 | `bun test` (`bun:test`); Testcontainers for broker integration tests                                    |
| Documentation         | VitePress 1.6 (`docs/`)                                                                                 |
| HTTP (optional peers) | built-in `node:http`, Fastify 5, Express 5, Hono 4 (+ `@hono/node-server` on Node.js)                   |
| Validation            | any Standard Schema library (Zod 4 in the examples, Valibot, ArkType...)                                |
| Messaging (peers)     | `amqplib`, `@aws-sdk/client-sqs`, `@platformatic/kafka`                                                 |
| Observability         | `pino`, `@opentelemetry/api`; optional `prom-client`, `pino-pretty`                                     |
| CLI                   | `citty`, `@clack/prompts`                                                                               |

## Repository layout

```txt
packages/<pkg>/          one folder per @znight/* package
  src/                   sources; index.ts is the runtime entry, compiler/ the compiler extension
  test/                  bun:test tests, fixtures/, own tsconfig.json (Bun types, decorators allowed)
  README.md              detailed reference: options, "Compiler contract", limitations
  tsdown.config.ts       build entries (must match package.json#exports)
packages/compiler/src/   project/ (scan, parse, identities), analysis/, binding/, graph/, validation/,
                         codegen/, diagnostics/ (formatting), extensions/ (extension API),
                         shapes/ (type shapes for extensions), library/ (compiled libraries),
                         vite.ts (Vite plugin), bun.ts (Bun preload)
examples/                runnable applications with their tests: rest-api, microservice, worker,
                         secure-api, storefront-api, uptime-monitor, monorepo (packages/shared,
                         services/users-api, services/notifications-worker)
docs/                    VitePress site: guide/, packages/, reference/, contributing/, test/,
                         internals/architecture.md (the normative spec, served at /contributing/architecture)
rfcs/                    design documents, their status and the error code allocation (README.md)
scripts/                 brand/ (logo generator), docs/diagrams/ (generates docs/public/diagrams/*.svg)
tests/                   repository-wide tests: boundaries.test.ts, golden.test.ts, support/
```

## How it works

```txt
src/**/*.ts ─▶ @znight/compiler ─▶ src/.znight/container.generated.ts ─▶ Application.create()
  scan → parse (oxc, cached by content hash) → per-file facts → canonical identities
  → class analysis (core + compiler extensions) → merge compiled libraries → bind → validate
  → emit → re-parse check → write if changed
```

Tokens are canonical identities: `src/users/user.service.ts#UserService` for an application class,
`@znight/observability#Logger` for a package export or an external supplied by a plugin. An excerpt
of a generated module (from the specification, §3.3):

```ts
// AUTO-GENERATED by @znight/compiler 0.1.0. Do not edit.
import type { ZnightMetadata } from '@znight/core'
import { UserController } from '../users/user.controller.js'
import { UserService } from '../users/user.service.js'

export const __ZNIGHT_METADATA__: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {
    ['src/users/user.controller.ts#UserController']: {
      scope: 'singleton',
      class: UserController,
      deps: ['src/users/user.service.ts#UserService'],
      factory: d => new UserController(d[0]),
    },
    // ...
  },
  resolutionOrder: ['src/app.config.ts#AppConfig', 'src/users/user.service.ts#UserService' /* ... */],
  externals: [{ token: '@znight/observability#Logger', providedBy: 'ObservabilityPlugin' } /* ... */],
  extensions: {
    ['http']: {
      ['controllers']: [
        /* routes, each with a generated invoke() */
      ],
    },
  },
}
```

At runtime, `main.ts` imports that module and calls
`Application.create({ metadata: __ZNIGHT_METADATA__, plugins: [...] })`: plugins `register` (they
supply the externals of their manifest), `container.init()` instantiates singletons in
`resolutionOrder` (independent async singletons concurrently), plugins run `onBootstrap`.
`app.start()` runs `onStart`, the plugins start listening, then `onReady`; SIGINT/SIGTERM trigger a
graceful `app.stop()`.

## Conventions

### The specification comes first

`docs/internals/architecture.md` is the **normative contract** between the compiler and the runtime
packages (MUST/SHOULD/MAY; "Impl." paragraphs are implementation-defined). A change to the metadata
shape, a decorator, a manifest, a compiler extension API, a plugin contract or an error code updates
the specification **in the same change**. Then update the package README (the detailed user
reference) and the docs pages. Code samples in Markdown must match the real API: the docs tests check
every `@znight/*` import of the README files and of the site. Prefer copying samples from tests and
examples.

### RFCs

A significant change (a new package, a new decorator family, a change of the compiler/runtime
contract) starts as `rfcs/NNNN-<topic>.md`, with the header table of the existing RFCs (Status, Date,
Affects, Decision) and a row in `rfcs/README.md`. Implement it only once it is accepted.

### Package sources

- Sources run as is on Node.js 24 (type stripping) and Bun: relative imports use the `.ts` suffix
  (`import { Container } from './container.ts'`).
- `erasableSyntaxOnly`: no enums, namespaces, parameter properties or decorators in
  `packages/*/src` (tests and examples may use them). Use `as const` objects instead of enums.
- `isolatedDeclarations`: explicit types on every export.
- `noPropertyAccessFromIndexSignature`: read index signatures with brackets
  (`process.env['NODE_ENV']`). The base config is strict (`noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `noImplicitOverride`).
- ESM only, small focused modules, JSDoc on public APIs, no `any` without a justified `biome-ignore`.
- A new entry point is declared in `tsdown.config.ts` **and** in `package.json#exports`, with the
  `@znight/source` / `types` / `default` triple.
- Third-party integrations are **optional peer dependencies** (with exact devDependencies for the
  tests), behind subpath exports. Optional peers needed by a root entry are loaded lazily
  (non-literal dynamic import, or `createRequire` for CommonJS). Third-party ranges use carets;
  `@znight/core` is a `workspace:*` dependency, `@znight/compiler` a `workspace:^` optional peer.
- Boundaries, enforced by `tests/boundaries.test.ts`: `<pkg>/compiler` entries only `import type`
  from `@znight/compiler` and never import their package's runtime entry (building must not load
  fastify, amqplib...); runtime entries never import `./compiler`. Code shared by both sides lives in
  import-free modules.
- Every helper the generated code calls is exported from the package root, documented in the
  "Compiler contract" section of the package README and kept stable.
- Features plug into the compiler through the package manifest (`package.json#znight`: `apiVersion`,
  `compiler`, `provides`, `interceptors`; specification §7).

### Tests

- `packages/<pkg>/test/**/*.test.ts` with `bun:test`, fixtures in `test/fixtures/`.
- Opt-in suites: `ZNIGHT_INTEGRATION=1` (real brokers, Docker), `ZNIGHT_CLI_E2E=1` (a scaffolded
  application end to end), `ZNIGHT_E2E=1` (the examples end to end and the golden test, after
  `bun run build`).
- `tests/golden.test.ts` checks that the generated module of every example is byte-identical from
  sources or from `dist`, on Node.js or Bun, in `build` or `serve` mode: keep code generation
  deterministic (no timestamps, ordering by canonical identity only).
- `docs/test` checks the Markdown samples, the root README, the site links, the sidebars and the
  error reference.

### Style and commits

- Biome: 2 spaces, 120 columns, single quotes, no semicolons, trailing commas; imports grouped as
  type imports, then `node:` and packages, then relative paths. `bun run check` must report no error.
- Conventional Commits: `feat(http): ...`, `fix(compiler): ...`, `docs: ...`.
- Never push to `main`: work on a branch and open a pull request. A change that users of a
  published package see comes with a changeset (`bun run changeset`, or a `.changeset/<name>.md`
  file: `'@znight/http': patch` front matter and a one-line summary; `minor` for a breaking change
  before 1.0). Docs-, tests-, examples- or CI-only changes need none.

### Error codes

- The catalogue is `ErrorCode` (`as const`) + `ERROR_DESCRIPTIONS` in
  `packages/core/src/errors.ts`, shared by compiler diagnostics and runtime `ZnightError`s.
- Ranges (`rfcs/README.md`): `ZNIGHT001`–`029` core, compiler and the 0.1 features (http, messaging,
  config, observability); `030`–`039` openapi; `040`–`049` schedule; `050`–`059` websocket and
  `060`–`069` graphql (reserved for v0.2). Codes are allocated in order without gaps inside a block
  and never change meaning. Reuse a lower code when the meaning is the same (a decorator on the
  wrong target is always ZNIGHT005); one catch-all code per package for invalid usage and options;
  third-party packages get no code.
- A new code needs, in the same change: the `ErrorCode` entry and its description, a row in the
  specification's validation table (§4.8), and in `docs/reference/error-codes.md` a row of the
  summary table (phases among `build`, `startup`, `runtime`, `shutdown`), a
  `## ZNIGHTxxx: Title {#znightxxx}` section and the updated range in the frontmatter description.
  `docs/test/site.test.ts` enforces all of it.

### Documentation site

- Every page has a frontmatter `description` and appears in a sidebar of `docs/.vitepress/config.ts`.
- Link pages with absolute paths without extension (`/guide/scopes#rules-between-scopes`) and
  repository files with relative paths (`../../packages/core/src/errors.ts`, rewritten to GitHub).
- A section documenting an API that is not implemented yet is marked
  `<!-- TODO(api): verify against implementation -->`; any other `TODO` comment fails the tests.

## Development commands

| Command                    | What it does                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `bun install`              | Install every workspace (also installs the husky hook)                                 |
| `bun run build`            | Build every package with tsdown (`dist/`)                                              |
| `bun run test`             | Tests of `packages/`, `docs/` and `tests/`, packages used from source                  |
| `bun run test:coverage`    | The same with coverage                                                                 |
| `bun run test:examples`    | The `test` script of every example                                                     |
| `bun run test:e2e`         | Build, then the examples, the golden test and the CLI end-to-end test with their flags |
| `bun run test:integration` | Messaging drivers against real brokers (Docker required)                               |
| `bun run typecheck`        | `tsc --noEmit` for every workspace (sources and tests) and `tests/`                    |
| `bun run check`            | Biome lint + format check (`check:fix` to fix, `lint`, `format`)                       |
| `bun run docs:dev`         | Documentation site in development mode                                                 |
| `bun run docs:build`       | Production build of the site (fails on dead links)                                     |

Targeted runs: `bun test --conditions=@znight/source ./packages/http` (one package),
`bunx biome check --diagnostic-level=error <paths>`, `bun run --cwd packages/http typecheck`.

Run an example (the CLI and Vite load the packages' `dist`, so build first):

```sh
bun install
bun run build
bun run --cwd examples/rest-api dev    # rebuilds and restarts on change, NODE_ENV=development
bun run --cwd examples/rest-api test   # bun test --conditions=@znight/source
```

Each example README lists its endpoints with `curl` commands.

Before calling a change done: `bun run test`, `bun run typecheck`, `bun run check`, the tests of the
examples you touched, `bun run docs:build` when docs changed, and the specification, package README
and docs updated with the code.

## Known pitfalls

- **The `@znight/source` condition.** Each package exports its TypeScript sources under the
  `@znight/source` condition, before `types`/`default` (`dist`). Without
  `--conditions=@znight/source`, `bun test` resolves `@znight/*` imports to `dist`, which may be
  missing or stale. The root scripts and the example `test` scripts pass the flag; do the same.
- **A `tsconfig.json` type-checking the sources through the condition**
  (`customConditions: ["@znight/source"]`, like the examples) also needs
  `allowImportingTsExtensions` (hence `noEmit`), since the sources import each other with `.ts`
  (TS5097 otherwise).
- **Generated files are not committed.** `src/.znight/` is gitignored and regenerated by the Vite
  plugin, the Bun preload (`bunfig.toml` → `[test] preload = ["@znight/compiler/bun"]`) or
  `znight generate` (`--check` exits 1 when stale). Never edit it by hand, and never import it from a
  provider module (ZNIGHT020): only `main.ts` and tests import it.
- **`dist` is needed by the CLI and by Vite.** `packages/cli/bin/znight.mjs` loads `dist/cli.mjs`,
  and Vite configs load the built packages: run `bun run build` before `dev`, `build`, `start` or
  `test:e2e` of the examples, and again after changing a package they use. In-repo Vite configs keep
  the linked `@znight/*` packages in `ssr.external`.
- **TypeScript 7 has no JavaScript API.** `tsc` is the native compiler; tools that import the
  TypeScript 5 JS API (`openapi-typescript`, ts-morph, typedoc...) fail with the `typescript` 7
  package. Run them with their own TypeScript 5, outside the workspace's dependencies (see
  `client:generate` in `examples/storefront-api`:
  `npm exec --package=typescript@5.9.3 --package=openapi-typescript@... --`; not `npx -p`, which
  `bun run` turns into `bun x`, which keeps only the last `-p`).
  The Znight compiler uses oxc, never the TypeScript API.
- **Generated code must stay strict-clean.** It must type-check under `strict`, `noUnusedLocals`,
  `noUnusedParameters`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes` and
  `verbatimModuleSyntax` (`packages/compiler/test/codegen/typecheck.test.ts`), stay byte-identical
  across runs, runtimes and source/dist (golden test), and data keys are emitted as computed string
  keys (`['findById']`).
- **Tests and examples may use decorators, package sources may not** (`erasableSyntaxOnly`): the
  marker decorators are plain functions in `src/`, applied only in user code.

## Pointers

- Specification: [`docs/internals/architecture.md`](docs/internals/architecture.md). Contributing:
  [`CONTRIBUTING.md`](CONTRIBUTING.md) (short version) and
  [`docs/contributing/index.md`](docs/contributing/index.md).
- Roadmap: [`docs/roadmap.md`](docs/roadmap.md); RFCs: [`rfcs/README.md`](rfcs/README.md) (0001
  security, 0002 openapi, 0003 websocket, 0004 schedule, 0005 graphql, 0006 cookies and SSE).
- Guides (`docs/guide/`): introduction, getting-started, project-structure, dependency-injection,
  scopes, lifecycle, plugins, aop, compiler, data-access, testing, security, scheduling,
  deployment, migrating-from-nestjs.
- Reference: `docs/packages/<name>.md` (one page per package), `docs/reference/decorators.md`,
  `docs/reference/error-codes.md`; the package READMEs (`packages/<name>/README.md`) hold the full
  details.
- Examples ([`docs/examples.md`](docs/examples.md) describes them): `rest-api` (Fastify, Drizzle on
  PGlite, API keys), `microservice` (Hono, RabbitMQ, traces across HTTP and messaging), `worker`
  (consumers only), `secure-api` (route decisions, JWT, API keys, cookie sessions, signed webhooks:
  the tested source of the security guide), `storefront-api` (OpenAPI, typed client),
  `uptime-monitor` (scheduled jobs, SSE: the tested source of the scheduling guide), `monorepo` (a
  shared provider library and two services).
