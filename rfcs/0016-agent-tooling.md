# RFC 0016: Agent tooling (skills and a machine-readable CLI)

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Draft                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Date     | 2026-11-17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Affects  | New `skills/` directory (Agent Skills, also published as a Claude Code plugin); `@znight/cli` (`--format json` on `generate` and `build`, new commands `explain`, `inspect`, `add`, `migrate`, `skills`; the skills bundled in the package; `znight new` writes an `AGENTS.md`); `@znight/compiler` (none: `CompileResult` already carries diagnostics and the graph); docs (a guide page "Coding agents", the CLI reference, the roadmap); tests (a skills test next to `docs/test`); specification §11. No runtime package, no metadata change, no error code                                                       |
| Decision | **Proposed.** Znight ships what a coding agent needs to migrate an application to Znight and to add features to it as **Agent Skills** kept in this repository and versioned with the packages: one core skill, two migration skills (NestJS, home-made or third-party DI) and one feature skill with a reference per package, every package covered (enforced by a test). The **compiler is the agent's oracle**: the skills drive a loop of small edits checked by `znight generate --check`. The CLI gets the machine-readable outputs the skills call. An MCP server (`@znight/mcp-server`) is a possible later layer over the same CLI functions, not the first step |

## 1. Summary

More and more of the code written with a framework is written by coding agents (Claude Code, Codex,
Cursor, Copilot, Gemini CLI…). Two jobs come up again and again for Znight:

- **Migrating to Znight**: from NestJS, or from a hand-written composition root, a service locator
  or a runtime container (tsyringe, InversifyJS, TypeDI, awilix).
- **Adding a feature** to a Znight application: GraphQL, WebSocket gateways, application events,
  messaging, scheduled jobs, observability, OpenAPI, typed config, tests… and wiring it correctly
  (the plugin, its options, route decisions, the compiler extension, the example tests).

An agent does both badly today. It knows NestJS well and Znight not at all, so it writes `@Module`s,
`@Inject('TOKEN')`, `forwardRef` and `reflect-metadata`, then guesses. Yet Znight has an asset no
runtime container has: **every wiring mistake is a located `ZNIGHTxxx` diagnostic with a hint, at
build time** (principle 8). An agent that is told how Znight works and that checks every step with
`znight generate --check` converges; one that is not wanders.

This RFC proposes three layers, in this order:

