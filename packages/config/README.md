# @znight/config

Type-safe configuration for [Znight](../../README.md): declare a class, get a validated singleton
loaded from environment variables, `.env` files, JSON/YAML files, HashiCorp Vault or AWS Secrets
Manager.

- **Compile-time metadata.** The compiler reads your config classes (property names, TypeScript
  types, decorators) and generates their field definitions. No reflection at runtime.
- **Fail fast, all at once.** Every missing or invalid value of every config class is reported in a
  single `ZNIGHT006` error, before any provider is created.
- **Strict coercion.** `"12px"` is not a number, `"maybe"` is not a boolean, `localhost:5432` is not
  a URL.
- **Secrets stay secret.** `@Secret` values are masked in `JSON.stringify`, `console.log`,
  `util.inspect`, `toString()` and error messages.
- **Layered sources.** Loaders run in order and later ones win: `.env` files < environment < Vault…

```sh
bun add @znight/config
bun add yaml                               # optional, for yaml()
bun add @aws-sdk/client-secrets-manager    # optional, for awsSecretsManager()
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only).

## Quick start

```ts
// src/config/database.config.ts
import { Config, Env, Secret } from '@znight/config'

@Config('database')
export class DatabaseConfig {
  host = 'localhost' // DATABASE_HOST, default 'localhost'
  port = 5432 // DATABASE_PORT, coerced to a number
  @Env('DATABASE_URL') url?: URL // optional, validated absolute URL
  @Secret('DB_PASSWORD') password!: string // required, masked when printed
  poolSize: 5 | 10 | 20 = 10 // DATABASE_POOL_SIZE, must be 5, 10 or 20
}
```

Config classes are singleton providers: inject them anywhere.

```ts
@Injectable()
export class Database {
  constructor(private readonly config: DatabaseConfig) {}
}
```

```ts
// src/main.ts
import { ConfigPlugin } from '@znight/config'
import { Application } from '@znight/core'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [ConfigPlugin.configure()], // loads .env files, then process.env
})
await app.start()
```

A misconfigured application does not start:

```
ZnightError: ZNIGHT006: Invalid configuration: 3 problems
  - DatabaseConfig.password: missing required value; set DB_PASSWORD (or key "database.password")
  - DatabaseConfig.port: expected a number but got "54 32" (DATABASE_PORT from .env.local)
  - DatabaseConfig.poolSize: expected one of 5, 10, 20 but got 15 (DATABASE_POOL_SIZE from process.env)
```

## Decorators

Decorators are compile-time markers (they do nothing at runtime). Their arguments must be statically
evaluable: literals or `const` references.

| Decorator          | Target   | Description                                                                         |
| ------------------ | -------- | ----------------------------------------------------------------------------------- |
| `@Config(prefix?)` | class    | Declares a config class (singleton provider). `prefix` namespaces the default names |
| `@Env(name)`       | property | Environment variable to read instead of the default name                            |
| `@Secret(name?)`   | property | Marks the value as secret (masked); `name` works like `@Env`                        |
| `@Default(value)`  | property | Default value, coerced like a source value (a literal initializer also works)       |
| `@Key(path)`       | property | Key path in structured sources (JSON/YAML, Vault, AWS) instead of the default       |

### Names

| Property         | `@Config('database')`      | `@Config()`       |
| ---------------- | -------------------------- | ----------------- |
| environment name | `DATABASE_MAX_CONNECTIONS` | `MAX_CONNECTIONS` |
| key path         | `database.maxConnections`  | `maxConnections`  |

For `maxConnections`. Names are `CONSTANT_CASE` (`HTTPPort` → `HTTP_PORT`, `apiKeyV2` →
`API_KEY_V2`); `defaultEnvName()` / `defaultKeyPath()` compute them.

### Types

The TypeScript type of a property selects the coercion:

| TypeScript type                    | Accepted values                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `string`                           | strings as is (also numbers and booleans from files)                                         |
| `number`                           | finite numbers, strict decimal strings: `42`, `-1.5`, `1e3` (not `12px`, `0x10`, `Infinity`) |
| `boolean`                          | `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` (case-insensitive)                           |
| `string[]`, `number[]`             | comma-separated strings (`a, b,c`: items trimmed, empty items dropped) or arrays from files  |
| `URL`                              | absolute URLs, produces a `URL` instance (`localhost:5432` is rejected: missing scheme)      |
| objects, records, `unknown`        | JSON strings (parsed) or structured values from files (deep-copied)                          |
| literal unions (`'dev' \| 'prod'`) | the base type, then checked against the allowed values (every element for arrays)            |

A property is **required** unless it is optional (`?`, `| undefined`), has `@Default` or an
initializer. Blank values (`PORT=`) count as unset for every type except `string`, so they fall back
to the default; for a `string`, an empty value is a value.

### Precedence

For each property, the first of:

1. the **environment name** in the source (`DB_PASSWORD`) — any loader may provide it, including a
   JSON file or a secret with a top-level `DB_PASSWORD` entry;
2. the **key path** in the source (`database.password`), in nested (`{ "database": { "password" } }`)
   or flat (`{ "database.password": ... }`) form;
3. `@Default(value)`;
4. the initializer (`port = 5432`).

Within the source, later loaders override earlier ones. An invalid value is an error: it never falls
back to a lower precedence.

## Secrets

```ts
@Config()
export class ApiConfig {
  @Secret('API_TOKEN') token!: string
}

