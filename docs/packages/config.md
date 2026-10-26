---
description: "@znight/config - typed configuration classes loaded from environment variables, .env files, JSON/YAML files, Vault or AWS Secrets Manager, validated at boot."
---

# @znight/config <Badge type="warning" text="in development" />

Typed configuration for Znight. You declare configuration **classes**; the compiler records their
fields, types and defaults; the `ConfigPlugin` loads values from your sources, validates **every**
class at boot and injects them like any other provider.

<!-- TODO(api): verify against implementation (this page follows the specification; loader names and options may change) -->

```sh
npm install @znight/config
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

| Decorator          | Target   | Description                                                    |
| ------------------ | -------- | -------------------------------------------------------------- |
| `@Config(prefix?)` | class    | A singleton configuration provider. `prefix` scopes file keys. |
| `@Env(name)`       | property | Environment variable (or `.env` entry) holding the value       |
| `@Secret(name)`    | property | Like `@Env`, but the value is masked in logs and serialisation |
| `@Default(value)`  | property | Default value (a literal initializer works too)                |
| `@Key(path)`       | property | Key in file sources; default `<prefix>.<property>`             |

## Types

Values are parsed according to the **declared property type**:

| Property type                         | Accepted input                                   |
| ------------------------------------- | ------------------------------------------------ |
| `string`                              | any string                                       |
| `number`                              | a finite number                                  |
| `boolean`                             | `true` / `false` (and the usual variants)        |
| `string[]`, `number[]`                | a comma-separated list (env) or an array (files) |
| `URL`                                 | a valid URL                                      |
| a literal union (`'debug' \| 'info'`) | one of the listed values                         |
| JSON objects                          | JSON text (env) or an object (files)             |

Unsupported types (functions, class instances other than `URL`...) and `@Env` used outside a
`@Config` class are build errors ([`ZNIGHT012`](/reference/error-codes#znight012)).

## Required values and validation

A field is **required** unless it has a default, an initializer, or is optional (`?`). When the
plugin registers, it validates every config class at once and fails with
[`ZNIGHT006`](/reference/error-codes#znight006) listing **all** missing or invalid values, so one
deployment attempt shows every problem:

```txt
ZNIGHT006: Missing required configuration values:
  - DatabaseConfig.password (env DB_PASSWORD)
  - MailConfig.apiKey (env MAIL_API_KEY)
```

## Sources

`ConfigPlugin.configure({ loaders })` combines sources, later ones overriding earlier ones:

```ts
import { ConfigPlugin } from '@znight/config'
import { dotenv, env, jsonFile, yamlFile } from '@znight/config/loaders'

ConfigPlugin.configure({
  loaders: [yamlFile('config/default.yaml'), dotenv('.env'), env()],
})
```

| Loader              | Reads                                                               |
| ------------------- | ------------------------------------------------------------------- |
| Environment         | `process.env`                                                       |
| `.env` files        | parsed with `node:util` `parseEnv` (no dependency)                  |
| JSON / YAML files   | keys addressed with `@Key()` or `<prefix>.<property>` (`yaml` peer) |
| HashiCorp Vault     | secrets from a Vault path                                           |
| AWS Secrets Manager | secrets from AWS (`@aws-sdk/client-secrets-manager` peer)           |

The plugin exposes the combined `ConfigSource` as a provider, so custom code can read raw values too.

## Using config in plugin options

Config classes are ordinary providers, so plugins can read them through the
[container-function form](/guide/plugins#options-computed-from-the-container) of their options:

```ts
plugins: [ConfigPlugin.configure(), HttpPlugin.configure(container => ({ port: container.get(ServerConfig).port }))]
```

## Testing

In [`TestBed`](/guide/testing#testbed-unit-tests-with-auto-mocks), config classes are real instances
built from their defaults plus the `config` overrides you pass. In other tests, supply an instance
with `overrides: [[DatabaseConfig, { host: 'localhost', port: 5432 }]]`.
