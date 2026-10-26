---
description: "@znight/config - typed configuration classes loaded from environment variables, .env files, JSON/YAML files, Vault or AWS Secrets Manager, validated at boot."
---

# @znight/config <Badge type="tip" text="available" />

Typed configuration for Znight. You declare configuration **classes**; the compiler records their
fields, types and defaults; the `ConfigPlugin` loads values from your sources, validates **every**
class at boot and injects them like any other provider.

```sh
npm install @znight/config
npm install yaml                              # optional, for yaml()
npm install @aws-sdk/client-secrets-manager   # optional, for awsSecretsManager()
```

## Config classes

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

Inject it anywhere:

```ts
@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'end' })
  async createPool(config: DatabaseConfig): Promise<Pool> {
    return new Pool({ host: config.host, port: config.port, password: config.password, ssl: config.ssl })
  }
}
```

| Decorator          | Target   | Description                                                                           |
| ------------------ | -------- | ------------------------------------------------------------------------------------- |
| `@Config(prefix?)` | class    | A singleton configuration provider. `prefix` namespaces the default names             |
| `@Env(name)`       | property | Environment variable (or `.env` entry) to read instead of the default name            |
| `@Secret(name?)`   | property | Masks the value in logs, serialisation and errors; `name` works like `@Env`           |
| `@Default(value)`  | property | Default value, static and checked against the type (a literal initializer works too)  |
| `@Key(path)`       | property | Key path in structured sources (JSON/YAML, Vault, AWS); default `<prefix>.<property>` |

All arguments are evaluated at build time. Without `@Env`, the environment name is the
`CONSTANT_CASE` of `<prefix>_<property>`: `maxConnections` of `@Config('database')` reads
`DATABASE_MAX_CONNECTIONS` (key path `database.maxConnections`), of `@Config()` `MAX_CONNECTIONS`.

## Types

Values are parsed according to the **declared property type**:

| Property type                         | Accepted input                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `string`                              | any string (numbers and booleans from files too)                                   |
| `number`                              | a finite number; strings must be strict decimals (`42`, `-1.5`, `1e3`, not `12px`) |
| `boolean`                             | `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` (case-insensitive)                 |
| `string[]`, `number[]`                | a comma-separated list (env) or an array (files)                                   |
| `URL`                                 | an absolute URL, injected as a `URL` instance (`localhost:5432` is rejected)       |
| a literal union (`'debug' \| 'info'`) | one of the listed values (TypeScript enums too)                                    |
| objects, records, `unknown`           | JSON text (env) or a structured value (files)                                      |

Unsupported types (`boolean[]`, functions, class instances other than `URL`...) and config
decorators used outside a `@Config` class are build errors
([`ZNIGHT012`](/reference/error-codes#znight012)). Blank values (`PORT=`) count as unset for every
type except `string`.

For each property, the value is the first of: the environment name in the sources, the key path in
the sources, `@Default`, the initializer. An invalid value is an error, it never falls back to a
lower level.

## Required values and validation

A field is **required** unless it has a default, an initializer, or is optional (`?`,
`| undefined`). When the plugin registers, it validates every config class at once and fails with
[`ZNIGHT006`](/reference/error-codes#znight006) listing **all** missing or invalid values with the
origin of each value, so one deployment attempt shows every problem:

```txt
ZnightError: ZNIGHT006: Invalid configuration: 2 problems
  - DatabaseConfig.password: missing required value; set DB_PASSWORD (or key "database.password")
  - DatabaseConfig.port: expected a number but got "54 32" (DB_PORT from .env.local)
```

## Sources

`ConfigPlugin.configure({ loaders, cwd?, env?, validate? })` combines sources, later ones overriding
earlier ones. The default is `[dotenv(), env()]`: `.env` files, then the real environment.

```ts
import { ConfigPlugin, dotenv, env, vault, yaml } from '@znight/config'

ConfigPlugin.configure({
  loaders: [yaml('config/default.yaml'), dotenv(), env(), vault({ path: 'secret/myapp' })],
})
```

| Loader                            | Reads                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env({ prefix? })`                | a snapshot of `process.env` (optionally only `APP_*` variables, prefix removed)                                                                                |
| `dotenv({ path? })`               | `.env`, `.env.local` (not in tests), `.env.<NODE_ENV>`, `.env.<NODE_ENV>.local`, parsed with `node:util` `parseEnv`; `process.env` untouched unless `populate` |
| `json(path)` / `yaml(path)`       | structured files: key paths (`database.host`) or environment names at the top level (`yaml` peer)                                                              |
| `vault({ path })`                 | KV secrets of HashiCorp Vault over its HTTP API (token auth, `VAULT_ADDR` / `VAULT_TOKEN`)                                                                     |
| `awsSecretsManager({ secretId })` | AWS Secrets Manager secrets (`@aws-sdk/client-secrets-manager` peer)                                                                                           |
| `inline(values)`                  | fixed values (defaults first, or overrides last)                                                                                                               |

A failing loader stops the boot with a `ConfigLoaderError` (`ZNIGHT006`) naming it. A custom loader
is an object `{ name, load(context) }` returning `{ origin, values }` layers. The plugin exposes the
combined `ConfigSource` as an injectable provider (and as `plugin.source`), so custom code can read
raw values too. Without `ConfigPlugin`, each config class reads `process.env` when it is created.

## Using config in plugin options

Config classes are ordinary providers, so plugins can read them through the
[container-function form](/guide/plugins#options-computed-from-the-container) of their options:

```ts
plugins: [ConfigPlugin.configure(), HttpPlugin.configure(container => ({ port: container.get(ServerConfig).port }))]
```

## Testing

In [`TestBed`](/guide/testing#testbed-unit-tests-with-auto-mocks), config classes are real instances
built from their defaults plus the `config` values you pass (`config: { database: { host: 'db' } }`).
In application tests, supply an instance with
`overrides: [[DatabaseConfig, { host: 'localhost', port: 5432 }]]`. `ConfigPlugin` validates every
config class before overrides are applied: with the plugin, pass the values with `inline()` or use
`ConfigPlugin.configure({ validate: false })`.