console.log(config) // ApiConfig { token: '[REDACTED]' }
JSON.stringify(config) // {"token":"[REDACTED]"}
String(config) // ApiConfig {"token":"[REDACTED]"}
config.token // the real value
```

Masking is installed as non-enumerable `toJSON`, `toString` and `util.inspect.custom` methods on the
instance (`console.log` in Node and Bun use the latter); methods the class defines itself are kept.
Error messages show `[REDACTED]` instead of secret values. Spreading (`{ ...config }`) or reading the
property gives the real value, of course. The `ConfigSource` itself never prints its values either.

## ConfigPlugin

```ts
ConfigPlugin.configure({
  loaders: [dotenv(), env(), vault({ path: 'secret/myapp' })],
})
```

In `register()`, the plugin runs the loaders in order, registers the resulting `ConfigSource`
(token `@znight/config#ConfigSource`, `ConfigTokens.Source`) and validates every config class of
the application at once. Config classes then read their values from that source.

| Option     | Default             | Description                                                                       |
| ---------- | ------------------- | --------------------------------------------------------------------------------- |
| `loaders`  | `[dotenv(), env()]` | Loaders, in precedence order (later wins)                                         |
| `cwd`      | `process.cwd()`     | Base directory of relative file paths                                             |
| `env`      | `process.env`       | Environment given to the loaders                                                  |
| `validate` | `true`              | Validate every config class in `register()`; when `false`, each class fails alone |

`plugin.source` exposes the loaded source; it can also be injected:

```ts
@Injectable()
export class FeatureFlags {
  constructor(private readonly source: ConfigSource) {}
  isEnabled(flag: string) {
    return this.source.get(`FEATURE_${flag}`) === 'on'
  }
}
```

### Without ConfigPlugin

The plugin is optional. Without it, each config class reads `process.env` when it is created (no
`.env` files, no other sources), and a missing value fails the creation of that class (`ZNIGHT015`
caused by `ZNIGHT006`).

## Loaders

### `env(options?)`

A snapshot of `process.env`, taken when the loader runs.

| Option       | Default       | Description                                                                 |
| ------------ | ------------- | --------------------------------------------------------------------------- |
| `prefix`     | —             | Only read `APP_*` variables, without the prefix (`APP_DB_HOST` → `DB_HOST`) |
| `keepPrefix` | `false`       | Keep the prefix in the names (filter only)                                  |
| `env`        | context `env` | Variables to read                                                           |

### `dotenv(options?)`

`.env` files parsed with `node:util` `parseEnv` (comments, quotes, multi-line values, `export`).
Without `path`, loads the conventional files, from the lowest to the highest precedence:

`.env` → `.env.local` (skipped when `NODE_ENV=test`) → `.env.<NODE_ENV>` → `.env.<NODE_ENV>.local`