1. **Skills** (§4): procedures and checklists in the [Agent Skills](https://agentskills.io/specification)
   format, loaded by the agent only when the task needs them. They hold the _how_ and point to the
   documentation for the _what_, so they do not drift from it.
2. **A machine-readable CLI** (§5): diagnostics as JSON, `znight explain ZNIGHTxxx`, `znight inspect`
   (the application graph), `znight add <feature>` (install and register a package), and
   `znight migrate nestjs --report` (a read-only inventory). The skills call them; humans and CI can
   too.
3. **Later, and only on evidence, an MCP server** `@znight/mcp-server` (§7) wrapping the same functions
   for clients that have no shell.

## 2. Why skills first, and not an MCP server

| Need of the agent                                                                    | Best carrier                                                 | Why                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Know Znight's model (flat DI, markers, scopes, decisions) and its conventions         | Skill                                                        | Static knowledge, needed only for Znight tasks. A skill costs its one-line description until it is used; an MCP server's tool list sits in the context of every conversation                |
| Follow a procedure (migrate module by module, add GraphQL in this order, check this) | Skill                                                        | A procedure is prose with checkpoints, not an API                                                                                                                                           |
| Edit the user's code                                                                 | The agent's own file tools                                   | A coding agent already reads, edits and runs commands in the repository; an MCP server cannot edit better                                                                                    |
| Check its work                                                                       | The CLI (`znight generate --check`, the tests)               | Deterministic, already exists, already used by humans and CI                                                                                                                                |
| Structured facts about the project (graph, routes, unused providers, NestJS inventory) | The CLI, JSON output                                         | Computed by the compiler; a CLI flag is cheaper to ship and to test than a server, and works for every agent with a shell                                                                   |
| The same facts without a shell (Claude Desktop, chat clients, some IDE agents)        | An MCP server over the CLI functions                          | The only case where MCP adds something. Migrations and feature work happen in a repository with a shell, so it is not the first need                                                         |

Skills are also the lowest-maintenance option: Markdown in the repository, reviewed in pull
requests, tested like the docs (§4.6), released with the packages. They are an open format read by
several agents, and `znight skills add` (§5.6) installs them for agents that do not read a plugin
marketplace.

## 3. Goals and non-goals

### 3.1 Goals

1. An agent given "migrate this NestJS service to Znight" or "add GraphQL / WebSockets / events /
   scheduled jobs / observability… to this app" produces code that compiles with no diagnostic and
   passes the tests, following the documented conventions, in a few iterations.
2. **Every feature package is covered**, not a hand-picked few, and a test fails when a package has
   no reference.
3. The skills never contradict the docs: they link to the docs pages and to the installed package's
   README, and their code samples are checked like the docs samples.
4. Everything an agent needs to call is a CLI command with a stable JSON output, usable by humans and
   CI as well.
5. Migrations are **incremental**: Znight next to the existing application, slice by slice, every
   step green. Real applications cannot stop for a big-bang rewrite.

### 3.2 Non-goals

- **An autonomous migration bot** or an LLM dependency in the CLI. The CLI is deterministic; the
  agent brings the model.
- **Codemods for everything.** Most of a migration needs judgment (where a module boundary was a
  real seam, what a `useFactory` really does). Only mechanical rewrites become codemods, later and
  on evidence (§8, M5).
- **Telemetry** of any kind in the CLI or the skills.
- **An MCP server in the first milestones** (§7).
- **The "expose MCP servers from a Znight application" feature** (an `@znight/mcp` runtime package).
  That is a different product question; this RFC keeps the `@znight/mcp` name free for it.

## 4. Skills

### 4.1 Catalogue

Skills are organised by **task**, not by package: an agent picks a skill from its name and
description, and the task is what the user asked for.

| Skill                   | Use when                                                                                                                       | Contents                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `znight`                | Writing or changing code in a Znight application                                                                               | The model in one page (build-time DI, markers, flat DI, scopes and the singleton rule, `Lazy<T>`, `implements` binding, `@Factory`/`@Provides`, externals and plugins, the generated module and why it is never edited or imported from a provider), the project layout, the **verify loop** (§4.3), reading a diagnostic, the scaffolders (`znight g`), testing with `TestBed`/`TestApp`, the pitfalls of `CLAUDE.md` that apply to applications |
| `znight-migrate-nestjs` | Migrating a NestJS application, module or library                                                                              | The strategy (§4.4), the mapping table (decorators, modules → flat DI, `forRoot`/`forRootAsync` → plugin options, providers `useValue`/`useFactory`/`useClass`/`useExisting`, string and symbol tokens → qualifiers or interfaces, `forwardRef` → `Lazy<T>`, request scope, guards and `Reflector` → route decisions, pipes → Standard Schema, filters → exception mappers, interceptors, `createParamDecorator`, `ConfigModule` → `@Config`, `@nestjs/cqrs` and event-emitter → `@znight/events`, microservices → `@znight/messaging`, `@nestjs/schedule`, GraphQL, WebSockets, Swagger → OpenAPI, `Test.createTestingModule` → `TestBed`/`TestApp`), each row linking the section of `docs/guide/migrating-from-nestjs.md` |
| `znight-migrate-di`     | Migrating from a hand-written composition root, a service locator, manual `new` wiring, or a runtime container (tsyringe, InversifyJS, TypeDI, awilix) | Recognising the patterns (composition root files, `getService(...)` / `container.get(...)` call sites, registries built by hand, factories, singletons by module state), the target constructs (constructor injection, `implements` binding, multi-injection for registries, `@Factory`/`@Provides` for third-party objects, `Lazy<T>` for cycles), the strategy (§4.4), and how to keep the old entry points working during the move |
| `znight-add-feature`    | Adding a capability to a Znight application                                                                                    | A common procedure (`znight add`, register the plugin, the compiler extension is discovered, route decisions, a first test, the verify loop) and **one reference file per package** (§4.2), loaded on demand                                                                                                                                                                                             |

The core skill is short (a few hundred lines at most) and every other skill starts with "load the
`znight` skill first". Feature skills are one skill with references rather than one skill per
package: the catalogue grows with every package, an agent's skill index should not, and a single
description listing the features ("GraphQL, WebSocket gateways, application events, messaging,
scheduled jobs, observability, OpenAPI, config, security, testing…") matches the requests as well
(Q2).

### 4.2 Feature references

`skills/znight-add-feature/references/<topic>.md`, one per feature package and per cross-cutting
topic. Each follows one template: what it is for, `znight add` line, plugin registration, the minimal
working example (copied from the package's tests or an example application), the decisions and
guards to add when the application has a required route decision group, the test to write, the
diagnostics this feature can raise with their usual fix, and links (guide, package page, the
installed README, the example).

| Reference           | Package / topic                                                                                                      | Source of the samples           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `http.md`           | `@znight/http`: adapters, controllers, validation, uploads, SSE, cookies, CORS, security headers                     | `examples/rest-api`             |
| `security.md`       | Route decisions, guards, JWT, API keys, sessions recipes (RFC 0001)                                                  | `examples/secure-api`           |
| `openapi.md`        | `@znight/openapi`                                                                                                    | `examples/storefront-api`       |
| `graphql.md`        | `@znight/graphql`: code-first, schema-first, loaders, subscriptions, Yoga driver                                     | `examples/graphql-api`          |
| `websocket.md`      | `@znight/websocket`: gateways, rooms, guards, transports                                                             | `examples/realtime-chat`        |
| `events.md`         | `@znight/events`: `@OnEvent`, inline and detached listeners, the messaging relay                                      | `packages/events/test`          |
| `messaging.md`      | `@znight/messaging`: consumers, retries, dead letters, one section per driver                                        | `examples/microservice`, `examples/worker` |
| `schedule.md`       | `@znight/schedule`: `@Cron`, `@Interval`, locks, the virtual clock                                                   | `examples/uptime-monitor`       |
| `config.md`         | `@znight/config`: `@Config` classes, `.env`, secret managers                                                         | `packages/config/test`          |
| `observability.md`  | `@znight/observability`: logger, `getLogger()`, metrics, tracing, `@Logged`/`@Traced`/`@Metric`, error reports      | `examples/microservice`         |
| `testing.md`        | `@znight/testing`: `TestBed`, `TestApp`, the per-package testing entries                                             | the examples' tests             |
| `aop.md`            | Method interceptors, the cache recipe                                                                                 | `docs/guide/aop.md`             |
| `custom-parameters.md` | `createParamDecorator` (RFC 0010)                                                                                  | `packages/core/test`            |
| `data-access.md`    | Drizzle through `@Factory`/`@Provides`                                                                                | `examples/rest-api`             |
| `libraries.md`      | Provider libraries and monorepos                                                                                     | `examples/monorepo`             |
| `deployment.md`     | `znight build`, `znight start`, containers, graceful shutdown                                                         | `docs/guide/deployment.md`      |

A new package is not done until it has its reference (`CLAUDE.md` "Before calling a change done"
gains this line, and the test of §4.6 enforces it).

### 4.3 The verify loop (the heart of every skill)

Every skill states the same loop, in this form:

1. Make one small change (a provider, a controller, a module's worth of classes).
2. Run `znight generate --check --format json` (or `znight generate` when the module must be
   written). Zero errors is the gate; warnings are read.
3. For each diagnostic, run `znight explain <code>` when the hint is not enough, fix, go back to 2.
4. Run the type checker and the tests that cover the change.
5. Only then go to the next change.

The skill explains what the agent must **not** do to silence the compiler: edit or import the
generated module, add `any` casts on injected parameters, turn a provider `transient` to escape
ZNIGHT003 instead of using `Lazy<T>`, mark a route `@Public()` to escape ZNIGHT023.

### 4.4 Migration strategy (both migration skills)

Learned from a real gap analysis (a ~2 000-file Fastify API with a hand-written composition root of
about 220 providers and about 1 000 service-locator calls): a migration that cannot stop the product
must be incremental. The skills prescribe:

1. **Inventory first** (`znight migrate nestjs --report`, or a manual inventory checklist for
   home-made DI): what maps mechanically, what needs a decision, what has no Znight equivalent yet.
   The agent writes the plan to a file the user reviews before any edit.
2. **DI before transport.** Make the services and repositories Znight providers first, keeping the
   existing HTTP layer: the old composition root or locator asks the Znight container for instances
   during the transition (`app.container.get(...)`), so call sites move one by one.
3. **Transport slice by slice.** Mount Znight routes on the existing server where the adapter allows
   it (`fastifyAdapter({ instance })`), one route file or module at a time, the behaviour pinned by
   the existing tests (status codes, error bodies).
4. **Delete the scaffolding** (the old root, the locator, the NestJS modules) last, when no call site
   is left.
5. Keep every step a mergeable pull request.

### 4.5 Distribution and versioning

- **Source**: `skills/<name>/SKILL.md` (+ `references/`) at the repository root, in English, valid
  against the Agent Skills specification (name rules, description length, layout).
- **Claude Code plugin**: the repository is also a plugin marketplace (`.claude-plugin/marketplace.json`
  listing one `znight` plugin whose skills are `skills/`), so users install with
  `/plugin marketplace add znight-org/znight`. The exact manifest layout is settled in M1 against the
  current plugin documentation.
- **Bundled in `@znight/cli`**: the build copies `skills/` into the package, so the skills of an
  installed CLI always match its release line. `znight skills add` (§5.6) writes them into a
  project for any agent.
- **Links to version-matched docs**: references point to `node_modules/@znight/<pkg>/README.md` (the
  installed version, always right) before the docs site (always the latest).
- Skills change with the packages: a pull request that changes a documented behaviour updates the
  skill, like it updates the README and the docs. Skills are released in lockstep through the CLI;
  a skills-only change needs a changeset on `@znight/cli` since users see it.

### 4.6 Tests

A `skills/test` suite, run by `bun run test`, reusing the docs checkers (`docs/test`):

- every `SKILL.md` has valid frontmatter (Agent Skills rules) and a description under the limit;
- every runtime `@znight/*` package (from the workspace list) has a feature reference, and every
  reference names an existing package;
- every `@znight/*` import in a code sample exists (the README and docs check), every relative link
  and docs link resolves, every `ZNIGHTxxx` named exists in `ErrorCode`, every CLI command and flag
  named exists in the CLI's command table;
- the TypeScript samples marked `ts check` compile against the sources (as the docs samples do).

### 4.7 Evaluating the skills

Tests prove the skills are consistent, not that they work. An **evaluation suite** run by hand (like
the benchmarks, not in CI) gives an agent a task on a fixture and scores the result with
deterministic checks:

| Fixture                                          | Task                                         | Pass when                                                     |
| ------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------- |
| a small NestJS API (modules, `forRootAsync`, a guard with `Reflector`, a `ValidationPipe`, a request-scoped provider, a `forwardRef`) | migrate it                                   | `znight generate --check` clean, typecheck clean, its e2e tests pass unchanged |
| a Fastify API with a composition root and a service locator | migrate the DI, keep the routes             | same, and no locator call left in migrated files              |
| `examples/rest-api` without GraphQL               | add a GraphQL API for books                  | same, plus a `TestApp` GraphQL test written by the agent passes |
| the same, per feature                            | add WebSocket gateways, events, scheduled jobs, observability, OpenAPI | same                                    |

Results (pass rate, iterations, diagnostics met) are recorded per release in
`benchmarks/agents/results.json` and drive what the skills say next. The harness may use the agents'
own evaluation tooling (for example `claude plugin eval`); the fixtures stay agent-neutral.

## 5. The CLI

All new outputs are deterministic, never colourised in JSON, with paths relative to the project
root, and versioned (`"version": 1`) like the generated metadata. The JSON shapes are specified in
§11 of the specification and in the CLI README.

### 5.1 `--format json` on `generate` and `build`

```sh
znight generate --check --format json
```

```json
{
  "version": 1,
  "ok": false,
  "stale": true,
  "diagnostics": [
    {
      "code": "ZNIGHT003",
      "severity": "error",
      "message": "Singleton 'ReportService' depends on request-scoped 'CurrentUser'",
      "location": { "file": "src/reports/report.service.ts", "line": 9, "column": 22, "endLine": 9, "endColumn": 33 },
      "hints": ["Inject Lazy<CurrentUser> and call .get() in the method, or make ReportService request-scoped"],
      "related": [],
      "docs": "https://znight-org.github.io/znight/reference/error-codes#znight003"
    }
  ],
  "stats": { "files": 42, "providers": 31, "durationMs": 180 }
}
```

It is `CompileResult.diagnostics` (spec §6.2) serialised, plus the docs link. The exit code does not
change. `--format text` stays the default.

### 5.2 `znight explain <code>`

Prints the section of `docs/reference/error-codes.md` for a code (title, meaning, phases, causes,
fixes), bundled into the CLI at build time so it works offline and matches the installed version.
`--format json` returns `{ code, title, phases, markdown }`. `znight explain` without argument lists
the codes.

### 5.3 `znight inspect`

Read-only views of the compiled application, from `CompileResult.graph` and the extensions'
metadata, with `--format text | json`:

| Subcommand                   | Shows                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `inspect providers`          | Every provider: token, scope, source location, dependencies, how each dependency was bound (`implements`, qualifier, factory)   |
| `inspect provider <name>`    | One provider, its dependents, and why it is or is not reachable from a root                                                     |
| `inspect routes`             | HTTP routes with their effective decisions, guards and plugin routes                                                            |
| `inspect graphql`, `websocket`, `consumers`, `jobs`, `events`, `config` | The entry points of each feature, with decisions and guards where they apply                         |
| `inspect unused`             | Unreachable providers (the ZNIGHT019 set) with the reason                                                                       |

Feature views come from the compiler extensions: an optional `inspect(result)` member of the
extension API (additive, `apiVersion: 1`) returns rows; packages that do not implement it simply have
no view. This keeps the CLI free of package knowledge.

### 5.4 `znight add <feature>`

The deterministic half of "add a feature", reusing the scaffolder of `znight new --features`:

```sh
znight add graphql --driver yoga
znight add messaging --driver rabbitmq
znight add observability --dry-run --format json
```

1. Installs the package, its required peers and the chosen integration with the project's package
   manager (detected as `znight new` does), with versions of the CLI's release line.
2. Registers the plugin in `src/main.ts` when the bootstrap has the generated shape
   (`createApplication({ plugins: [...] })`, RFC 0015): an AST edit with the compiler's parser and
   `magic-string`, formatting preserved. Any other shape: nothing is edited, the snippet is printed
   with the file and the place to put it.
3. Adds what the feature needs elsewhere (a config class, `.env.example` keys, a `bunfig.toml`
   preload line for tests) only when absent.
4. Prints the next steps (and the reference of the skill to read).

`--dry-run` prints the plan (files, packages, edits) without touching anything; with
`--format json` it is the agent's preview. Features: every package of `znight new --features`, plus
`events`, `security` (the decision group and guard skeleton of the Security guide) and `testing`.

### 5.5 `znight migrate nestjs --report`

A **read-only** inventory of a NestJS project, parsed with oxc (no NestJS code runs, no
`reflect-metadata` needed):

- modules and their imports/exports/providers graph, global modules, dynamic modules
  (`forRoot*`/`register*`) and their option sources;
- providers by kind (`@Injectable` class, `useClass`, `useValue`, `useFactory` with `inject`,
  `useExisting`), string and symbol tokens with their `@Inject` sites, `forwardRef` sites, scopes;
- HTTP: controllers, guards and the `Reflector` metadata they read, pipes, filters, interceptors,
  custom parameter decorators, versioning; microservices, GraphQL, WebSockets, schedule, CQRS and
  event-emitter, config, Swagger, the testing modules;
- for each finding: the Znight construct, the guide anchor, and a class (**mechanical**,
  **decision**: needs a human or agent choice, **gap**: no Znight equivalent, with the workaround).

Output: Markdown (default, the plan the user reviews) or `--format json` (the agent's input). It
writes nothing in the project unless `--output <file>` is given.

`znight migrate di --report` is harder to make useful, since home-made containers have no common
shape. The proposal is a **pattern-driven** report: the user (or the agent) gives the locator call
patterns and composition-root files (`--locator 'getService(*)' --root src/infrastructure/provider`),
the report counts call sites per class and per file, lists classes with constructor parameters that
would become providers, and flags module-level singletons. It is M4, after the NestJS report proves
the format.

### 5.6 `znight skills`

- `znight skills add [--agent claude|agents|<dir>]` copies the bundled skills into the project
  (`.claude/skills/` for Claude Code, `.agents/skills/` or a given directory for others), marked with
  the CLI version; `znight skills add --check` exits 1 when the copy is older than the installed CLI
  (for CI).
- `znight skills list` prints the skills and their descriptions.

### 5.7 `znight new` writes `AGENTS.md`

New projects get an `AGENTS.md` (and a one-line `CLAUDE.md` that points to it) with the commands
(`dev`, `test`, `generate --check`), the "never edit `src/.znight/`" rule, the verify loop, and the
line to install the skills. `--no-agents` skips it.

## 6. Documentation

- A guide page **"Coding agents"** (`docs/guide/coding-agents.md`, group "Getting started"): install
  the skills (plugin, `znight skills add`), the verify loop, the CLI commands of §5, prompts that work
  ("migrate the users module of this NestJS app with the znight-migrate-nestjs skill").
- The CLI reference and specification §11 gain the new commands and the JSON shapes.
- `docs/guide/migrating-from-nestjs.md` links the skill and `znight migrate nestjs --report`.
- The roadmap lists this RFC's milestones.

## 7. An MCP server, later: `@znight/mcp-server`

If clients without a shell need Znight's knowledge or project facts, an MCP server can expose the
same functions as the CLI, nothing more:

- tools `diagnostics`, `explain`, `inspect_*`, `migration_report`, `add_feature_plan` (dry run only:
  edits stay the agent's);
- the skills themselves, through the skills extension of the MCP SDK when the client supports it,
  and the docs pages as resources;
- stdio only (it runs next to the project), built on `@modelcontextprotocol/server` 2.x.

The name is `@znight/mcp-server` rather than `@znight/mcp`: it says "a server for developers' tools",
and leaves `@znight/mcp` for a possible runtime feature (exposing MCP servers from Znight
applications). It is built when there is a request from users of such clients, or when an agent we
care about can use MCP tools but not skills. Its cost is low then, since the functions exist.

## 8. Rollout

| Milestone | Content                                                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1**    | Skills: `znight`, `znight-migrate-nestjs`, `znight-add-feature` with every reference of §4.2; the skills test (§4.6); the plugin marketplace manifest; the "Coding agents" guide. Works with today's CLI (`znight generate --check` in text form)                 |
| **M2**    | CLI: `--format json` on `generate` and `build`, `znight explain`, `znight skills add/list`, skills bundled in `@znight/cli`, `AGENTS.md` in `znight new`. Skills switched to the JSON loop                                                                         |
| **M3**    | `znight inspect` (core views, then the extension `inspect` hook, implemented by http, graphql, websocket, messaging, schedule, events, config), `znight add`                                                                                                        |
| **M4**    | `znight migrate nestjs --report`, `znight-migrate-di` with `znight migrate di --report`; the evaluation fixtures and a first round of results                                                                                                                       |
| **M5**    | On evidence from M4's evaluations: codemods for the mechanical rows of the NestJS report (imports, `@Module` removal, `forwardRef` → `Lazy`), `@znight/mcp-server`                                                                                                  |

## 9. Alternatives considered

- **An MCP server first** (`@znight/mcp` or `@znight/mcp-server` with migration tools). Rejected as
  the first step (§2): it does not edit code, costs context on every conversation, needs a process,
  and its useful functions are CLI functions anyway. Kept as M5.
- **Only docs** (an `llms.txt`, a bigger migration guide). Docs hold the reference, not the
  procedure and the checkpoints; and a 500-line guide loaded whole costs more context than a skill
  that loads one reference. The docs stay the source of truth; skills link to them.
- **One skill per package.** Simpler to write, but the catalogue grows with every package and agents
  pick worse among many similar descriptions. Q2 keeps the option open.
- **A codemod-based migrator** (`znight migrate nestjs --write`). Rejected for v1: the hard parts are
  decisions, and a codemod that produces code which does not compile is worse than a report plus an
  agent with a verify loop.
- **Skills in a separate repository.** Rejected: they would drift from the packages, and the tests
  of §4.6 need the workspace.

## 10. Open questions (with the recommended answer)

1. **Where do skills live in the repository?** `skills/` at the root (recommended: visible, the
   standard layout) or `packages/cli/skills/` (closer to where they ship). Recommended: root, copied
   into the CLI at build.
2. **One `znight-add-feature` skill with references, or one skill per feature?** Recommended: one
   skill with references; split a feature out when the evaluations show the agent misses it.
3. **Are the evaluations worth their cost?** Recommended: yes, by hand per release, a handful of
   fixtures; without them the skills are untested opinions.
4. **`znight add` editing `main.ts`.** Recommended: only the generated bootstrap shape (RFC 0015),
   a printed snippet otherwise; never a regex edit.
5. **`znight skills add` target directories.** Recommended: `.claude/skills/` and `.agents/skills/`
   built in, any directory with `--dir`; revisit as agents converge on a location.
6. **Name of the later MCP server.** Recommended: `@znight/mcp-server` (§7).
7. **Error codes.** None: the CLI has its own errors (`CliError`, exit codes of §11); no build or
   runtime behaviour of an application changes.

## 11. Out of scope

An LLM inside the CLI, autonomous agents, telemetry, codemods before M5, the MCP runtime feature
(`@znight/mcp`), migrating from frameworks other than NestJS (Express or Fastify apps without DI are
covered by `znight-migrate-di` and `http.md`; others on request).
