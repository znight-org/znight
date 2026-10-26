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

`vite` and `@znight/compiler` are (optional) peer dependencies: the CLI always uses the versions
installed in your project, and only loads them for the commands that need them (`generate`, `dev`,
`build`). Runs on Node.js >= 24 and Bun >= 1.3.

- [Commands](#commands)
- [`znight new`](#znight-new)
- [`znight generate`](#znight-generate)
- [`znight g`](#znight-g)
- [`znight dev`](#znight-dev)
- [`znight build`](#znight-build)
- [`znight start`](#znight-start)
- [Global options, exit codes, environment](#global-options-exit-codes-environment)
- [Programmatic API](#programmatic-api)
- [Compiler contract](#compiler-contract)

## Commands

| Command                       | Description                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `znight new [name]`           | Create a project (interactive, or from flags)                                   |
| `znight generate`             | Write the generated container (`src/.znight/container.generated.ts`)            |
| `znight generate --check`     | Exit with code 1 when the generated file is missing or out of date (CI)         |
| `znight generate --watch`     | Keep the generated file up to date (for `tsc --watch` and editors)              |
| `znight g <schematic> <name>` | Generate a service, controller, consumer, config, guard, interceptor or factory |
| `znight dev`                  | Vite build in watch mode, full restart of the application after every rebuild   |
| `znight build`                | Production build (`vite build`)                                                 |
| `znight start`                | Run the production build                                                        |

`znight <command> --help` prints the options of a command; `znight help <command>` too.

## `znight new`

```sh
znight new my-service                       # asks the questions below
znight new my-service --yes                 # defaults, no question
znight new my-service --pm pnpm --adapter fastify --features config,observability,messaging
znight new . --yes --no-install             # in the current (empty) directory
```

In a terminal, the CLI asks for the name, the package manager, the HTTP adapter, the features,
and whether to install the dependencies and initialise git. Flags answer the questions up front; with
`--yes` (or without a terminal, e.g. in CI) the defaults are used.

| Option                                     | Default                                       | Description                                                       |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| `[name]`                                   | (asked)                                       | npm package name (`my-service`, `@acme/api`), or `.`              |
| `-y, --yes`                                | `false`                                       | Do not ask questions                                              |
| `--pm <bun\|npm\|pnpm\|yarn>`              | the one running the CLI, else bun on Bun, npm | Package manager                                                   |
| `--adapter <node\|fastify\|express\|hono>` | `node`                                        | HTTP adapter (`node`: the built-in `node:http` server)            |
| `--features <list>`                        | `config,observability`                        | `config`, `observability`, `messaging`, or `all` / `none`         |
| `--no-install`                             | install                                       | Do not install the dependencies                                   |
| `--no-git`                                 | init                                          | Do not run `git init` (skipped anyway inside a git repository)    |
| `--dir <path>`                             | `./<name>` (unscoped)                         | Target directory                                                  |
| `--force`                                  | `false`                                       | Write into a non-empty directory (existing files are overwritten) |

The package manager defaults to the one that launched the CLI (`npx`, `pnpm dlx`, `yarn dlx`,
`bunx`). The target directory must be empty (`.git`, `.DS_Store` and editor folders are fine).

### The generated project

```txt
my-service/
├─ src/
│  ├─ main.ts                    # Application.create() with the plugins, then start()
│  └─ app/
│     ├─ app.config.ts           # @Config('app'): PORT, APP_GREETING           (config)
│     ├─ greeting.schemas.ts     # Zod schema of the request body
│     ├─ greeting.service.ts     # @Injectable, uses AppConfig and Logger
│     ├─ greeting.controller.ts  # GET /greetings/:name?excited, POST /greetings (validated body)
│     ├─ greeting.consumer.ts    # @Consumer('greetings'), POST /greetings/async  (messaging)
│     └─ health.controller.ts    # GET /health
├─ test/
│  ├─ greeting.service.test.ts     # TestBed: real factory, auto-mocked dependencies
│  └─ greeting.controller.test.ts  # TestApp: in-memory HTTP requests
├─ vite.config.ts                # plugins: [znight()]
├─ tsconfig.json                 # strict, experimentalDecorators, moduleResolution bundler, noEmit
├─ bunfig.toml                   # bun only: preloads @znight/compiler/bun before the tests
├─ package.json                  # type module; scripts dev, build, start, generate, typecheck, test
└─ .gitignore                    # node_modules, dist, .znight
```

- `@znight/*` packages are pinned to `^<version of the CLI>` (they are released together).
- Tests run with `bun test` for Bun projects (the preload regenerates the container), with Vitest
  otherwise (the `znight()` plugin of `vite.config.ts` regenerates it).
- `typecheck` runs `znight generate && tsc --noEmit`: the generated container is git-ignored.
- The adapter's peer dependencies are added (`fastify`; `express` + `@types/express`; `hono` +
  `@hono/node-server`), plus `light-my-request` (dev) for `TestApp.inject()` with the `node` and
  `express` adapters. Yarn projects get a `.yarnrc.yml` with `nodeLinker: node-modules`.

## `znight generate`

Runs the compiler and writes `src/.znight/container.generated.ts` when its content changed. Compiler
diagnostics are printed with code frames; any error exits with code 1 (and nothing is written).

```sh
znight generate            # ✓ Generated src/.znight/container.generated.ts (12 providers, 30 files, 48ms)
znight generate --check    # CI: exit 1 when the file is missing or out of date (never writes)
znight generate --watch    # regenerate on every change (incremental: only changed files are re-parsed)
```

| Option                                     | Description                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `--check`                                  | Do not write; exit 1 when the generated files are missing or stale             |
| `-w, --watch`                              | Watch the sources (`include` directories) and `package.json` / `tsconfig.json` |
| `--root <dir>`                             | Project root (default: the current directory)                                  |
| `--config <file>`                          | Vite config to read the `znight()` options from (default: `vite.config.*`)     |
| `--config-loader <bundle\|runner\|native>` | How Vite loads the config file                                                 |

The compiler options are those given to `znight()` in your Vite config (when the plugin exposes them,
see [Compiler contract](#compiler-contract)), so that `znight generate` and `vite build` produce the
same file; without a Vite config the defaults are used and Vite is not even loaded.

In CI:

```sh
npx znight generate --check   # or: npx znight generate, before tsc and the tests
npx tsc --noEmit
npx znight build
```

## `znight g`

```sh
znight g service users/user            # src/users/user.service.ts         UserService
znight g controller order              # src/order/order.controller.ts     OrderController
znight g consumer orders --path src/messaging
znight g guard auth --flat             # src/auth.guard.ts                 AuthGuard
znight g interceptor timing --aop      # a method interceptor (@Intercept)
znight g config payment-gateway        # @Config('paymentGateway'): PAYMENT_GATEWAY_* variables
```

| Schematic (alias)     | Generates                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `service` (`s`)       | an `@Injectable()` class                                                                                          |
| `controller` (`co`)   | an `@Controller('/<name>')` with `GET /` and `GET /:id`                                                           |
| `consumer` (`cs`)     | an `@Consumer('<name>')` with a retried `@OnMessage()` handler (a Zod message schema when the project uses `zod`) |
| `config` (`cf`)       | a `@Config('<name>')` class                                                                                       |
| `guard` (`gu`)        | an `@Injectable()` `CanActivate` guard                                                                            |
| `interceptor` (`itc`) | an `@Injectable()` `HttpInterceptor` (`--aop`: a `MethodInterceptor` for `@Intercept`)                            |
| `factory` (`f`)       | a `@Factory()` with a `@Provides()` method                                                                        |

Names are converted: files are `kebab-case.<schematic>.ts`, classes `PascalCase<Schematic>`
(`UserProfile`, `user_profile` and `user-profile.service` all give `user-profile.service.ts` /
`UserProfileService`). Directories before the last `/` are relative to `src/`; without them the file
goes to `src/<name>/`. Nothing has to be registered afterwards: the compiler discovers the class.

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
3. The application crashes or exits → the CLI says so and waits for the next change.
4. `Ctrl+C` (or `SIGTERM`) → the watcher closes and the application stops gracefully; a second
   `Ctrl+C` kills it. The application runs in its own process group, so it receives exactly one
   signal.

Diagnostics of the compiler are printed on every rebuild by the `znight()` plugin. An application built
from a graph with errors refuses to start and prints them again.

| Option                                     | Default           | Description                                                         |
| ------------------------------------------ | ----------------- | ------------------------------------------------------------------- |
| `--root <dir>`                             | current directory | Project root                                                        |
| `--config <file>`                          | `vite.config.*`   | Vite config file                                                    |
| `--config-loader <bundle\|runner\|native>` | Vite's            | How Vite loads the config file                                      |
| `--mode <mode>`                            | `development`     | Vite mode                                                           |
| `--runtime <auto\|node\|bun>`              | `auto`            | Runtime of the application (`auto`: the one running the CLI)        |
| `--entry <file>`                           | entry chunk       | File to run (default: the entry chunk of the build, `dist/main.js`) |
| `--inspect`                                | `false`           | Start the application with `--inspect`                              |
| `--clear`                                  | `false`           | Clear the screen before each rebuild                                |
| `--debounce <ms>`                          | `100`             | Delay between a build and the restart                               |
| `--kill-timeout <ms>`                      | `5000`            | Time to stop after `SIGTERM` before `SIGKILL`                       |
| `--log-level <info\|warn\|error\|silent>`  | `warn`            | Vite log level                                                      |

The application runs with `NODE_ENV=development` (unless set) and, on Node.js, with
`--enable-source-maps`, so stack traces point to your TypeScript files.

## `znight build`

```sh
znight build                    # ✓ Built dist/main.js 48.20 kB in 1.24s
znight build --mode staging
```

Runs `vite build` with your Vite config. With the defaults of the `znight()` plugin, `src/main.ts`
is built to `dist/main.js` (Node.js 24 target, source maps). Any compiler error fails the build
(exit code 1).

| Option                                     | Default           | Description                    |
| ------------------------------------------ | ----------------- | ------------------------------ |
| `--root <dir>`                             | current directory | Project root                   |
| `--config <file>`                          | `vite.config.*`   | Vite config file               |
| `--config-loader <bundle\|runner\|native>` | Vite's            | How Vite loads the config file |
| `--mode <mode>`                            | `production`      | Vite mode                      |
| `--log-level <info\|warn\|error\|silent>`  | `info`            | Vite log level                 |

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
| `--runtime <auto\|node\|bun>` | `auto`                          | Runtime (`auto`: the one running the CLI)       |

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
| `generate({ ...options, check })`                                | `znight generate --check`; `stale: boolean`                                                                     |
| `createCompiler(options)`                                        | `znight generate --watch`: `generate(changes)` (`{ changed, added, removed }`), `isOutFile(file)`, `watchFiles` |
| `compile(options)`                                               | fallback of the above                                                                                           |
| `formatDiagnostics(diagnostics, { color, cwd, summary: false })` | diagnostics output (a plain formatter otherwise)                                                                |

`znight build` and `znight dev` use the `znight()` Vite plugin of the project's Vite config. To read
its options, `znight generate` looks for the plugin named `znight` in the loaded Vite config and reads
`plugin.api.options` (or `plugin.api.getOptions()`).

## License

MIT
