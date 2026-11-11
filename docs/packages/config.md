---
description: "@znight/config - typed configuration classes loaded from environment variables, .env files, JSON/YAML files, Vault, AWS Secrets Manager, Google Cloud Secret Manager, Azure Key Vault or OCI Vault, validated at boot."
---

# @znight/config <Badge type="tip" text="available" />

Typed configuration for Znight. You declare configuration **classes**; the compiler records their
fields, types and defaults; the `ConfigPlugin` loads values from your sources, validates **every**
class at boot and injects them like any other provider.

```sh
npm install @znight/config
npm install yaml                              # optional, for yaml()
npm install @aws-sdk/client-secrets-manager   # optional, for awsSecretsManager()
npm install @google-cloud/secret-manager      # optional, for gcpSecretManager()
npm install @azure/keyvault-secrets @azure/identity  # optional, for azureKeyVault()
npm install oci-secrets oci-common            # optional, for ociVault()
```

::: tip Guide
This page is the reference. To configure an application step by step (config classes, layering,
secrets, plugin options, tests), read the [Configuration guide](/guide/configuration).
:::

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

A config class is a singleton provider: inject it anywhere
([how](/guide/configuration#config-classes)).

| Decorator          | Target   | Description                                                                          |
| ------------------ | -------- | ------------------------------------------------------------------------------------ |
| `@Config(prefix?)` | class    | A singleton configuration provider. `prefix` namespaces the default names            |
| `@Env(name)`       | property | Environment variable (or `.env` entry) to read instead of the default name           |
| `@Secret(name?)`   | property | Masks the value in logs, serialisation and errors; `name` works like `@Env`          |
| `@Default(value)`  | property | Default value, static and checked against the type (a literal initializer works too) |
| `@Key(path)`       | property | Key path in structured sources (files, secrets); default `<prefix>.<property>`       |

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

A source is read by a **loader**. `ConfigPlugin.configure({ loaders })` runs the loaders in order
when the application starts; each one returns one or more layers of values, and later layers
override earlier ones. Every loader is an export of `@znight/config`; the secret stores use the SDK
of their provider, an optional peer dependency imported only when the loader runs.

| Source                      | Loader                                        | Values                                | Peer dependency                              |
| --------------------------- | --------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| Environment variables       | [`env()`](#env)                               | one per variable                      | —                                            |
| `.env` files                | [`dotenv()`](#dotenv)                         | one per entry                         | —                                            |
| JSON and YAML files         | [`json()` / `yaml()`](#json-yaml)             | the structure of the file             | `yaml` for `yaml()`                          |
| HashiCorp Vault             | [`vault()`](#vault)                           | the key/value pairs of each KV secret | — (`fetch`)                                  |
| AWS Secrets Manager         | [`awsSecretsManager()`](#aws-secrets-manager) | one per secret, or one per JSON entry | `@aws-sdk/client-secrets-manager`            |
| Google Cloud Secret Manager | [`gcpSecretManager()`](#gcp-secret-manager)   | one per secret, or one per JSON entry | `@google-cloud/secret-manager`               |
| Azure Key Vault             | [`azureKeyVault()`](#azure-key-vault)         | one per secret, or one per JSON entry | `@azure/keyvault-secrets`, `@azure/identity` |
| OCI Vault                   | [`ociVault()`](#oci-vault)                    | one per secret, or one per JSON entry | `oci-secrets`, `oci-common`                  |
| Fixed values                | [`inline()`](#inline)                         | the object given                      | —                                            |

What every source has in common:

- **Keys.** A value is found by the environment name of a field (`DB_PASSWORD`) or by its key path
  (`database.password`), see [Types](#types). Flat sources (environment, `.env`) provide
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

The plugin exposes the combined `ConfigSource` as an injectable provider (and as `plugin.source`),
so custom code can read raw values too. Without `ConfigPlugin`, each config class reads
`process.env` when it is created.

### `env(options?)` {#env}

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
when `process.env` holds `.env` files loaded by Bun itself (see [Bun's automatic `.env` loading](#bun-env-loading)).

### `dotenv(options?)` {#dotenv}

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

### `json(path, options?)` / `yaml(path, options?)` {#json-yaml}

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

```txt
ZnightError: ZNIGHT006: Config loader "json" failed: invalid JSON in config/secrets.json at line 2, column 16: unexpected character
```

The parser error is not kept as `cause` either (`util.inspect` and uncaught error reports print it).
YAML warnings (an unknown tag, for instance) are emitted the same way: `process.emitWarning` with type
`YAMLWarning`, the file, the position and the code.

### Secret stores {#secret-stores}

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
  values (in validation messages and when the config instance is printed or serialised), even for
  fields without `@Secret`.
- **Refresh.** Secrets are read once, at start; a rotated secret is read by the next start. Nothing
  is cached on disk.
- **Errors.** `cannot read secret "<id>": <provider status>: <message>` (or `timed out after <n>
  ms`; Vault adds `, after <n> attempt(s)` once its retries are spent), with hints for missing
  permissions, credentials and missing secrets; `secret "<id>" has no value` when the store answers
  without a payload. Invalid options, or none, are `ZNIGHT012` when the loader is created.
- **Testing.** Each loader takes its client (`client`, Vault: `fetch`), so tests need no network.

### `vault(options)` {#vault}

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

### `awsSecretsManager(options)` {#aws-secrets-manager}

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

### `gcpSecretManager(options)` {#gcp-secret-manager}

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

### `azureKeyVault(options)` {#azure-key-vault}

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

### `ociVault(options)` {#oci-vault}

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

### `inline(values, options?)` {#inline}

**Reads** fixed values: defaults before the other loaders, overrides after them (scripts, tests).

```ts
ConfigPlugin.configure({ loaders: [inline({ PORT: '3000' }, { name: 'defaults' }), dotenv(), env()] })
```

| Option | Default  | Description                    |
| ------ | -------- | ------------------------------ |
| `name` | `inline` | Origin shown in error messages |

**Keys.** Names and key paths, flat or nested, like a JSON file. **Errors.** Values that are not an
object are `ZNIGHT012`.

### Custom loaders {#custom-loaders}

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

## Bun's automatic `.env` loading {#bun-env-loading}

Moved to the [Configuration guide](/guide/configuration#bun-env-loading). In short: Bun loads `.env`
files into `process.env` before your code runs, with its own rules, so that `env()` reads them as the
real environment. Turn it off with `env = false` in `bunfig.toml` (or `bun --no-env-file`) and let
`dotenv()` load the files the same way on Node.js and Bun. On Bun, `env()` warns once per process
when `process.env` holds variables of the files Bun loaded.

## Using config in plugin options

Moved to [Config in plugin options](/guide/configuration#plugin-options): plugins read config
classes through the container-function form of their options.

## Testing

Moved to [Testing](/guide/configuration#testing) in the Configuration guide: `TestBed` builds config
classes from their defaults plus the `config` values you pass, application tests pass fixed values
with `inline()`, and `ConfigPlugin` validates before `overrides` are applied
(`ConfigPlugin.configure({ validate: false })` turns that off).
