---
description: Typed configuration with @znight/config - declare config classes, map them to environment variables, validate every value at boot, layer .env files, JSON/YAML and secret stores, use config in plugin options, Bun's .env loading and tests.
---

# Configuration

With `@znight/config`, configuration is a **class**: each property is a typed setting, read from
the environment, `.env` files, JSON or YAML files or a secret store, converted to its declared type
and validated when the application boots. Config classes are providers: inject them like any other
class, there is nothing to register.

This page shows how to configure an application. The [package reference](/packages/config) lists
every decorator, type and loader option.

## Set up {#setup}

```sh
npm install @znight/config
```

```ts
import { ConfigPlugin } from '@znight/config'
import { HttpPlugin } from '@znight/http'
import { createApplication } from './.znight/container.generated.js'

const app = await createApplication({
  plugins: [ConfigPlugin.configure(), HttpPlugin.configure({ port: 3000 })],
})
```

`ConfigPlugin.configure()` loads `.env` files, then the real environment, and validates every config
class when it registers, before any provider is created. Its place in the list does not matter for
configuration: plugin options that read a config class use the
[function form](#plugin-options), which runs once the configuration is loaded, whatever the order.
Keep `ObservabilityPlugin` first when you use it ([Observability](./observability#setup)).

## Declare a config class {#config-classes}

```ts
import { Config, Default, Env, Secret } from '@znight/config'

@Config('database')
export class DatabaseConfig {
  @Env('DB_HOST')
  @Default('localhost')
  host!: string

  @Env('DB_PORT')
  port = 5432 // a literal initializer works like @Default

  @Secret('DB_PASSWORD')
  password!: string

  @Env('DB_SSL')
  ssl = false

  @Env('DB_POOL_SIZE')
  poolSize?: number // optional: undefined when not set
}
```

Inject it where the values are needed, for instance in the factory that opens the database:

```ts
@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'end' })
  async createPool(config: DatabaseConfig): Promise<Pool> {
    return new Pool({ host: config.host, port: config.port, password: config.password, ssl: config.ssl })
  }
}
```

Config classes are singletons, created once the values are loaded. Split the configuration by
concern (`ServerConfig`, `DatabaseConfig`, `MailConfig`): each provider then depends only on what it
reads, and tests build only what they need.

## How names map to variables {#names}

Without `@Env`, the variable name is the `CONSTANT_CASE` of `<prefix>_<property>`:

| Declaration                                     | Variable                   | Key path in files and secrets |
| ----------------------------------------------- | -------------------------- | ----------------------------- |
| `maxConnections` in `@Config('database')`       | `DATABASE_MAX_CONNECTIONS` | `database.maxConnections`     |
| `maxConnections` in `@Config()`                 | `MAX_CONNECTIONS`          | `maxConnections`              |
| `@Env('DB_PORT') port` in `@Config('database')` | `DB_PORT`                  | `database.port`               |
| `@Key('db.host') host` in `@Config('database')` | `DATABASE_HOST`            | `db.host`                     |

Decorator arguments are read by the compiler, like every Znight decorator: names must be literals or
constants.

## Types {#types}

Values are converted to the **declared property type**: `string`, `number` (strict decimals:
`12px` is refused), `boolean` (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`), `string[]` and
`number[]` (comma-separated in the environment), `URL`, literal unions (`'debug' | 'info'`, enums)
and JSON objects. A type that cannot be read from configuration (`boolean[]`, a function, a class
instance other than `URL`) is a build error, [`ZNIGHT012`](/reference/error-codes#znight012). The
[types table](/packages/config#types) gives every accepted input.

For each property, the value is the first of: the variable in the sources, the key path in the
sources, `@Default`, the initializer. An invalid value is an error; it never falls back to a
default.

## Required values and boot validation {#validation}

A property is **required** unless it has a default, an initializer, or is optional (`?`,
`| undefined`). When `ConfigPlugin` registers, it validates every config class at once and fails
with [`ZNIGHT006`](/reference/error-codes#znight006), listing **all** missing or invalid values with
the origin of each value:

```txt
ZnightError: ZNIGHT006: Invalid configuration: 2 problems
  - DatabaseConfig.password: missing required value; set DB_PASSWORD (or key "database.password")
  - DatabaseConfig.port: expected a number but got "54 32" (DB_PORT from .env.local)
```

One deployment attempt shows every problem, and the process stops before accepting traffic: a
rolling deployment keeps the previous version running
([Deployment](./deployment#configuration-and-secrets)).

## Sources and layering {#sources}

`ConfigPlugin.configure({ loaders })` runs **loaders** in order when the application starts; later
layers override earlier ones. The default is `[dotenv(), env()]`: the `.env` files, then the real
environment, which wins.

```ts
import { ConfigPlugin, dotenv, env, json, vault, yaml } from '@znight/config'

ConfigPlugin.configure({
  loaders: [
    yaml('config/app.yaml'), // defaults committed with the code
    json('config/local.json', { optional: true }),
    dotenv(), // .env, .env.local, .env.<NODE_ENV>, .env.<NODE_ENV>.local
    env(), // the real environment
    vault({ path: 'secret/myapp' }), // secrets last: they win
  ],
})
```

- `dotenv()` loads the conventional files for `NODE_ENV` (`.env.local` is skipped in tests) and
  leaves `process.env` untouched by default.
- Values are read once, at start: a changed file or a rotated secret is picked up by the next start
  (a restart or a rolling deployment).
- A loader reads its own settings (`VAULT_ADDR`, `AWS_REGION`...) from the values loaded before it:
  a `.env` file can configure the secret store that follows it.

Each loader, with its options, keys and errors, is in the [loaders reference](/packages/config#sources).

## Secrets {#secrets}

Mark sensitive properties with `@Secret` instead of `@Env`: the value is masked in validation
messages, logs and serialisation (`console.log(config)`, `JSON.stringify(config)`). Values loaded
from a secret store are masked too, even without `@Secret`.

Where secrets come from depends on the platform:

| Platform                       | Loader                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Containers, Kubernetes secrets | `env()`, or `dotenv({ path })` on a mounted file                                       |
| HashiCorp Vault                | [`vault()`](/packages/config#vault)                                                    |
| AWS                            | [`awsSecretsManager()`](/packages/config#aws-secrets-manager)                          |
| Google Cloud                   | [`gcpSecretManager()`](/packages/config#gcp-secret-manager)                            |
| Azure                          | [`azureKeyVault()`](/packages/config#azure-key-vault)                                  |
| Oracle Cloud                   | [`ociVault()`](/packages/config#oci-vault)                                             |
| Anything else                  | a [custom loader](/packages/config#custom-loaders): an object with `name` and `load()` |

The secret stores share one contract (which secrets, keys, missing secrets, timeouts, errors that
never quote a value): see [secret stores](/packages/config#secret-stores). The
[Security guide](./security#secrets) covers rotation and logs.

## Config in plugin options {#plugin-options}

Config classes are ordinary providers, so plugin options can read them through the
[container-function form](./plugins#options-computed-from-the-container): the function runs once
`ConfigPlugin` has loaded and validated the configuration.

```ts
import { ConfigPlugin } from '@znight/config'
import { HttpPlugin } from '@znight/http'
import { ObservabilityPlugin } from '@znight/observability'

const plugins = [
  ObservabilityPlugin.configure(container => ({ logging: { level: container.get(ServerConfig).logLevel } })),
  ConfigPlugin.configure(),
  HttpPlugin.configure(container => ({ port: container.get(ServerConfig).port })),
]
```

This replaces NestJS's `ConfigModule.forRoot()` plus `forRootAsync({ useFactory, inject })`. The
`rest-api` example reads its whole server configuration this way (`src/app.ts`).

## Bun's automatic `.env` loading {#bun-env-loading}

Bun loads `.env`, `.env.<mode>`, `.env.local` (not in tests) and `.env.<mode>.local` into
`process.env` **before** your code runs, with its own rules: the mode is `production` or `test` when
`NODE_ENV` is exactly that and `development` otherwise, `.env.local` wins over `.env.<mode>`, and
`${VAR}` references are expanded. `env()` then reads those values as if they were the real
environment: they win over `dotenv()`, are reported as coming from `process.env`, and are loaded even
without `dotenv()`. The same files give different values on Node.js and on Bun.

Turn Bun's loading off and let `dotenv()` load the files, the same way on both runtimes:

::: code-group

```toml [bunfig.toml]
env = false
```

:::

or run `bun --no-env-file dist/main.js` (also with `--preload`). On Bun, `env()` warns once per
process (`ZnightWarning`) when `process.env` holds variables of the files Bun loaded, naming them. To
use Bun's loading on purpose, read `process.env` explicitly: `env({ env: process.env })` skips the
check.

## Testing {#testing}

- **Unit tests.** In [`TestBed`](./testing#testbed-unit-tests-with-auto-mocks), config classes are
  real instances built from their defaults plus the `config` values you pass
  (`config: { database: { host: 'db' } }`).
- **Application tests.** Pass fixed values with `inline()`, so that the tests never depend on the
  `.env` files of the machine:

  ```ts
  import { ConfigPlugin, inline } from '@znight/config'

  ConfigPlugin.configure({ loaders: [inline({ API_KEY: 'test-key', DB_PASSWORD: 'secret' })] })
  ```

- **Overrides.** `overrides: [[DatabaseConfig, { host: 'localhost', port: 5432 }]]` replaces a
  config instance. `ConfigPlugin` validates every config class before overrides are applied: with
  the plugin, pass the values with `inline()` or use `ConfigPlugin.configure({ validate: false })`.

The [production wiring](./testing#production-wiring) pattern passes the test configuration through
the same `plugins()` function as `main.ts`.