| Option     | Default               | Description                                                                |
| ---------- | --------------------- | -------------------------------------------------------------------------- |
| `path`     | conventional files    | File or files (later files win), relative to `cwd`                         |
| `nodeEnv`  | `NODE_ENV`            | Mode used to pick the conventional files                                   |
| `optional` | `true` without `path` | Skip missing files (explicit paths are required by default)                |
| `populate` | `false`               | Also write the variables to `process.env`, without replacing existing ones |
| `override` | `false`               | Write to `process.env` replacing existing variables: the files win         |

By default `process.env` is left untouched and, with `[dotenv(), env()]`, the real environment wins
over the files. Variables are not expanded (`${OTHER}` stays as is).

### `json(path, options?)` / `yaml(path, options?)`

Structured files. Nested objects are read with key paths; top-level names can also match
environment names (`{ "DB_PASSWORD": "..." }`). `yaml()` needs the optional peer `yaml`.

| Option     | Default | Description                                                              |
| ---------- | ------- | ------------------------------------------------------------------------ |
| `optional` | `false` | Skip the file when it does not exist                                     |
| `key`      | root    | Mount the content under a key path (`key: 'database'` → `database.host`) |

```ts
ConfigPlugin.configure({ loaders: [yaml('config/app.yaml'), dotenv(), env()] })
```

### `vault(options)`

Reads KV secrets from HashiCorp Vault over its HTTP API (`fetch`, no dependency). Each secret's
key/value pairs become values (`{ DB_PASSWORD: '...' }` matches `@Secret('DB_PASSWORD')`).

```ts
ConfigPlugin.configure({
  loaders: [dotenv(), env(), vault({ path: ['secret/shared', 'secret/myapp'] })],
})
```

| Option         | Default                         | Description                                                                      |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `path`         | (required)                      | `<mount>/<path>` (`secret/myapp` → `GET /v1/secret/data/myapp`), or an array     |
| `address`      | `VAULT_ADDR`                    | Server address                                                                   |
| `token`        | `tokenFile`, then `VAULT_TOKEN` | Token                                                                            |
| `tokenFile`    | —                               | File containing the token (agent sink, Kubernetes), relative to `cwd`            |
| `mount`        | first path segment              | Mount of the secrets engine (for mounts containing `/`); `path` is then relative |
| `kvVersion`    | `2`                             | KV engine version (`1` or `2`)                                                   |
| `namespace`    | `VAULT_NAMESPACE`               | Enterprise namespace (`X-Vault-Namespace`)                                       |
| `key`          | root                            | Mount the secret data under a key path                                           |
| `optional`     | `false`                         | Skip secrets that do not exist (404)                                             |
| `timeoutMs`    | `5000`                          | Timeout of each request                                                          |
| `retries`      | `2`                             | Retries on network errors, timeouts, 429 and 5xx (exponential backoff)           |
| `retryDelayMs` | `200`                           | Base delay between retries                                                       |
| `fetch`        | global `fetch`                  | Custom `fetch` (proxies, tests)                                                  |

`VAULT_*` settings are read from the values loaded by the previous loaders first (a `.env` file
works), then from the environment. The token never appears in error messages.

### `awsSecretsManager(options)`

Reads secrets from AWS Secrets Manager with the optional peer `@aws-sdk/client-secrets-manager`. A
JSON object secret provides one value per entry; a plain secret provides a single value under its
`key` (default: the secret id).

```ts
awsSecretsManager({
  secretId: ['prod/myapp', { secretId: 'prod/db-password', key: 'DB_PASSWORD' }],
})
```

| Option         | Default                             | Description                                                                                  |
| -------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `secretId`     | (required)                          | Id/ARN, `{ secretId, key?, versionStage?, versionId?, optional? }`, or an array (later wins) |
| `region`       | `AWS_REGION` / `AWS_DEFAULT_REGION` | Region (else the SDK chain)                                                                  |
| `client`       | a new `SecretsManagerClient`        | Your client: `SecretsManager` (`getSecretValue`) or `SecretsManagerClient` (`send`)          |
| `clientConfig` | —                                   | Extra options of the default client (`endpoint`, `credentials`...)                           |
| `optional`     | `false`                             | Skip secrets that do not exist (`ResourceNotFoundException`)                                 |
| `timeoutMs`    | `10000`                             | Timeout of each request                                                                      |

