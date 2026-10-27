# @znight/cli

The `znight` command line of [Znight](../../README.md): create a project, generate code, generate the
dependency injection container, run the development loop, build and start the application.

```sh
npx @znight/cli new my-service     # or: bunx @znight/cli new, pnpm dlx @znight/cli new
cd my-service
npm run dev
```

In a project, install it next to its peers (`znight new` does it for you):

```sh
npm install -D @znight/cli @znight/compiler vite
```

`vite`, `@znight/compiler` and `@znight/openapi` are (optional) peer dependencies: the CLI always
uses the versions installed in your project, and only loads them for the commands that need them
(`generate`, `dev`, `build`, `openapi`). Runs on Node.js >= 24 and Bun >= 1.3.

- [Commands](#commands)
- [`znight new`](#znight-new)
- [`znight generate`](#znight-generate)
- [`znight g`](#znight-g)
- [`znight dev`](#znight-dev)
- [`znight build`](#znight-build)
- [`znight start`](#znight-start)
- [`znight openapi`](#znight-openapi)
- [Global options, exit codes, environment](#global-options-exit-codes-environment)
- [Programmatic API](#programmatic-api)
- [Compiler contract](#compiler-contract)

## Commands

| Command                       | Description                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `znight new [name]`           | Create a project (interactive, or from flags)                                            |
| `znight generate`             | Write the generated container (`src/.znight/container.generated.ts`)                     |
| `znight generate --check`     | Exit with code 1 when the generated file is missing or out of date (CI)                  |
| `znight generate --watch`     | Keep the generated file up to date (for `tsc --watch` and editors)                       |
| `znight g <schematic> <name>` | Generate a service, controller, consumer, config, guard, interceptor, factory or job     |
| `znight dev`                  | Vite build in watch mode, full restart of the application after every rebuild            |
| `znight build`                | Production build (`vite build`); `--openapi` also writes `dist/openapi.json`             |
| `znight start`                | Run the production build                                                                 |
| `znight openapi`              | Write the OpenAPI document (`openapi.json`); `--check` exits with code 1 when stale (CI) |

`znight <command> --help` prints the options of a command; `znight help <command>` too.

## `znight new`

```sh
znight new my-service                       # asks the questions below
znight new my-service --yes                 # defaults, no question
znight new my-service --pm pnpm --adapter fastify --features config,observability,messaging
znight new my-worker --yes --features config,schedule,openapi
znight new . --yes --no-install             # in the current (empty) directory
```

In a terminal, the CLI asks for the name, the package manager, the HTTP adapter, the features,
and whether to install the dependencies and initialise git. Flags answer the questions up front; with
`--yes` (or without a terminal, e.g. in CI) the defaults are used.

| Option                                     | Default                                       | Description                                                                      |
| ------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `[name]`                                   | (asked)                                       | npm package name (`my-service`, `@acme/api`), or `.`                             |
| `-y, --yes`                                | `false`                                       | Do not ask questions                                                             |
| `--pm <bun\|npm\|pnpm\|yarn>`              | the one running the CLI, else bun on Bun, npm | Package manager                                                                  |
| `--adapter <node\|fastify\|express\|hono>` | `node`                                        | HTTP adapter (`node`: the built-in `node:http` server)                           |
| `--features <list>`                        | `config,observability`                        | `config`, `observability`, `messaging`, `schedule`, `openapi`, or `all` / `none` |
| `--no-install`                             | install                                       | Do not install the dependencies                                                  |
| `--no-git`                                 | init                                          | Do not run `git init` (skipped anyway inside a git repository)                   |
| `--dir <path>`                             | `./<name>` (unscoped)                         | Target directory                                                                 |
| `--force`                                  | `false`                                       | Write into a non-empty directory (existing files are overwritten)                |

The package manager defaults to the one that launched the CLI (`npx`, `pnpm dlx`, `yarn dlx`,
`bunx`). The target directory must be empty (`.git`, `.DS_Store` and editor folders are fine).

### The generated project

```txt
my-service/
├─ src/
│  ├─ main.ts                    # Application.create() with the plugins, then start()
│  ├─ api.ts                     # @OpenApiDocument: title, tags of openapi.json   (openapi)
│  └─ app/
│     ├─ app.config.ts           # @Config('app'): PORT, APP_GREETING           (config)
│     ├─ greeting.schemas.ts     # Zod schema of the request body
│     ├─ greeting.service.ts     # @Injectable, uses AppConfig and Logger
│     ├─ greeting.controller.ts  # GET /greetings/:name?excited, POST /greetings (validated body)
│     ├─ greeting.consumer.ts    # @Consumer('greetings'), POST /greetings/async  (messaging)
│     ├─ health.controller.ts    # GET /health
│     └─ heartbeat.jobs.ts       # @Cron('* * * * *'): a job every minute          (schedule)
├─ test/
│  ├─ greeting.service.test.ts     # TestBed: real factory, auto-mocked dependencies
│  ├─ greeting.controller.test.ts  # TestApp: in-memory HTTP requests
│  └─ heartbeat.jobs.test.ts       # TestApp + createTestClock(): virtual time      (schedule)
├─ vite.config.ts                # plugins: [znight(options)]
├─ znight.config.ts              # compiler options, shared by znight(), the Bun preload and znight generate
├─ tsconfig.json                 # strict, experimentalDecorators, moduleResolution bundler, noEmit
├─ bunfig.toml                   # bun only: preloads @znight/compiler/bun before the tests
├─ package.json                  # type module; scripts dev, build, start, generate, typecheck, test
└─ .gitignore                    # node_modules, dist, .znight
```

- `@znight/*` packages are pinned to `^<version of the CLI>` (they are released together).
- Tests run with `bun test` for Bun projects (the preload regenerates the container), with Vitest
  otherwise (the `znight()` plugin of `vite.config.ts` regenerates it). Both, like
  `znight generate`, read the compiler options of `znight.config.ts`.
- `typecheck` runs `znight generate && tsc --noEmit`: the generated container is git-ignored.
- The adapter's peer dependencies are added (`fastify`; `express` + `@types/express`; `hono` +
  `@hono/node-server`), plus `light-my-request` (dev) for `TestApp.inject()` with the `node` and
  `express` adapters. Yarn projects get a `.yarnrc.yml` with `nodeLinker: node-modules`.
- Bun projects run the application on Bun: their `dev` and `start` scripts pass `--runtime bun`
  (`bun run` runs the `znight` binary, which has a `node` shebang, on Node.js).
- `schedule` adds `@znight/schedule`, `SchedulePlugin.configure()` **before** `HttpPlugin` (plugins
  stop in reverse order: HTTP stops taking requests first, then running jobs drain), a sample job
  and its test on a virtual clock (`createTestClock()` of `@znight/schedule/testing`).
- `openapi` adds `@znight/openapi`, `OpenApiPlugin.configure()` after `HttpPlugin` (`/openapi.json`
  and the API reference at `/docs`), `src/api.ts` (`@OpenApiDocument`) and the `openapi` /
  `openapi:check` scripts (commit `openapi.json`, check it in CI).
- The `TestApp` test configures `ObservabilityPlugin` with `metrics: { server: false }`: with
  `prom-client` installed, the metrics server (`:9464`) would collide with `znight dev` or with other
  test files running in parallel.

## `znight generate`

Runs the compiler and writes `src/.znight/container.generated.ts` when its content changed. Compiler
diagnostics are printed with code frames; any error exits with code 1 (and nothing is written).

```sh
znight generate            # ✓ Generated src/.znight/container.generated.ts (12 providers, 30 files, 48ms)
znight generate --check    # CI: exit 1 when the file is missing or out of date (never writes)
znight generate --watch    # regenerate on every change (incremental: only changed files are re-parsed)
```

| Option                                     | Description                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `--check`                                  | Do not write; exit 1 when the generated files are missing or stale (each one is named)    |
| `-w, --watch`                              | Regenerate on changes of the sources and of the files the compiler read (see below)       |
| `--root <dir>`                             | Project root (default: the current directory)                                             |
| `--config <file>`                          | Vite config to read the `znight()` options from, instead of `znight.config.*` (see below) |
| `--config-loader <bundle\|runner\|native>` | How Vite loads the config file                                                            |

The compiler options are looked up in this order, so that `znight generate`, `vite build` and the
Bun preload produce the same file:

1. `znight.config.ts` (or `.mts`, `.js`, `.mjs`) in the project root, or the file named by the
   `ZNIGHT_CONFIG` environment variable — the file the [Bun preload](../compiler/README.md#preload-options)
   reads (`loadZnightConfig()` of the compiler; its preload-only `logLevel` is ignored). Vite is not
   loaded;
2. otherwise the options `znight()` compiles with in your Vite config: Vite resolves the config as
   for `znight build`, and the CLI takes the options given to the plugin with what the plugin derives
   from the config — the Vite `root` (the config's `root` is relative to the project root), the string
   entries of `resolve.alias` and the runtime conditions (see [Compiler contract](#compiler-contract));
   `--config <file>` skips step 1 and reads that Vite config;
3. otherwise the defaults (without a Vite config, Vite is not even loaded).

Share one options object between the Vite plugin and the preload with a `znight.config.ts`:

```ts
// znight.config.ts
import type { ZnightOptions } from '@znight/compiler'

export default { reportUnused: true } satisfies ZnightOptions
```

```ts
// vite.config.ts
import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'
import options from './znight.config.ts'

export default defineConfig({ plugins: [znight(options)] })
```

`znight generate` compiles in `serve` mode (provider source locations kept) while `vite build` writes
the disk copy without them: run `znight generate --check` before `znight build`, as below.

In CI:

```sh
npx znight generate --check   # or: npx znight generate, before tsc and the tests
npx tsc --noEmit
npx znight build
```

`--check` names every generated file that is missing or out of date: the module and, in library
mode (`library: true`), `dist/znight.providers.json`. A build that cleans `dist/` (tsdown, `tsc --build
--clean`...) deletes that manifest, which `package.json` points to: run `znight generate` after such a
build (the Vite plugin writes it itself at the end of `vite build`).

`--watch` watches what the Vite plugin and the Bun preload watch: the `include` directories of the
project and of its source libraries (recursively), the project root (`package.json`, `tsconfig.json`,
lockfiles) and the directories of the files the last compile read (library manifests, compiled
libraries), refreshed after each compile. Only changes that can change the result trigger a compile,
by the rules of the Vite plugin (`isRelevantChange()` of the compiler: sources the compiler parses,
`.js` included; resolution config files; files it read; a file created where a relative import did
not resolve); a directory created, deleted or moved under an `include` directory triggers a rescan,
since `fs.watch` reports it alone, without its files.

## `znight g`

```sh
znight g service users/user            # src/users/user.service.ts         UserService
znight g controller order              # src/order/order.controller.ts     OrderController
znight g consumer orders --path src/messaging
znight g guard auth --flat             # src/auth.guard.ts                 AuthGuard
znight g interceptor timing --aop      # a method interceptor (@Intercept)
znight g config payment-gateway        # @Config('paymentGateway'): PAYMENT_GATEWAY_* variables
znight g job reports/digest            # src/reports/digest.jobs.ts       DigestJobs
```

| Schematic (alias)     | Generates                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `service` (`s`)       | an `@Injectable()` class                                                                                          |
| `controller` (`co`)   | an `@Controller('/<name>')` with `GET /` and `GET /:id`                                                           |
| `consumer` (`cs`)     | an `@Consumer('<name>')` with a retried `@OnMessage()` handler (a Zod message schema when the project uses `zod`) |
| `config` (`cf`)       | a `@Config('<name>')` class                                                                                       |
| `guard` (`gu`)        | an `@Injectable()` `CanActivate` guard (with a commented `static enforces` line for route decisions)              |
| `interceptor` (`itc`) | an `@Injectable()` `HttpInterceptor` (`--aop`: a `MethodInterceptor` for `@Intercept`)                            |
| `factory` (`f`)       | a `@Factory()` with a `@Provides()` method                                                                        |
| `job` (`j`)           | a class of scheduled jobs (`<Name>Jobs`, `<name>.jobs.ts`) with a `@Cron` method (`@znight/schedule`)             |

Names are converted: files are `kebab-case.<schematic>.ts`, classes `PascalCase<Schematic>`
(`UserProfile`, `user_profile` and `user-profile.service` all give `user-profile.service.ts` /
`UserProfileService`). Directories before the last `/` are relative to `src/`; without them the file
goes to `src/<name>/`. Nothing has to be registered afterwards: the compiler discovers the class.

Job names must be unique in the application (ZNIGHT041), so the `@Cron` of `job` is named after the
location of the file: its directories relative to `src/` (to the project root for a `--path` outside
`src/`), then the name, without the directory named after it. `znight g job digest` gives
`digest.daily`, `znight g job reports/digest` gives `reports.digest.daily` and
`znight g job digest --path src/emails` gives `emails.digest.daily`.

| Option          | Description                                                |
| --------------- | ---------------------------------------------------------- |
| `--path <dir>`  | Directory of the file, relative to the current directory   |
| `--flat`        | Do not create a directory named after the element          |
| `-f, --force`   | Overwrite an existing file (refused otherwise)             |
| `-d, --dry-run` | Print the file instead of writing it                       |
| `--aop`         | `interceptor`: a method interceptor instead of an HTTP one |
| `--root <dir>`  | Project root (default: the nearest `package.json`)         |

`znight generate <schematic> <name>` and `znight generate:<schematic> <name>` are aliases.

## `znight dev`

```sh
znight dev
znight dev --runtime bun --clear
znight dev --inspect -- --verbose      # arguments after -- go to the application
```

`znight dev` runs `vite build --watch` with your Vite config (no Vite dev server) and **restarts the
whole process** after every successful build. There is no partial hot replacement of providers: a
restart is fast and always consistent.

1. A build succeeds → after `--debounce` ms, the running process receives `SIGTERM` (the application
   stops gracefully), gets `--kill-timeout` ms to exit (then `SIGKILL`), and the new build starts.
   Bursts of builds cause a single restart; restarts never overlap.
2. A build fails → Vite prints the error and **the last good process keeps running**.
3. The compilation fails (`ZNIGHT` errors) → the `znight()` plugin prints the diagnostics; in watch
   mode it does not fail the build (the bundle contains a module throwing them), so the CLI reads the
   plugin's result (`plugin.api.result`) and does **not** restart: the last good process keeps
   running (a restart still pending for a previous build is cancelled), and nothing starts until a
   build compiles. With `--log-level silent` the CLI prints the diagnostics itself.
4. The application crashes or exits → the CLI says so and waits for the next change.
5. `Ctrl+C` (or `SIGTERM`, `SIGHUP` when the terminal is closed, `Ctrl+\` / `SIGQUIT`) → the
   watcher closes and the application stops gracefully (`SIGINT` after `Ctrl+C`, `SIGTERM` otherwise);
   a second signal kills it. The application runs in its own session and process group, so it
   receives exactly one signal, and never the terminal's.
6. The CLI dies without stopping it (`kill -9`, the OOM killer) → the application stops by itself
   (`SIGTERM`, then `SIGKILL` after `--kill-timeout`) within half a second instead of keeping its
   port: the CLI preloads a small guard into it (`--import` on Node.js, `--preload` on Bun) that
   watches the CLI process. It needs nothing from the application, and the processes the
   application starts itself are left alone.

Diagnostics of the compiler are printed on every rebuild by the `znight()` plugin.

```txt
✗ ZNIGHT001: Missing provider for 'Clock' required by GreetingService
  --> src/app/greeting.service.ts:12:30
✗ Compilation failed with 1 error. The last good build keeps running. Waiting for changes...
```

| Option                                     | Default           | Description                                                         |
| ------------------------------------------ | ----------------- | ------------------------------------------------------------------- |
| `--root <dir>`                             | current directory | Project root                                                        |
| `--config <file>`                          | `vite.config.*`   | Vite config file                                                    |
| `--config-loader <bundle\|runner\|native>` | Vite's            | How Vite loads the config file                                      |
| `--mode <mode>`                            | `development`     | Vite mode                                                           |
| `--runtime <auto\|node\|bun>`              | `auto`            | Runtime of the application (`auto`: the one running the CLI, below) |
| `--entry <file>`                           | entry chunk       | File to run (default: the entry chunk of the build, `dist/main.js`) |
| `--inspect`                                | `false`           | Start the application with `--inspect`                              |
| `--clear`                                  | `false`           | Clear the screen before each rebuild                                |
| `--debounce <ms>`                          | `100`             | Delay between a build and the restart                               |
| `--kill-timeout <ms>`                      | `5000`            | Time to stop after `SIGTERM` before `SIGKILL`                       |
| `--log-level <info\|warn\|error\|silent>`  | `warn`            | Vite log level                                                      |

The application runs with `NODE_ENV=development` (unless set when the CLI starts: the `NODE_ENV`
that Vite sets in the CLI process for its build is not passed on) and, on Node.js, with
`--enable-source-maps`, so stack traces point to your TypeScript files.

`--runtime auto` is the runtime running the CLI. Under `bun run` (or `bunx`) that is Node.js: the
`znight` binary has a `node` shebang, which Bun honours. Pass `--runtime bun` (as the `dev` and
`start` scripts of Bun projects created by `znight new` do), or run `bun --bun run dev`.

## `znight build`

```sh
znight build                    # ✓ Built dist/main.js 48.20 kB in 1.24s
znight build --mode staging
znight build --openapi          # also dist/openapi.json (--openapi=<path> for another file)
znight build --openapi --openapi-prefix /api   # HttpPlugin.configure({ prefix: '/api' })
```

Runs `vite build` with your Vite config. With the defaults of the `znight()` plugin, `src/main.ts`
is built to `dist/main.js` (Node.js 24 target, source maps). Any compiler error fails the build
(exit code 1). The `root` of the Vite config is honoured, relative to the project root (`--root`),
like the Vite CLI run in the project directory; `znight dev` and `znight generate` resolve it the
same way.

| Option                                     | Default           | Description                    |
| ------------------------------------------ | ----------------- | ------------------------------ |
| `--root <dir>`                             | current directory | Project root                   |
| `--config <file>`                          | `vite.config.*`   | Vite config file               |
| `--config-loader <bundle\|runner\|native>` | Vite's            | How Vite loads the config file |
| `--mode <mode>`                            | `production`      | Vite mode                      |
| `--log-level <info\|warn\|error\|silent>`  | `info`            | Vite log level                 |
| `--openapi[=<path>]`                       | off               | Also emit the OpenAPI document |
| `--openapi-prefix <path>`                  | none              | With `--openapi`: HTTP prefix  |

`--openapi` adds the `openapi()` Vite plugin of `@znight/openapi` to the build when the Vite config
does not register one: after the bundle is written, the document is emitted to `dist/openapi.json`
(next to `dist/main.js`, ready for `OpenApiPlugin.configure({ document: { file } })`), or to the
given path.

When `HttpPlugin` has a `prefix`, pass it with `--openapi-prefix` (like `znight openapi --prefix`):
it becomes the `servers` of the document (`[{ "url": "/api" }]`) unless `@OpenApiDocument` declares
servers, so the file is the document the application serves in `'build'` mode. Without it, the
document has no `servers`, and the API reference ("Test request", "Try it out") and generated
clients call `/greetings` instead of `/api/greetings`. When the Vite config registers its own
`openapi()`, that plugin emits the document with its options: `--openapi=<path>` and
`--openapi-prefix` are then ignored, with a warning (set `output` and `prefix` on that `openapi()`).

## `znight start`

```sh
znight start                               # node --enable-source-maps dist/main.js
znight start --runtime bun
znight start --entry dist/worker.js -- --verbose
```

Runs the production build with `NODE_ENV=production` (unless set). On Linux and macOS the CLI
**replaces itself** with the runtime (`execve`): same PID, signals and exit code go straight to the
application, which makes `znight start` a good container entry point. Elsewhere the application runs
as a child process: `SIGINT`, `SIGTERM` and `SIGHUP` are forwarded and its exit code is returned
(`128 + n` when it is killed by a signal).

| Option                        | Default                         | Description                                     |
| ----------------------------- | ------------------------------- | ----------------------------------------------- |
| `--root <dir>`                | current directory               | Project root (the working directory of the app) |
| `--entry <file>`              | `dist/main.js`, `dist/main.mjs` | File to run                                     |
| `--runtime <auto\|node\|bun>` | `auto`                          | Runtime (`auto`: the one running the CLI\*)     |

\* Node.js under `bun run`, see [`znight dev`](#znight-dev).

## `znight openapi`

```sh
znight openapi                      # writes openapi.json at the project root
znight openapi -o docs/openapi.yaml # YAML, chosen by the extension (needs yaml)
znight openapi --check              # CI: exit 1 when the file is missing or stale; never writes
znight openapi --prefix /api        # servers default when @OpenApiDocument declares none
znight openapi --runtime bun        # load the modules with Bun (default: the runtime running the CLI)
```

Writes the OpenAPI document of the application with `@znight/openapi` (which must be installed in
the project). The application is compiled like `znight generate` does (compile errors are printed
and exit with code 1 before any module runs), then its generated module is loaded in a child
process (Bun: the compiler preload; Node.js: a Vite server in middleware mode), so module side
effects never reach the CLI. Nothing is instantiated. Outputs are only written when they change;
the file is byte-identical on Node.js and Bun. Commit it and run `znight openapi --check` in CI: an
API change shows up in the pull request.

| Option                                     | Default           | Description                                                        |
| ------------------------------------------ | ----------------- | ------------------------------------------------------------------ |
| `-o, --output <file>`                      | `openapi.json`    | Output file, repeatable (`.yaml` / `.yml` write YAML)              |
| `--check`                                  | `false`           | Do not write: exit with code 1 when an output is missing or stale  |
| `--prefix <path>`                          | none              | HTTP prefix: the `servers` default (`[{ url: prefix }]`)           |
| `--runtime <auto\|node\|bun>`              | `auto`            | Runtime loading the application modules                            |
| `--converters <file>`                      | none              | Module whose default export is a `SchemaConverter[]`               |
| `--root <dir>`                             | current directory | Project root                                                       |
| `--config <file>`                          | `vite.config.*`   | Vite config file (compiler options and the Node.js module loading) |
| `--config-loader <bundle\|runner\|native>` | Vite's            | How Vite loads the config file                                     |

## Global options, exit codes, environment

| Option                  | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `-h, --help`            | Help (`znight --help`, `znight <command> --help`) |
| `-v, --version`         | Version                                           |
| `--color`, `--no-color` | Force or disable colors                           |
| `--debug`               | Print the stack trace of unexpected errors        |

| Exit code | Meaning                                                                                     |
| --------- | ------------------------------------------------------------------------------------------- |
| `0`       | Success                                                                                     |
| `1`       | Failure: compiler errors, failed build, stale generated file, missing build, file exists... |
| `2`       | Invalid usage: unknown command or option (with a suggestion), missing or invalid argument   |
| `130`     | Cancelled (prompt cancelled, second `Ctrl+C` in `znight dev`)                               |
| other     | `znight start`: the exit code of the application                                            |

| Variable                | Effect                                                |
| ----------------------- | ----------------------------------------------------- |
| `NO_COLOR`              | Disables colors (any non-empty value)                 |
| `FORCE_COLOR`           | Forces colors (`0` / `false` disable them)            |
| `ZNIGHT_DEBUG=1`        | Same as `--debug`                                     |
| `CI`                    | No prompts (`znight new` uses the flags and defaults) |
| `npm_config_user_agent` | Default package manager of `znight new`               |

## Programmatic API

```ts
import { main, planSchematic, renderProject, SCHEMATICS } from '@znight/cli'

const code = await main(['generate', '--check'], { cwd: '/path/to/app' }) // exit code, never throws

const files = renderProject({
  name: 'my-service',
  packageManager: 'bun',
  adapter: 'fastify',
  features: ['config', 'observability'],
  znightVersion: '0.1.0',
}) // [{ path, content }]
```

`main(argv, options)` accepts overrides for everything it touches (`cwd`, `env`, `stdout`, `stderr`,
`interactive`, `signals`, and `services`: `loadCompiler`, `loadVite`, `loadPrompts`, `processes`,
`watch`), which is how the CLI itself is tested. `AppSupervisor` (the restart logic of `znight dev`)
and the schematics are exported too.

## Compiler contract

The CLI drives the project's `@znight/compiler` through its programmatic API (spec §6.2) and only
relies on these shapes (each is optional; missing pieces are emulated):

| Export                                                           | Used for                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `generate(options)`                                              | `znight generate`; `written: string[]` tells whether the file changed                                           |
| `generate({ ...options, check })`                                | `znight generate --check`; `stale: boolean`, `staleFiles: string[]` (else compared with `diskCode` / `library`) |
| `createCompiler(options)`                                        | `znight generate --watch`: `generate(changes)` (`{ changed, added, removed }`), `isOutFile(file)`, `watchFiles` |
| `includeRoots(compiler)`                                         | `--watch`: the directories to watch recursively (else the whole project)                                        |
| `isRelevantChange(compiler, kind, file, watched, roots)`         | `--watch`: the file events that trigger a compile (else every event but the generated module)                   |
| `compile(options)`                                               | fallback of the above (writes `diskCode`, else `code`)                                                          |
| `formatDiagnostics(diagnostics, { color, cwd, summary: false })` | diagnostics output (a plain formatter otherwise)                                                                |
| `loadZnightConfig(root)`                                         | `znight generate`: `{ file, options }` of `znight.config.*` / `ZNIGHT_CONFIG`                                   |

`znight build` and `znight dev` use the `znight()` Vite plugin of the project's Vite config, found by
its name (`znight`) among the plugins of the config:

- `znight generate` reads `plugin.api.options` (or `plugin.api.getOptions()`) when the project has
  no `znight.config.*`, with the `root`, `aliases` and `runtimeConditions` of the plugin's compiler
  (`plugin.api.compiler.options`, created when Vite resolves the config; without it, the Vite root
  and the string aliases of `resolve.alias`);
- `znight dev` reads `plugin.api.result` (`{ ok, diagnostics }`) once a build is written, to keep the
  last good process running when the compilation failed.

## License

MIT
