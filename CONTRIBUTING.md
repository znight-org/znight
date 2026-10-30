# Contributing to Znight

Thanks for your interest in Znight! Bug reports, ideas, documentation fixes and pull requests are all
welcome. This page is the practical short version; the
[full contributing guide](./docs/contributing/index.md) goes deeper into the conventions and the
documentation site.

Everyone taking part in the project follows the [code of conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug.** Open an issue with the Znight version, the runtime and its version (Node.js or
  Bun), a minimal reproduction and, for a build or boot error, the full `ZNIGHTxxx` diagnostic.
- **Suggest a feature.** Open an issue or a discussion first. Significant changes (a new package, a
  new decorator, a change to the generated metadata) go through an [RFC](#propose-an-rfc).
- **Improve the documentation.** Typos, unclear explanations and missing examples are worth a pull
  request.
- **Report a vulnerability privately.** Do not open a public issue: use GitHub's
  [private vulnerability reporting](https://github.com/znight-org/znight/security/advisories/new)
  (the **Security** tab of the repository, then **Report a vulnerability**).

## Setup

You need [Bun](https://bun.sh) 1.4 (the version pinned in `package.json#packageManager`) and
Node.js 24 or later (`.nvmrc`).

```sh
git clone https://github.com/znight-org/znight.git
cd znight
bun install
bun run test
```

`bun install` also installs the pre-commit hook (husky and lint-staged), which runs Biome on the
staged files. Nothing needs to be built to run the tests: every package exposes a `@znight/source`
export condition pointing to its TypeScript sources, and the repository scripts run with
`--conditions=@znight/source`.

## Commands

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

To run the tests of one package, point `bun test` at its folder:
`bun test --conditions=@znight/source ./packages/http`.

## Run an example

The example applications use the `znight` CLI and the production build, which load the packages'
`dist`: build the framework once, then start an example in development mode.

```sh
bun run build
cd examples/rest-api
bun run dev   # rebuilds and restarts on every change
```

The examples that need development settings (credentials, sample data) read them from their
`.env.development`, and each README lists its endpoints with `curl` commands. If `znight` reports that `dist/cli.mjs` is missing, run
`bun run build` again from the repository root.

## Repository layout

```txt
packages/   the published packages: core, compiler, http, openapi, messaging, schedule, config,
            observability, testing, cli (sources in src/, tests in test/)
examples/   runnable example applications, with their tests
tests/      repository-wide tests: package boundaries, golden test of the examples
docs/       the documentation site (VitePress); docs/internals/architecture.md is the specification
rfcs/       design documents for significant changes
scripts/    repository tooling (brand assets, documentation diagrams)
```

The [full contributing guide](./docs/contributing/index.md#repository-layout) describes each package.

## Conventions

- **The specification comes first.** [`docs/internals/architecture.md`](./docs/internals/architecture.md)
  is the normative contract between the compiler, which generates code, and the runtime packages,
  which consume it. When an implementation needs to deviate, update the specification in the same
  change.
- **Tests are required.** Every change comes with tests, and a bug fix starts with a failing one.
  Tests live in `packages/<pkg>/test/**/*.test.ts` and use `bun:test`, with fixtures in
  `test/fixtures/`. Slow suites are opt-in: `ZNIGHT_INTEGRATION=1` (real brokers), `ZNIGHT_CLI_E2E=1`
  (a scaffolded application) and `ZNIGHT_E2E=1` (the examples end to end, after `bun run build`; the
  `client:check` of `examples/storefront-api` runs `npm exec`, so the first run needs npm and the
  registry).
- **Biome formats and lints everything.** `bun run check` must pass; `bun run check:fix` fixes most
  problems.
- **Package sources run as is on Node.js 24 and Bun.** In `packages/*/src`, relative imports use the
  `.ts` extension, the code is `erasableSyntaxOnly` (no parameter properties, enums, namespaces or
  decorators; tests may use them) and `isolatedDeclarations` (explicit types on exports).
- **Small, focused modules**, ESM only, JSDoc on public APIs, no `any` without a justified
  `biome-ignore`.
- **Integrations** (Fastify, amqplib...) are optional peer dependencies, loaded from subpath exports.
  The published packages declare caret ranges for their dependencies and peers; development
  dependencies are pinned to exact versions (`bunfig.toml`), and versions shared by several
  workspaces live in the catalog (`package.json#workspaces.catalog`).
- **Errors** use the codes of `ErrorCode` in `@znight/core`. A new code needs an entry in
  `ERROR_DESCRIPTIONS`, in the specification and in the
  [error reference](./docs/reference/error-codes.md), taken from the range allocated to its package
  in [`rfcs/README.md`](./rfcs/README.md).
- **Documentation ships with the code.** The docs tests check every `@znight/*` import of the
  Markdown files against the real exports, and `bun run docs:build` fails on dead links.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org): `feat(http): ...`,
  `fix(compiler): ...`, `docs: ...`, `test(schedule): ...`, `chore: ...`, with `!` for a breaking
  change.

## Pull requests

Every change to `main` goes through a pull request, the maintainers' included, and is merged once
CI passes: lint, typecheck, build and pack, unit and example tests, docs build, end-to-end tests on
Node.js and Bun, Docker integration tests, and the packed packages installed in a fresh
application.

- Keep each pull request focused on one change, and link the issue or the RFC it addresses.
- Before pushing, run `bun run check`, `bun run typecheck` and `bun run test`; add
  `bun run test:examples` when an example changes and `bun run docs:build` when the docs change.
- Describe what changed, why, and how it was tested.

## Add a changeset

All `@znight/*` packages are versioned in lockstep with [Changesets](https://changesets.dev). A pull
request that changes a published package for its users (a feature, a fix, a behaviour or dependency
change) adds a changeset: run `bun run changeset`, pick the bump (before 1.0, a breaking change is a
minor bump, everything else a patch), write the changelog entry, and commit the generated
`.changeset/*.md` file with your change. Docs-, tests-, examples- or CI-only changes need none; CI
reminds you (a warning, never a failure) when packages change without one. Maintainers release from
there: [RELEASING.md](RELEASING.md).

## Propose an RFC

Significant changes start as a design document in [`rfcs/`](./rfcs/README.md), discussed before any
implementation:

1. Open an issue or a discussion to check that the idea fits the project.
2. Add `rfcs/NNNN-short-title.md` with the next free number, and a row in
   [`rfcs/README.md`](./rfcs/README.md).
3. Follow the shape of the existing RFCs: a header table (status, date, affected packages, decision),
   then a summary, what exists today (checked against the code), goals and non-goals, the detailed
   design (user-facing API, compile-time analysis and diagnostics, generated metadata, runtime),
   the alternatives considered and a test plan.
4. The RFC is discussed in its pull request. Once it is accepted, the implementation updates the
   specification and the documentation.

## Further reading

- [Full contributing guide](./docs/contributing/index.md): conventions, the documentation site,
  releases.
- [Architecture specification](./docs/internals/architecture.md): the contract between the
  compiler and the runtime packages.
- [Error reference](./docs/reference/error-codes.md) and [RFC index](./rfcs/README.md).