### `inline(values, options?)`

Fixed values: defaults before the other loaders, overrides after them (scripts, tests).

```ts
ConfigPlugin.configure({ loaders: [inline({ PORT: '3000' }, { name: 'defaults' }), dotenv(), env()] })
```

### Custom loaders

A loader is an object with a `name` and a `load(context)` method returning a layer
(`{ origin, values }`), several layers, or `undefined`:

```ts
import type { ConfigLoader } from '@znight/config'

export function consul(prefix: string): ConfigLoader {
  return {
    name: 'consul',
    async load({ source, cwd, env }) {
      // `source`: values loaded by the previous loaders
      const response = await fetch(`${source.get('CONSUL_URL')}/v1/kv/${prefix}?recurse`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { origin: `consul:${prefix}`, values: decode(await response.json()) }
    },
  }
}
```

`origin` is shown in error messages. A thrown error aborts the start with a `ConfigLoaderError`
(`ZNIGHT006`) naming the loader, with the original error as `cause`.

## Testing

- Without `ConfigPlugin`, override config classes directly:
  `Application.create({ ..., overrides: [[DatabaseConfig, fakeConfig]] })`.
- `ConfigPlugin` validates every config class in `register()`, before overrides are applied: in an
  application test that overrides config classes, pass the values with `inline()` or use
  `ConfigPlugin.configure({ validate: false })`.
- Build a real instance from values: `loadConfig(DatabaseConfig, createConfigSource([{ origin: 'test', values }]), fields)`.

## Programmatic API

| Export                                           | Description                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `loadConfigSource(loaders, { cwd?, env? })`      | Runs loaders and returns a `ConfigSource` (scripts, CLIs)             |
| `createConfigSource(layers)`                     | A `ConfigSource` from `{ origin, values }` layers (later layers win)  |
| `envSource(env?)`                                | A `ConfigSource` over a snapshot of `process.env`                     |
| `loadConfig(Class, source, fields, options?)`    | Creates a config instance (used by generated code)                    |
| `validateConfigs(metadata, source)`              | Validates every config class of the metadata (used by `ConfigPlugin`) |
| `resolveFields(name, fields, source)`            | Resolves values and problems without instantiating                    |
| `coerceConfigValue(raw, type, { enum, secret })` | One coercion, as a `{ ok, value }` / `{ ok: false, message }` result  |
| `ConfigValidationError`                          | `ZNIGHT006`, with `problems: ConfigProblem[]`                         |
| `ConfigLoaderError`                              | `ZNIGHT006`, with `loader`                                            |

`ConfigSource`: `get(key)` (raw string or structured value), `has(key)`, `keys()`, `origin(key)`
(`process.env`, `.env.local`, `vault:secret/app`...) and optionally `describe()`.

## Errors

| Code        | When                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------- |
| `ZNIGHT006` | Missing or invalid values (`ConfigValidationError`), loader failure (`ConfigLoaderError`)     |
| `ZNIGHT012` | Invalid config metadata or loader options (stale generated code, wrong option types)          |
| `ZNIGHT015` | A config class failed to be created without `ConfigPlugin` (`cause`: `ConfigValidationError`) |

## Compiler

The compiler extension `@znight/config/compiler` is declared in the package manifest: `@znight/compiler`
loads it automatically as soon as your code imports `@znight/config` (no configuration needed). It
turns every `@Config` class into a singleton provider and checks your config classes at build time.

### What is a config field

Every **instance property** of a `@Config` class is a field, decorated or not, including TypeScript
`private`/`protected` properties and `declare` fields. Methods, static properties, `#private` fields,
auto-accessors (`accessor x`) and computed keys are ignored (a config decorator on them is an error).

Properties inherited from base classes are fields too, with the prefix of the config class, so a base
class can hold shared settings (it needs no `@Config` itself). Base classes must be TypeScript sources
analysed by the compiler: properties of a base class coming from a declaration file (`.d.ts`) are not
loaded (warning), because declaration files do not tell which properties have initializers.

```ts
export abstract class ServiceConfig {
  @Env('LOG_LEVEL') logLevel: 'debug' | 'info' = 'info'
  port = 3000
}

@Config('billing')
export class BillingConfig extends ServiceConfig {} // LOG_LEVEL, BILLING_PORT
```

