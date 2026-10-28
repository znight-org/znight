---
description: "@znight/cli - the znight command: scaffold projects, generate the container and code, run the development loop, build and start."
---

# @znight/cli <Badge type="tip" text="available" />

The `znight` command line: project scaffolding, code generators, container generation and the
development loop. Runs on Node.js 24+ and Bun 1.3+.

```sh
npm install -D @znight/cli @znight/compiler vite
```

`vite` and `@znight/compiler` are optional peer dependencies: the CLI drives the versions installed
in your project and only loads them for the commands that need them (`generate`, `dev`, `build`), so
`npx @znight/cli new` installs neither.

## Commands

| Command                       | Description                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `znight new [name]`           | Create a project (interactive, or from flags)                                                                |
| `znight generate`             | Write the generated container (`src/.znight/container.generated.ts`)                                         |
| `znight generate --check`     | Exit with code 1 when a generated file is missing or stale, naming each one (CI)                             |
| `znight generate --watch`     | Keep the generated file up to date (for `tsc --watch` and editors)                                           |
| `znight g <schematic> <name>` | Generate a `service`, `controller`, `consumer`, `config`, `guard`, `interceptor`, `factory` or `job`         |
| `znight dev`                  | Vite build in watch mode; restarts the process after every successful rebuild                                |
| `znight build`                | Production build (`vite build`, `src/main.ts` → `dist/main.js`); `--openapi` also writes `dist/openapi.json` |
| `znight start`                | Run the production build (`--runtime node` or `bun`)                                                         |
| `znight openapi`              | Write the OpenAPI document (`openapi.json`); `--check` exits with code 1 when it is stale (CI)               |

`znight <command> --help` prints the options of a command. Exit codes: `0` success, `1` failure,
`2` invalid usage, `130` cancelled.

## Create a project

```sh
npx @znight/cli new my-service                 # asks the questions
npx @znight/cli new my-service --yes           # defaults: node adapter, config + observability
npx @znight/cli new my-service --pm bun --adapter fastify --features all
```

The CLI asks for the name, the package manager (`bun`, `npm`, `pnpm`, `yarn`), the HTTP adapter
(`node`, `fastify`, `express`, `hono`), the features (`config`, `observability`, `messaging`,
`schedule`, `openapi`) and whether to install the dependencies and initialise git. The project has a sample greeting API, its
tests (`bun test` for Bun projects, Vitest otherwise), `vite.config.ts` with the `znight()` plugin
and a `znight.config.ts` holding the compiler options, shared by the Vite plugin, the Bun preload
and `znight generate`. Bun projects run the application on Bun: their `dev` and `start` scripts pass
`--runtime bun` (under `bun run`, the `znight` binary and its `node` shebang run on Node.js).

## Generate code

```sh
npx znight g service users/user
# creates src/users/user.service.ts (UserService)

npx znight g controller users/user
# creates src/users/user.controller.ts (UserController)

npx znight g interceptor timing --aop --dry-run
# prints a method interceptor (@Intercept) instead of writing it

npx znight g job reports/digest
# creates src/reports/digest.jobs.ts (DigestJobs), its @Cron job named 'reports.digest.daily'
```

Generated files are plain TypeScript with the right decorators: there is nothing to register
afterwards, the compiler discovers them. Options: `--path`, `--flat`, `--force`, `--dry-run`. Job
names must be unique in the application
([`ZNIGHT041`](/reference/error-codes#znight041)), so the job of `g job` is named after the
directories of its file under `src/` and its name: `g job digest` gives `digest.daily`,
`g job digest --path src/emails` gives `emails.digest.daily`.

## Generate the container

```sh
npx znight generate            # ✓ Generated src/.znight/container.generated.ts (12 providers, 30 files, 48ms)
npx znight generate --check    # CI: exit 1 when the file is missing or out of date (never writes)
npx znight generate --watch    # incremental: only changed files are re-parsed
```

The compiler options come from `znight.config.ts` when the project has one (or the file named by
`ZNIGHT_CONFIG`), otherwise from the `znight()` plugin of your Vite config (`--config <file>` to read
a specific one): Vite resolves it like for `znight build`, so the plugin options come with the Vite
`root`, the string aliases and the runtime conditions it compiles with. Otherwise, the defaults.

`--check` names every missing or stale file: the module and, in library mode,
`dist/znight.providers.json` (a build cleaning `dist/` deletes it: run `znight generate` after such a
build). `--watch` watches what the Vite plugin and the Bun preload watch: the `include` directories
of the project and of its source libraries, the project root and the files the compiler read;
directories created, deleted or moved under an `include` directory trigger a rescan.

## Development loop

```sh
npx znight dev
npx znight dev --runtime bun --inspect -- --verbose   # arguments after -- go to the application
```

`znight dev` runs `vite build --watch` and **restarts the whole process** after each successful
build (`SIGTERM`, then `SIGKILL` after `--kill-timeout`). There is no partial hot replacement of
providers: a restart is fast and always consistent.

- A failed build keeps the last good process running.
- A failed **compilation** (`ZNIGHT` errors) too: the `znight()` plugin prints the diagnostics and the
  CLI does not restart into an application that would only throw them, until the code compiles
  again.
- `Ctrl+C`, `SIGTERM`, `SIGHUP` (the terminal is closed) and `SIGQUIT` stop the application
  gracefully; a second signal kills it. The application runs in its own process group: it receives
  exactly one signal.
- The application runs with `NODE_ENV=development` unless you set it (Vite's build sets `NODE_ENV`
  in the CLI process; the application never sees that value).

## Build and start

```sh
npx znight build                 # vite build with your Vite config; compiler errors fail the build
npx znight build --openapi --openapi-prefix /api # also dist/openapi.json, servers: [{ url: '/api' }]
npx znight start                 # node --enable-source-maps dist/main.js, NODE_ENV=production
npx znight start --runtime bun
```

`--openapi` emits the OpenAPI document after the bundle (`@znight/openapi` installed); pass the
`prefix` of `HttpPlugin` with `--openapi-prefix` so that the file has the `servers` of the
document the application serves. `znight openapi` writes it on its own (`--prefix`, `--check`):
see [@znight/openapi](/packages/openapi#emitting-openapi-json).

The `root` of your Vite config is resolved against the project root (`--root`), like the Vite CLI
run in the project directory; `znight dev` and `znight generate` do the same.

On Linux and macOS, `znight start` replaces itself with the runtime (same PID, signals and exit
code): a good container entry point.

## In CI

```sh
npx znight generate --check   # the generated container is up to date
npx tsc --noEmit
npx znight build
```

Every flag is documented in the
[package README](https://github.com/znight-org/znight/tree/main/packages/cli#readme).
