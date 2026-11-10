# RFC 0013: Secret-store loaders (`@znight/config`)

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Accepted (2026-11-10, requested by the maintainer)                                                                                                                                                                                                                                                                                                                                                                                        |
| Date     | 2026-11-10                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Affects  | `@znight/config`: `gcpSecretManager()` (breaking: options renamed, discovery removed), `vault()` and `awsSecretsManager()` (additive), new `azureKeyVault()` (optional peers `@azure/keyvault-secrets` ^4, `@azure/identity` ^4) and `ociVault()` (optional peers `oci-secrets` ^2, `oci-common` ^2). No change to `ConfigLoader`, the compiler extension or the error catalogue. Specification §8 (config loaders), package README, docs |
| Decision | **One contract for every secret-store loader: the same option names and shapes for the same concepts (`secretId` / `path`, per-secret `key`, `json`, `optional`, `client`, `clientConfig`, `timeoutMs`), the same mapping of values to config keys, the same errors, and no refresh.** Azure Key Vault and OCI Vault join HashiCorp Vault, AWS Secrets Manager and Google Cloud Secret Manager under that contract                        |

## 1. Summary

`@znight/config` read secrets from HashiCorp Vault and AWS Secrets Manager, then Google Cloud Secret
Manager (0.7.3). The GCP loader was modelled on one application's needs: secrets discovered by
label or `listSecrets` filter, `stripPrefix`, `mapKey`, values kept as text unless `json: true`,
`secrets` / `name` / `clientOptions` where the AWS loader says `secretId` / `clientConfig`. Two
loaders doing the same thing with different words and defaults is a cost for every user and every
future provider. This RFC fixes the common contract, aligns `gcpSecretManager()` on it, and adds
Azure Key Vault and OCI Vault, the two other large clouds' secret stores.

```ts
ConfigPlugin.configure({
  loaders: [
    dotenv(),
    env(),
    vault({ path: ['secret/shared', { path: 'secret/myapp/db', key: 'database' }] }),
    awsSecretsManager({ secretId: ['prod/myapp', { secretId: 'prod/db-password', key: 'DB_PASSWORD' }] }),
    gcpSecretManager({ secretId: ['DB_PASSWORD', { secretId: 'smtp', key: 'mail' }] }),
    azureKeyVault({ vaultUrl: 'https://acme.vault.azure.net', secretId: ['DB-PASSWORD', 'database--host'] }),
    ociVault({ vaultId: 'ocid1.vault.oc1.eu-frankfurt-1.example', secretId: ['DB_PASSWORD'] }),
  ],
})
```

## 2. The contract

| Concept        | Option                                                                                          | Rule                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Which secrets  | `secretId` (Vault: `path`)                                                                      | An identifier, `{ secretId, ...per-secret options }`, or an array; later secrets override earlier ones (one layer each)        |
| Version        | AWS `versionStage` / `versionId`, GCP `version`, Azure `version`, OCI `versionNumber` / `stage` | Per secret, in the provider's own terms; the provider's current version by default                                             |
| Key mapping    | per-secret `key`                                                                                | A JSON object is merged at the root or mounted under `key`; anything else is one value under `key`, else the default key       |
| Default key    | —                                                                                               | The identifier as the provider names it (AWS: the `secretId`; GCP: the secret id; OCI: the `secretId`; Azure: mapped, §3)      |
| JSON expansion | `json` (loader and per secret), default `true`                                                  | Only a JSON **object** is expanded; arrays, invalid JSON and text are one value. Not applicable to Vault (always a map)        |
| Missing secret | `optional` (loader and per secret), default `false`                                             | A not-found answer skips the secret when optional; every other error fails                                                     |
| Client         | `client` (Vault: `fetch`), `clientConfig` for the default client                                | The SDK is an optional peer, imported lazily; an injected client is never closed                                               |
| Timeout        | `timeoutMs` (10 s, Vault 5 s)                                                                   | Per request, enforced even when the client ignores the abort signal; a failure cancels or abandons the other reads             |
| Errors         | —                                                                                               | `ConfigLoaderError` (ZNIGHT006): `cannot read secret "<id>": <provider status>: <message>`, hints, `cause`; options: ZNIGHT012 |
| Masking        | —                                                                                               | Layers are `secret: true`: values masked like `@Secret` values                                                                 |
| Refresh        | —                                                                                               | None: read once in `register()`, a rotated secret is read by the next start                                                    |

`json` defaults to `true` because `awsSecretsManager()` always expanded JSON objects (published
behaviour) and the AWS console stores key/value secrets as JSON objects; `json: false` keeps a JSON
document (a service account key) as one value. `vault()` gains `{ path, key?, optional? }` refs and
`awsSecretsManager()` gains `json`: both stay backward compatible.

## 3. Azure Key Vault: `azureKeyVault()`

`@azure/keyvault-secrets` `SecretClient.getSecret(name, { version, abortSignal })`, with a
`DefaultAzureCredential` of `@azure/identity` unless `credential` (or `client`) is given; the vault
is `vaultUrl`, else `AZURE_KEY_VAULT_URL`. Secret names only hold `[0-9a-zA-Z-]` (1 to 127), so the
default key of a plain value is `azureSecretKey(name)`: `--` becomes `.` and `-` becomes `_`
(`DB-PASSWORD` → `DB_PASSWORD`, `database--password` → `database.password`), the convention .NET
configuration uses for `--`. A name outside the alphabet is ZNIGHT012, with the name to use. Not
found is HTTP 404.

## 4. OCI Vault: `ociVault()`

`oci-secrets` `SecretsClient`: `getSecretBundle({ secretId })` for an OCID (`ocid1.…`),
`getSecretBundleByName({ secretName, vaultId })` for a name, with `versionNumber` / `stage`. The
content is base64, decoded as UTF-8. Authentication comes from `oci-common`: `auth:
'resource-principal'` (the default when `OCI_RESOURCE_PRINCIPAL_VERSION` is set: Functions,
Container Instances), `'instance-principal'`, or `'config-file'` (`~/.oci/config`, `OCI_CONFIG_FILE`,
profile `OCI_CLI_PROFILE`; the default otherwise), or any `authenticationDetailsProvider`. OCI
answers `NotAuthorizedOrNotFound` (404) for a missing secret and a missing policy alike: `optional`
skips both, and the hint says so.

## 5. Alternatives considered

- **Keep discovery (labels, filters, prefixes) and add it to every loader.** Each store lists
  differently (GCP labels and filters, AWS tags and name prefixes, Azure tags, OCI needs another SDK
  package, `oci-vault`), needs an extra permission, and two discovered secrets can collide on one
  key. Listing the secrets an application reads is explicit and reviewable; a `ConfigLoader` of a
  few lines covers discovery for the applications that want it.
- **A `mapKey` function on every loader.** The per-secret `key` covers renames, and Azure's fixed
  mapping covers its alphabet; a function adds a second way to do the same thing.
- **`json: false` by default (the GCP behaviour).** It would change `awsSecretsManager()`, which is
  published. One default for every loader wins over the per-provider habits.
- **A refresh interval.** Config instances are singletons validated once at boot; values changing
  under a running application would bypass that validation. Rotation is a restart or a rolling
  deployment, as for every other source.

## 6. Out of scope

Refresh and caching, discovery by label or tag, writing secrets, certificates and keys (Azure Key
Vault and OCI Vault store more than secrets), and other stores (Doppler, 1Password, Infisical...),
which a custom `ConfigLoader` covers.