Config classes are created with `new Class()`: their constructor must not have required parameters.

### Type mapping

On top of the [types](#types) above:

| TypeScript                                                                                              | Field                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| no annotation                                                                                           | inferred from the initializer or `@Default` (`port = 5432` → `number`, `new URL(...)` → `URL`) |
| `enum Level { Debug = 'debug', Info = 'info' }`                                                         | `string` restricted to the member values (all strings or all numbers)                          |
| arrays of literal unions or enums (`Level[]`, `('a' \| 'b')[]`)                                         | `string[]` / `number[]`, every item checked                                                    |
| branded primitives (`string & { __brand: 'Id' }`), template literal types                               | the primitive                                                                                  |
| `URL` from `node:url`                                                                                   | `URL`                                                                                          |
| interfaces, object types, `Record`, `Partial`..., tuples, arrays of objects, `object`, `unknown`, `any` | JSON                                                                                           |

Unsupported, with a hint (`ZNIGHT012`): classes (`Date`, `Map`, your own classes: use an interface for
JSON values), functions, `symbol`, `bigint`, `Promise`, mixed unions (`string | number`), `boolean[]`,
`URL[]`, type parameters, and properties whose type can neither be read nor inferred.

Literal union values are sorted (numbers numerically: `enum: [5, 10, 20]`); enum values keep their
declaration order.

### `@Default`

The value of `@Default` must be **statically evaluable** (literals, `const` references, simple
expressions): it is checked against the property type at build time, coerced like a source value at
runtime, and emitted as a literal in the field definitions. References to non-evaluable values
(`@Default(computeDefault())`, `@Default(someInstance)`) are rejected (`ZNIGHT005`): use an initializer
instead, which works with any expression and also makes the property optional:

```ts
@Config()
export class CacheConfig {
  @Default('5m') ttl!: string // checked at build time
  maxEntries: number = computeMaxEntries() // any expression, kept by the instance
}
```

`@Default(null)`, `@Default(undefined)` and blank strings for non-string types have no effect and are
reported. Invalid defaults of `@Secret` properties are reported without showing the value.

### Build-time diagnostics

| Code        | Reported when                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `ZNIGHT012` | unsupported or unknown property type                                                                                 |
| `ZNIGHT012` | `@Env` / `@Secret` / `@Default` / `@Key` in a class that is neither a `@Config` class nor a base class of one        |
| `ZNIGHT012` | config decorator on a static, `#private`, accessor or computed member                                                |
| `ZNIGHT012` | `@Env('A')` and `@Secret('B')` on the same property (`@Secret() @Env('A')` is fine)                                  |
| `ZNIGHT012` | two properties of a class reading the same environment variable or key path                                          |
| `ZNIGHT012` | invalid environment name (letters, digits and `_`, not starting with a digit), key path or prefix (`@Config('2fa')`) |
| `ZNIGHT012` | `@Default` value invalid for the property type (or without effect)                                                   |
| `ZNIGHT012` | constructor with required parameters, or not public                                                                  |
| `ZNIGHT012` | (warning) properties inherited from a base class declared in a `.d.ts` file                                          |
| `ZNIGHT005` | decorator on a wrong target (`@Env` on a method...), applied twice, missing, non-string or non-evaluable argument    |
| `ZNIGHT005` | `@Config` with another provider decorator (`@Injectable`), abstract, generic or non-exported config class            |

### Generated code

Each class gets its field definitions as a module constant (`DatabaseConfig$fields`) shared by its
provider factory (`d => loadConfig(DatabaseConfig, d[0], DatabaseConfig$fields)`) and the
`extensions.config` section, see [Compiler contract](#compiler-contract). The extension can also be
passed explicitly, e.g. to a custom compiler setup:

```ts
// vite.config.ts
import configExtension from '@znight/config/compiler'
import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [znight({ extensions: [configExtension] })] })
```

## Compiler contract

What `@znight/config/compiler` generates and the runtime relies on (spec §9.3). These exports are
stable within a major version.

### Generated code

For every `@Config` class, a singleton provider whose factory calls `loadConfig`, with the
`ConfigSource` as an **optional** dependency, and an entry in `extensions.config`:

```ts
import { loadConfig } from '@znight/config'
import type { ConfigFieldDefinition } from '@znight/config'
import { DatabaseConfig } from '../config/database.config.js'

const DatabaseConfig$fields: readonly ConfigFieldDefinition[] = [
  { property: 'host', env: 'DATABASE_HOST', key: 'database.host', type: 'string', required: false, secret: false },
  { property: 'password', env: 'DB_PASSWORD', key: 'database.password', type: 'string', required: true, secret: true },
  {
    property: 'poolSize',
    env: 'DATABASE_POOL_SIZE',
    key: 'database.poolSize',
    type: 'number',
    enum: [5, 10, 20],
    required: false,
    secret: false,
  },
]

export const __ZNIGHT_METADATA__: ZnightMetadata = {
  providers: {
    ['src/config/database.config.ts#DatabaseConfig']: {
      scope: 'singleton',
      class: DatabaseConfig,
      deps: [{ token: '@znight/config#ConfigSource', optional: true }],
      factory: d => loadConfig(DatabaseConfig, d[0], DatabaseConfig$fields),
    },
  },
  externals: [{ token: '@znight/config#ConfigSource', providedBy: 'ConfigPlugin' }],
  extensions: {
    config: {
      configs: [
        { token: 'src/config/database.config.ts#DatabaseConfig', prefix: 'database', fields: DatabaseConfig$fields },
      ],
    },
  },
}
```

### Runtime helpers

```ts
function loadConfig<T extends object>(
  ConfigClass: new () => T,
  source: ConfigSource | undefined, // d[0]: undefined without ConfigPlugin → process.env
  fields: readonly ConfigFieldDefinition[],
  options?: { name?: string; env?: Readonly<Record<string, string | undefined>> },
): T
```

Import-free helpers for the compiler extension (`src/conventions.ts`, also exported from the root):
`CONFIG_SOURCE_TOKEN` (`'@znight/config#ConfigSource'`), `CONFIG_EXTENSION_NAME` (`'config'`),
`defaultEnvName(prefix, property)`, `defaultKeyPath(prefix, property)`, `constantCase(name)`.

### Field definitions

```ts
interface ConfigFieldDefinition {
  property: string
  env: string // @Env(name) ?? @Secret(name) ?? defaultEnvName(prefix, property)
  key: string // @Key(path) ?? defaultKeyPath(prefix, property)
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'url' | 'json'
  enum?: (string | number | boolean)[] // literal union members (array element unions too)
  default?: unknown // @Default(value) only
  required: boolean // false when `?`, `| undefined`, @Default or an initializer
  secret: boolean // @Secret
}
```

Rules:

- `type` mapping: `string`/string literals → `string`; `number`/number literals → `number`;
  `boolean` (and `true | false`) → `boolean`; `string[]`/`readonly string[]`/`Array<…>` of strings
  or string literals → `string[]`; same for numbers → `number[]`; `globalThis#URL` → `url`; object
  types, interfaces, records, `unknown` → `json`. Anything else (functions, `symbol`, `bigint`,
  `Date`, mixed unions like `string | number`) is ZNIGHT012. `null` / `undefined` members only make
  the property optional.
- `required` MUST be `false` when the property has an initializer, even a non-static one: the runtime
  keeps initializer values but `validateConfigs` never instantiates classes.
- `default` is emitted only for `@Default` (literal initializers are left to the instance; emitting
  them as `default` is equivalent but unnecessary). `@Default` wins over an initializer.
- Optional keys (`enum`, `default`, `prefix`) are omitted when absent (never `undefined`:
  `exactOptionalPropertyTypes`). Fields keep the declaration order; configs are ordered by token.
- `@Env`/`@Secret`/`@Default`/`@Key` outside a `@Config` class, on a static/`#private`/accessor
  member, `@Env` and `@Secret` with different names on the same property, or an invalid
  environment name are ZNIGHT012.
- Config classes must have a constructor callable without arguments (no injected dependencies).
- Importing `loadConfig` from `@znight/config` activates the `ZnightExtensionsMetadata` augmentation
  (`extensions.config: ConfigMetadata`), so the generated section is type-checked.
