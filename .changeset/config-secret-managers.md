---
"@znight/config": minor
---

One contract for the secret-store loaders (RFC 0013). New `azureKeyVault()` (optional peers `@azure/keyvault-secrets` and `@azure/identity`) and `ociVault()` (optional peers `oci-secrets` and `oci-common`) loaders. `vault()` accepts `{ path, key?, optional? }` refs and `awsSecretsManager()` a `json` option. Breaking for `gcpSecretManager()`, aligned on `awsSecretsManager()`: `secrets` is now `secretId` (refs `{ secretId, version?, key?, json?, optional? }`), `clientOptions` is `clientConfig`, JSON object secrets are expanded by default (`json: false` keeps them as text), and `labels`, `filter`, `stripPrefix`, `mapKey` and the loader-level `version` are removed.
