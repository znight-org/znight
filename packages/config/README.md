# @znight/config

Type-safe configuration for [Znight](../../README.md): declare a class, get a validated singleton.

Values are loaded from environment variables, `.env` files, JSON/YAML files, HashiCorp Vault, AWS
Secrets Manager, Google Cloud Secret Manager, Azure Key Vault or OCI Vault.

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
# bun
bun add @znight/core @znight/config
bun add -d @znight/compiler vite
bun add yaml                               # optional, for yaml()
bun add @aws-sdk/client-secrets-manager    # optional, for awsSecretsManager()
bun add @google-cloud/secret-manager       # optional, for gcpSecretManager()
bun add @azure/keyvault-secrets @azure/identity  # optional, for azureKeyVault()
bun add oci-secrets oci-common             # optional, for ociVault()

# npm
npm install @znight/core @znight/config
npm install -D @znight/compiler vite
npm install yaml                               # optional, for yaml()
npm install @aws-sdk/client-secrets-manager    # optional, for awsSecretsManager()
npm install @google-cloud/secret-manager       # optional, for gcpSecretManager()
npm install @azure/keyvault-secrets @azure/identity  # optional, for azureKeyVault()
npm install oci-secrets oci-common             # optional, for ociVault()
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only).

**Documentation:** [`@znight/config`](https://github.com/znight-org/znight/blob/main/docs/packages/config.md).
**Examples:** every [example application](https://github.com/znight-org/znight/tree/main/examples)
is configured with it; [`rest-api`](https://github.com/znight-org/znight/tree/main/examples/rest-api)
(database and API keys) and [`secure-api`](https://github.com/znight-org/znight/tree/main/examples/secure-api)
(secrets, validated at boot) are good starting points.

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
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

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
property gives the real value, of course. The `ConfigSource` itself never prints its values either,
and neither do loader errors: a JSON or YAML syntax error gives the line and column, not the parser
message (which quotes the file content). Values loaded from a secret store (`vault()`,
`awsSecretsManager()`, `gcpSecretManager()`, `azureKeyVault()`, `ociVault()`) are masked like `@Secret` values, in `JSON.stringify`,
`console.log`, `toString()` and error messages, even when the field is not `@Secret`: their layers
are flagged `secret: true`, which a custom loader can set too. A field whose value comes from
another layer (an `env()` override, say) is not masked unless it is `@Secret`.

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
caused by `ZNIGHT006`). On Bun, `process.env` also holds the `.env` files Bun loads by itself unless
that is disabled (see [Bun's automatic `.env` loading](#buns-automatic-env-loading)).

## Sources

A source is read by a **loader**. `ConfigPlugin.configure({ loaders })` runs the loaders in order
when the application starts; each one returns one or more layers of values, and later layers
override earlier ones. Every loader is an export of `@znight/config`; the secret stores use the SDK
of their provider, an optional peer dependency imported only when the loader runs.

| Source                      | Loader                                                     | Values                                | Peer dependency                              |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| Environment variables       | [`env()`](#envoptions)                                     | one per variable                      | —                                            |
| `.env` files                | [`dotenv()`](#dotenvoptions)                               | one per entry                         | —                                            |
| JSON and YAML files         | [`json()` / `yaml()`](#jsonpath-options--yamlpath-options) | the structure of the file             | `yaml` for `yaml()`                          |
| HashiCorp Vault             | [`vault()`](#vaultoptions)                                 | the key/value pairs of each KV secret | — (`fetch`)                                  |
| AWS Secrets Manager         | [`awsSecretsManager()`](#awssecretsmanageroptions)         | one per secret, or one per JSON entry | `@aws-sdk/client-secrets-manager`            |
| Google Cloud Secret Manager | [`gcpSecretManager()`](#gcpsecretmanageroptions)           | one per secret, or one per JSON entry | `@google-cloud/secret-manager`               |
| Azure Key Vault             | [`azureKeyVault()`](#azurekeyvaultoptions)                 | one per secret, or one per JSON entry | `@azure/keyvault-secrets`, `@azure/identity` |
| OCI Vault                   | [`ociVault()`](#ocivaultoptions)                           | one per secret, or one per JSON entry | `oci-secrets`, `oci-common`                  |
| Fixed values                | [`inline()`](#inlinevalues-options)                        | the object given                      | —                                            |

What every source has in common:

- **Keys.** A value is found by the environment name of a field (`DB_PASSWORD`) or by its key path
  (`database.password`), see [Precedence](#precedence). Flat sources (environment, `.env`) provide
  names; structured sources (files, JSON secrets) provide both: a top-level `DB_PASSWORD` entry
  matches the name, nested objects match key paths.
- **Loading and refresh.** Loaders run once, in `ConfigPlugin.register()`, before any provider is
  created; config instances are singletons. Nothing is cached between starts and nothing is
  refreshed while the application runs: a changed file or a rotated secret is picked up by the
  next start (a restart or a rolling deployment).
- **Settings from previous loaders.** A loader reads its own settings (`VAULT_ADDR`, `AWS_REGION`,
  `AZURE_KEY_VAULT_URL`...) from its options, then from the values loaded before it (a `.env`
  file works), then from the environment.
- **Errors.** Invalid options fail when the loader is created (`ZNIGHT012`); a failure while loading
  stops the start with a `ConfigLoaderError` (`ZNIGHT006`) naming the loader, with hints and the
  original error as `cause`. Loader errors never quote values: not the content of a file that does
  not parse, not a secret.

### `env(options?)`

**Reads** a snapshot of `process.env` (or the `env` of `ConfigPlugin`), taken when the loader runs.

```ts
ConfigPlugin.configure({ loaders: [dotenv(), env({ prefix: 'APP_' })] }) // APP_DB_HOST → DB_HOST
```

| Option       | Default       | Description                                                                 |
| ------------ | ------------- | --------------------------------------------------------------------------- |
| `prefix`     | —             | Only read `APP_*` variables, without the prefix (`APP_DB_HOST` → `DB_HOST`) |
| `keepPrefix` | `false`       | Keep the prefix in the names (filter only)                                  |
| `env`        | context `env` | Variables to read                                                           |

**Keys.** One value per variable, under its name (without `prefix`): `DB_PASSWORD` fills
`@Secret('DB_PASSWORD')`, `DATABASE_HOST` the field `host` of `@Config('database')`. Values are
strings, coerced to the declared type of the field. Origin: `process.env`, or
`process.env (prefix APP_)`.

**Refresh.** A variable set after the start is not seen.

**Errors.** None at load time; a `prefix` that is not a string is `ZNIGHT012`. On Bun, `env()` warns
when `process.env` holds `.env` files loaded by Bun itself (see below).

### `dotenv(options?)`

**Reads** `.env` files parsed with `node:util` `parseEnv` (comments, quotes, multi-line values,
`export`). Without `path`, loads the conventional files, from the lowest to the highest precedence:

`.env` → `.env.local` (skipped when `NODE_ENV=test`) → `.env.<NODE_ENV>` → `.env.<NODE_ENV>.local`

```ts
ConfigPlugin.configure({ loaders: [dotenv(), env()] }) // the default: the files, then the real environment
ConfigPlugin.configure({ loaders: [dotenv({ path: ['config/base.env', 'config/local.env'] }), env()] })
```

| Option     | Default               | Description                                                                |
| ---------- | --------------------- | -------------------------------------------------------------------------- |
| `path`     | conventional files    | File or files (later files win), relative to `cwd`                         |
| `nodeEnv`  | `NODE_ENV`            | Mode used to pick the conventional files                                   |
| `optional` | `true` without `path` | Skip missing files (explicit paths are required by default)                |
| `populate` | `false`               | Also write the variables to `process.env`, without replacing existing ones |
| `override` | `false`               | Write to `process.env` replacing existing variables: the files win         |

**Keys.** One value per entry, under its name, like `env()`; each file is a layer whose origin is
its path (`.env.local`). By default `process.env` is left untouched and, with `[dotenv(), env()]`,
the real environment wins over the files. Variables are not expanded (`${OTHER}` stays as is).

**Refresh.** The files are read once, at start.

**Errors.** A missing explicit `path` (without `optional: true`) fails with `file not found`; an
empty `path` is `ZNIGHT012`.

#### Bun's automatic `.env` loading

Bun loads `.env`, `.env.<mode>`, `.env.local` (not in `test`) and `.env.<mode>.local` from the
working directory into `process.env` before your code runs, with its own rules: the mode is
`production` or `test` when `NODE_ENV` is exactly that and `development` otherwise (`staging`
included), `.env.local` wins over `.env.<mode>`, and `${VAR}` references are expanded. `env()` then
reads those values as if they came from the real environment, so they win over `dotenv()` and its
precedence, are reported as coming from `process.env`, and are loaded even when `dotenv()` is not
configured (`loaders: [env()]` in production). The same files give different values on Node.js and
on Bun.

Turn Bun's loading off and let `dotenv()` load the files, the same way on both runtimes:

```toml
# bunfig.toml
env = false
```

or `bun --no-env-file dist/main.js` (also with `--preload`). When `env()` reads `process.env` on Bun
and finds variables of these files in it, it emits a warning once per process
(`process.emitWarning`, type `ZnightWarning`) naming the files. To use Bun's loading on purpose, read
`process.env` explicitly: `env({ env: process.env })` skips the check.

### `json(path, options?)` / `yaml(path, options?)`

**Reads** a structured file, relative to `cwd`. `yaml()` needs the optional peer `yaml`.

```ts
ConfigPlugin.configure({
  loaders: [yaml('config/app.yaml'), json('config/local.json', { optional: true }), dotenv(), env()],
})
```

| Option     | Default | Description                                                              |
| ---------- | ------- | ------------------------------------------------------------------------ |
| `optional` | `false` | Skip the file when it does not exist                                     |
| `key`      | root    | Mount the content under a key path (`key: 'database'` → `database.host`) |

**Keys.** Nested objects are read with key paths (`{ "database": { "host": "db" } }` fills
`database.host`); top-level names can also match environment names (`{ "DB_PASSWORD": "..." }`).
Numbers, booleans, arrays and objects keep their type and are checked against the field type. The
origin is the path of the file.

**Refresh.** Read once, like `.env` files.

**Errors.** A missing file (unless `optional`), a root that is not an object (without `key`) and a
syntax error fail. A syntax error gives the position and, for YAML, the `yaml` error code, never the
parser message: JSON and YAML parsers quote the offending input, which can be a secret.

```
ZnightError: ZNIGHT006: Config loader "json" failed: invalid JSON in config/secrets.json at line 2, column 16: unexpected character
```

The parser error is not kept as `cause` either (`util.inspect` and uncaught error reports print it).
YAML warnings (an unknown tag, for instance) are emitted the same way: `process.emitWarning` with type
`YAMLWarning`, the file, the position and the code.

### Secret stores

The five secret-store loaders share one contract ([RFC 0013](../../rfcs/0013-config-secret-managers.md)):

```ts
vault({ path: 'secret/myapp' })
awsSecretsManager({ secretId: ['prod/myapp', { secretId: 'prod/db-password', key: 'DB_PASSWORD' }] })
gcpSecretManager({ secretId: ['DB_PASSWORD', { secretId: 'smtp', key: 'mail' }] })
azureKeyVault({ vaultUrl: 'https://acme.vault.azure.net', secretId: ['DB-PASSWORD', 'smtp'] })
ociVault({ vaultId: 'ocid1.vault.oc1.eu-frankfurt-1.example', secretId: ['DB_PASSWORD', 'smtp'] })
```

- **Which secrets.** One option lists them, in precedence order (later secrets override earlier
  ones): `path` for Vault, `secretId` for the others. Each entry is an identifier or an object with
  the identifier and per-secret options: `key`, `json` (cloud stores), `optional`, and the version
  fields of the provider.
- **Keys.** A JSON object secret (`{"DB_PASSWORD": "...", "database": { "host": "..." }}`) provides
  one value per entry, merged at the root, or mounted under the secret's `key`. Any other value (text,
  a JSON array, invalid JSON) is one value under the secret's `key`, by default the identifier as
  the provider names it (Azure names, which cannot hold `_`, are mapped: see below). `json: false`
  (per secret or for the loader) keeps a JSON object as one text value, a service account key for
  instance. Vault secrets are always key/value maps.
- **Missing secrets.** A secret that does not exist fails the start, unless `optional` (per secret,
  or for every secret of the loader): it is then skipped. Other errors (permissions, credentials,
  network) always fail, `optional` or not. One exception: OCI answers the same 404
  (`NotAuthorizedOrNotFound`) for a missing secret and a missing policy, so on OCI `optional` also
  skips a missing policy; `ociVault()` then emits a `ZnightWarning` naming the secret and both causes.
- **Requests.** Secrets are read concurrently, each request with a timeout (`timeoutMs`, an integer
  from 1 to 2^31 − 1). Once one read fails, the others are cancelled (or, when the SDK cannot cancel,
  no longer awaited). Retries are those of the SDK (Vault: `retries`).
- **Masking.** Their layers are flagged `secret: true`: their values are masked like `@Secret`
  values (see [Secrets](#secrets)), even for fields without `@Secret`.
- **Refresh.** Secrets are read once, at start; a rotated secret is read by the next start. Nothing
  is cached on disk.
- **Errors.** `cannot read secret "<id>": <provider status>: <message>` (or `timed out after <n>
  ms`; Vault adds `, after <n> attempt(s)` once its retries are spent), with hints for missing
  permissions, credentials and missing secrets; `secret "<id>" has no value` when the store answers
  without a payload. Invalid options, or none, are `ZNIGHT012` when the loader is created.
- **Testing.** Each loader takes its client (`client`, Vault: `fetch`), so tests need no network.

### `vault(options)`

**Reads** KV secrets (KV v1 or v2) from HashiCorp Vault over its HTTP API (`fetch`, no dependency).

```ts
ConfigPlugin.configure({
  loaders: [dotenv(), env(), vault({ path: ['secret/shared', { path: 'secret/myapp/db', key: 'database' }] })],
})
```

| Option         | Default                         | Description                                                                                                            |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `path`         | (required)                      | `<mount>/<path>` (`secret/myapp` → `GET /v1/secret/data/myapp`), `{ path, key?, optional? }`, or an array (later wins) |
| `address`      | `VAULT_ADDR`                    | Server address                                                                                                         |
| `token`        | `tokenFile`, then `VAULT_TOKEN` | Token                                                                                                                  |
| `tokenFile`    | —                               | File containing the token (agent sink, Kubernetes), relative to `cwd`                                                  |
| `mount`        | first path segment              | Mount of the secrets engine (for mounts containing `/`); `path` is then relative                                       |
| `kvVersion`    | `2`                             | KV engine version (`1` or `2`)                                                                                         |
| `namespace`    | `VAULT_NAMESPACE`               | Enterprise namespace (`X-Vault-Namespace`)                                                                             |
| `key`          | root                            | Key path of every secret's data (a secret's own `key` wins)                                                            |
| `optional`     | `false`                         | Skip secrets that do not exist (404)                                                                                   |
| `timeoutMs`    | `5000`                          | Timeout of each request                                                                                                |
| `retries`      | `2`                             | Retries on network errors, timeouts, 429, 5xx and bodies that are not JSON                                             |
| `retryDelayMs` | `200`                           | Base delay between retries (doubled each time, at most 30 s)                                                           |
| `fetch`        | global `fetch`                  | Custom `fetch` (proxies, tests)                                                                                        |

**Authentication.** A token: `token`, the content of `tokenFile` (the sink of a Vault agent, a
Kubernetes secret), or `VAULT_TOKEN`. Other auth methods (AppRole, Kubernetes, cloud IAM) are a
Vault agent writing the token file. `VAULT_*` settings are read from the values loaded by the
previous loaders first, then from the environment.

**Keys.** Each secret's key/value pairs become values (`{ DB_PASSWORD: '...' }` matches
`@Secret('DB_PASSWORD')`, nested values match key paths), at the root or under `key`. Origin:
`vault:<mount>/<path>`.

**Refresh.** Read once at start; Vault leases and token renewal are not involved (KV secrets).

**Errors.** `cannot read secret "<mount>/<path>": HTTP <status>: <Vault errors>`: HTTP 404 unless
optional, HTTP 403 with a hint on the token and its policies; after the retries,
`cannot read secret "<mount>/<path>": <last error>, after <n> attempt(s)`; a response without
secret data (a KV v1 mount read as KV v2, for instance) is `secret "<mount>/<path>" has no value`,
with a `kvVersion` hint. `timeoutMs` must be an integer from 1 to 2^31 − 1, `retries` and `retryDelayMs` finite
numbers from 0 (`ZNIGHT012` otherwise). A token or namespace loses its leading and trailing white
space (as `fetch` does: `readFileSync(path, 'utf8')` keeps a final newline); one that is still not a
valid header value (a token file with several lines, an inner line break, NUL or a character above
U+00FF) fails before any request, naming its origin. The token never appears in error messages, and
neither does the content of a response that is not valid JSON (a truncated body may hold a secret):
only its length and content type are reported.

### `awsSecretsManager(options)`

**Reads** secrets from AWS Secrets Manager (`GetSecretValue`) with the optional peer
`@aws-sdk/client-secrets-manager`.

```ts
awsSecretsManager({
  secretId: ['prod/myapp', { secretId: 'prod/db-password', key: 'DB_PASSWORD', versionStage: 'AWSCURRENT' }],
})
```

| Option         | Default                             | Description                                                                                           |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `secretId`     | (required)                          | Name/ARN, `{ secretId, versionStage?, versionId?, key?, json?, optional? }`, or an array (later wins) |
| `region`       | `AWS_REGION` / `AWS_DEFAULT_REGION` | Region (else the SDK chain)                                                                           |
| `client`       | a new `SecretsManagerClient`        | Your client: `SecretsManager` (`getSecretValue`) or `SecretsManagerClient` (`send`)                   |
| `clientConfig` | —                                   | Extra options of the default client (`endpoint`, `credentials`, `maxAttempts`...)                     |
| `json`         | `true`                              | Expand JSON object secrets into one value per entry                                                   |
| `optional`     | `false`                             | Skip secrets that do not exist (`ResourceNotFoundException`)                                          |
| `timeoutMs`    | `10000`                             | Timeout of each request                                                                               |

**Authentication.** The default credential provider chain of the AWS SDK (environment, shared config
and SSO profiles, web identity, ECS and EC2 roles), or `clientConfig.credentials`. Reading needs
`secretsmanager:GetSecretValue` (and `kms:Decrypt` for a customer managed key).

**Keys.** A JSON object secret (the key/value pairs of the console) provides one value per entry; a
plain secret (or a binary one, decoded as UTF-8) is one value under its `key`, default the
`secretId` as written. Origin: `aws-secrets-manager:<secretId>`.

**Refresh.** Read once at start, version `AWSCURRENT` unless `versionStage` or `versionId` is set.

**Errors.** `cannot read secret "<secretId>": <exception>: <message>` (`ResourceNotFoundException`,
`AccessDeniedException`, `DecryptionFailure`...), with a hint for a missing secret (name, ARN,
region), a denied access (`secretsmanager:GetSecretValue`, `kms:Decrypt`), a KMS failure and missing
or expired credentials. LocalStack works with
`clientConfig: { endpoint: 'http://localhost:4566' }`.

### `gcpSecretManager(options)`

**Reads** secrets from Google Cloud Secret Manager (`accessSecretVersion`) with the optional peer
`@google-cloud/secret-manager`.

```ts
gcpSecretManager({
  projectId: 'acme-prod',
  secretId: ['DB_PASSWORD', { secretId: 'smtp', key: 'mail' }, { secretId: 'API_KEY', version: '3' }],
})
```

| Option         | Default                                   | Description                                                                                          |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `secretId`     | (required)                                | Id, resource name, `{ secretId, version?, key?, json?, optional? }`, or an array (later wins)        |
| `projectId`    | `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` | Project of secret ids (else the client's: credentials, metadata server)                              |
| `location`     | — (global secrets)                        | Regional secrets: `projects/<p>/locations/<l>/secrets/...` on `secretmanager.<l>.rep.googleapis.com` |
| `client`       | a new `SecretManagerServiceClient`        | Your client (custom credentials, tests): `accessSecretVersion`                                       |
| `clientConfig` | —                                         | Options of the default client (`credentials`, `keyFilename`, `apiEndpoint`, `port`, `fallback`...)   |
| `json`         | `true`                                    | Expand JSON object secrets into one value per entry                                                  |
| `optional`     | `false`                                   | Skip secrets that do not exist or have no version (`NOT_FOUND`)                                      |
| `timeoutMs`    | `10000`                                   | Timeout of each request                                                                              |

A `secretId` is an id of the loader's project (`DB_PASSWORD`) or a resource name
(`projects/<project>/secrets/<id>`, optionally `/versions/<version>`), which needs no project; the
version is `latest` unless the name or `version` sets one. Each location has its own endpoint, so a
loader reads the secrets of one location: a resource name must be in the loader's `location`
(`projects/<project>/locations/<location>/secrets/<id>`), or global without it, otherwise the loader
fails when created (`ZNIGHT012`); use one `gcpSecretManager()` per location.

**Authentication.** Application Default Credentials (`gcloud auth application-default login`
locally, the attached service account or workload identity in Google Cloud,
`GOOGLE_APPLICATION_CREDENTIALS`), or `clientConfig.credentials` / `keyFilename`. Reading needs
`roles/secretmanager.secretAccessor` on the secret or the project.

**Keys.** A JSON object secret provides one value per entry; a plain secret is one value under its
`key`, default the secret id (`DB_PASSWORD` fills `@Secret('DB_PASSWORD')`, the id of a resource
name too). Origin: `gcp-secret-manager:<secretId>`.

**Refresh.** Read once at start, version `latest` by default: pin a version to keep reading it after
a rotation.

**Errors.** `cannot read secret "<secretId>": <gRPC status>: <message>`, with a hint for
`PERMISSION_DENIED`, `UNAUTHENTICATED` or missing credentials, `NOT_FOUND` and disabled versions
(`FAILED_PRECONDITION`); `cannot determine the Google Cloud project` without a project. There is no
official Secret Manager emulator: pass a `client` implementing `SecretManagerServiceClientLike`, or
point the default client to your own endpoint with `clientConfig` (`apiEndpoint`, `port`, and
`fallback: true` with `protocol: 'http'` for the REST transport).

### `azureKeyVault(options)`

**Reads** secrets from Azure Key Vault (`getSecret`) with the optional peers `@azure/keyvault-secrets`
and `@azure/identity`.

```ts
azureKeyVault({
  vaultUrl: 'https://acme.vault.azure.net',
  secretId: ['DB-PASSWORD', 'database--host', { secretId: 'smtp', key: 'mail' }],
})
```

| Option         | Default                        | Description                                                                             |
| -------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `secretId`     | (required)                     | Secret name, `{ secretId, version?, key?, json?, optional? }`, or an array (later wins) |
| `vaultUrl`     | `AZURE_KEY_VAULT_URL`          | Vault URL, `https://<vault>.vault.azure.net` (the "Vault URI" of the vault)             |
| `credential`   | a new `DefaultAzureCredential` | `TokenCredential` of the default client                                                 |
| `client`       | a new `SecretClient`           | Your client (tests, wrappers): `getSecret(name, { version, abortSignal })`              |
| `clientConfig` | —                              | Options of the default client (`retryOptions`, `serviceVersion`, `httpClient`...)       |
| `json`         | `true`                         | Expand JSON object secrets into one value per entry                                     |
| `optional`     | `false`                        | Skip secrets that do not exist (HTTP 404)                                               |
| `timeoutMs`    | `10000`                        | Timeout of each request                                                                 |

**Authentication.** `DefaultAzureCredential`: environment variables (`AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` or a certificate), workload identity (AKS), managed
identity, then the Azure CLI, Azure Developer CLI and Azure PowerShell sign-ins; or any
`TokenCredential` of `@azure/identity` as `credential`. Reading needs the "Key Vault Secrets User"
role on the vault (RBAC), or a "Get" secret access policy.

**Keys.** Key Vault secret names hold only letters, digits and `-` (1 to 127 characters), so the
default key of a plain value is the name mapped by `azureSecretKey()`: `--` becomes `.` and `-`
becomes `_`. Name the secrets after the keys:

| Secret name          | Key                 | Fills                               |
| -------------------- | ------------------- | ----------------------------------- |
| `DB-PASSWORD`        | `DB_PASSWORD`       | `@Secret('DB_PASSWORD')`            |
| `database--password` | `database.password` | `password` of `@Config('database')` |
| `mail--smtp-host`    | `mail.smtp_host`    | `@Key('mail.smtp_host')`            |

A secret's `key` replaces the mapping; a JSON object secret provides one value per entry. Origin:
`azure-key-vault:<name>`.

**Refresh.** Read once at start, the current version unless `version` is set.

**Errors.** `cannot read secret "<name>": <error code>: <message>` (`SecretNotFound`, `Forbidden`...),
with a hint for 403 (role or access policy, firewall), 401 and credential errors; `no vault URL`
without `vaultUrl`. A name with other characters (`DB_PASSWORD`) is `ZNIGHT012`, with the name to use.

### `ociVault(options)`

**Reads** secrets from Oracle Cloud Infrastructure Vault (`getSecretBundle`, `getSecretBundleByName`)
with the optional peers `oci-secrets` and `oci-common`.

```ts
ociVault({
  vaultId: 'ocid1.vault.oc1.eu-frankfurt-1.example',
  secretId: ['DB_PASSWORD', { secretId: 'ocid1.vaultsecret.oc1.eu-frankfurt-1.example', key: 'API_KEY' }],
})
```

| Option                          | Default                                 | Description                                                                                                   |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `secretId`                      | (required)                              | Secret OCID or name, `{ secretId, versionNumber?, stage?, key?, json?, optional? }`, or an array (later wins) |
| `vaultId`                       | `OCI_VAULT_ID`                          | Vault OCID of the secrets read by name                                                                        |
| `auth`                          | `resource-principal` or `config-file`   | `config-file`, `resource-principal` or `instance-principal` (see below)                                       |
| `configFile`                    | `OCI_CONFIG_FILE`, then `~/.oci/config` | Config file of `config-file`                                                                                  |
| `profile`                       | `OCI_CLI_PROFILE`, then `DEFAULT`       | Profile of `config-file`                                                                                      |
| `authenticationDetailsProvider` | —                                       | Any provider of `oci-common` instead of `auth` (session token, OKE workload identity...)                      |
| `region`                        | the region of the authentication        | Region (`eu-frankfurt-1`)                                                                                     |
| `endpoint`                      | the region's endpoint                   | Service endpoint (private endpoint, tests)                                                                    |
| `client`                        | a new `SecretsClient`                   | Your client (tests, wrappers): `getSecretBundle`, `getSecretBundleByName`                                     |
| `clientConfig`                  | —                                       | Client configuration of the default client (`retryConfiguration`, `circuitBreaker`)                           |
| `json`                          | `true`                                  | Expand JSON object secrets into one value per entry                                                           |
| `optional`                      | `false`                                 | Skip secrets that are not found (HTTP 404)                                                                    |
| `timeoutMs`                     | `10000`                                 | Timeout of each request                                                                                       |

**Authentication.** `auth` picks the provider of `oci-common`: `resource-principal` (OCI Functions,
Container Instances, Data Flow: the default when `OCI_RESOURCE_PRINCIPAL_VERSION` is set),
`instance-principal` (compute instances, through the instance metadata), or `config-file` (an API
signing key in `~/.oci/config`, created by `oci setup config`: the default otherwise). Reading needs
a policy such as `allow dynamic-group <group> to read secret-bundles in compartment <compartment>`.

**Keys.** A `secretId` starting with `ocid1.` is a secret OCID; anything else is a secret name in
`vaultId`. A JSON object secret provides one value per entry; a plain secret is one value under its
`key`, default the `secretId` as written: name the secrets after the keys (`DB_PASSWORD`), or set
`key` for secrets read by OCID. Contents are decoded from base64 as UTF-8. Origin:
`oci-vault:<secretId>`.

**Refresh.** Read once at start, the `CURRENT` version unless `versionNumber` or `stage` (`CURRENT`,
`PENDING`, `LATEST`, `PREVIOUS`, `DEPRECATED`) is set.

**Errors.** `cannot read secret "<secretId>": <service code> (HTTP <status>): <message>`. OCI answers
`NotAuthorizedOrNotFound` (404) both for a missing secret and a missing policy, so `optional` skips
both: the hint names the two causes, and a skipped optional secret emits a `ZnightWarning`
(`process.emitWarning`) that names it, so a missing policy does not go unnoticed. A name without `vaultId` fails at load time; an unusable
config file or principal fails with `cannot set up the <auth> authentication`.

### `inline(values, options?)`

**Reads** fixed values: defaults before the other loaders, overrides after them (scripts, tests).

```ts
ConfigPlugin.configure({ loaders: [inline({ PORT: '3000' }, { name: 'defaults' }), dotenv(), env()] })
```

| Option | Default  | Description                    |
| ------ | -------- | ------------------------------ |
| `name` | `inline` | Origin shown in error messages |

**Keys.** Names and key paths, flat or nested, like a JSON file. **Errors.** Values that are not an
object are `ZNIGHT012`.

### Custom loaders

A loader is an object with a `name` and a `load(context)` method returning a layer
(`{ origin, values, secret? }`), several layers, or `undefined`:

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

`origin` is shown in error messages; `secret: true` masks the values of the layer like `@Secret`
values. A thrown error aborts the start with a `ConfigLoaderError` (`ZNIGHT006`) naming the loader,
with the original error as `cause`.

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
(`process.env`, `.env.local`, `vault:secret/app`...) and optionally `describe()`. `keys()` lists
the paths of structured values without walking a cycle twice, and visits at most 10 000 entries
per layer (values from a custom loader sharing sub-objects would otherwise list exponentially many
paths).

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
