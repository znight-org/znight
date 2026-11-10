---
"@znight/config": patch
---

New `gcpSecretManager()` loader for Google Cloud Secret Manager (optional peer `@google-cloud/secret-manager`): secrets by name and/or by label or filter, version `latest` by default, `stripPrefix` and `mapKey` for the keys, JSON expansion with `json: true`, errors with hints for missing roles and credentials. Values loaded by `vault()`, `awsSecretsManager()` and `gcpSecretManager()` are now masked in validation messages even for fields without `@Secret` (new `ConfigLayer.secret` flag).
