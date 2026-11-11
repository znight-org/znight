# @znight/config

## 0.8.0

### Minor Changes

- 66db089: One contract for the secret-store loaders (RFC 0013). New `azureKeyVault()` (optional peers `@azure/keyvault-secrets` and `@azure/identity`) and `ociVault()` (optional peers `oci-secrets` and `oci-common`) loaders. `vault()` accepts `{ path, key?, optional? }` refs and `awsSecretsManager()` a `json` option. Breaking for `gcpSecretManager()`, aligned on `awsSecretsManager()`: `secrets` is now `secretId` (refs `{ secretId, version?, key?, json?, optional? }`), `clientOptions` is `clientConfig`, JSON object secrets are expanded by default (`json: false` keeps them as text), and `labels`, `filter`, `stripPrefix`, `mapKey` and the loader-level `version` are removed. `vault()` error messages now follow the common format (`cannot read secret "<path>": HTTP <status>: ...`, `secret "<path>" has no value`), `awsSecretsManager()` errors carry hints, and `ociVault()` warns when it skips an optional secret (OCI answers 404 for a missing policy too).

### Patch Changes

- @znight/compiler@0.8.0
  - @znight/core@0.8.0

## 0.7.3

### Patch Changes

- 78e20e2: New `gcpSecretManager()` loader for Google Cloud Secret Manager (optional peer `@google-cloud/secret-manager`): secrets by name and/or by label or filter, version `latest` by default, `stripPrefix` and `mapKey` for the keys, JSON expansion with `json: true`, errors with hints for missing roles and credentials. Values loaded by `vault()`, `awsSecretsManager()` and `gcpSecretManager()` are now masked like `@Secret` values (validation messages, `JSON.stringify`, `util.inspect`, `toString()`) even for fields without `@Secret` (new `ConfigLayer.secret` flag, `ResolvedFields.secrets`).
- Updated dependencies [bb1c8f1]
  - @znight/core@0.7.3
  - @znight/compiler@0.7.3

## 0.7.2

### Patch Changes

- @znight/compiler@0.7.2
  - @znight/core@0.7.2

## 0.7.1

### Patch Changes

- 3cbfd77: The `homepage` of every package points to its page of the documentation site.
- Updated dependencies [3cbfd77]
  - @znight/compiler@0.7.1
  - @znight/core@0.7.1

## 0.7.0

### Patch Changes

- @znight/compiler@0.7.0
  - @znight/core@0.7.0

## 0.6.6

### Patch Changes

- Updated dependencies [d85b11b]
  - @znight/compiler@0.6.6
  - @znight/core@0.6.6

## 0.6.5

### Patch Changes

- @znight/compiler@0.6.5
  - @znight/core@0.6.5

## 0.6.4

### Patch Changes

- 74b6b04: `ConfigSource.keys()` (and `toJSON()`) visit at most 10 000 entries per layer, so values whose shared sub-objects make the paths grow exponentially no longer hang the process.
- 74b6b04: `vault()` trims the white space around an explicit `token` or `namespace` (a token read with `readFileSync` keeps its final newline) instead of rejecting it, as `fetch` did before.
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
  - @znight/compiler@0.6.4
  - @znight/core@0.6.4

## 0.6.3

### Patch Changes

- a5d31c5: `vault()` rejects a token or namespace that is not a valid header value without leaking it, `vault()` and `awsSecretsManager()` validate their numeric options (ZNIGHT012), cap the retry backoff and cancel the other reads once one fails, and `ConfigSource.keys()` no longer expands cyclic values.
- Updated dependencies [0eeac37]
- Updated dependencies [dede0c2]
  - @znight/compiler@0.6.3
  - @znight/core@0.6.3

## 0.6.2

### Patch Changes

- @znight/compiler@0.6.2
  - @znight/core@0.6.2

## 0.6.1

### Patch Changes

- @znight/compiler@0.6.1
  - @znight/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [f6cbef6]
  - @znight/core@0.6.0
  - @znight/compiler@0.6.0

## 0.5.1

### Patch Changes

- @znight/compiler@0.5.1
  - @znight/core@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [469d6bf]
  - @znight/core@0.5.0
  - @znight/compiler@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [3bb4597]
  - @znight/core@0.4.0
  - @znight/compiler@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [75f4b8c]
  - @znight/core@0.3.0
  - @znight/compiler@0.3.0

## 0.2.2

### Patch Changes

- @znight/compiler@0.2.2
  - @znight/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [1ecae4f]
  - @znight/compiler@0.2.1
  - @znight/core@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [b6119e6]
  - @znight/compiler@0.2.0
  - @znight/core@0.2.0

## 0.1.4

### Patch Changes

- 1fb7b0e: Update development dependencies: @biomejs/biome, tsdown, @aws-sdk/client-secrets-manager, @aws-sdk/client-sqs and @cfworker/json-schema.
- Updated dependencies [c21ef01]
- Updated dependencies [c21ef01]
  - @znight/compiler@0.1.4
  - @znight/core@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [39f7f5f]
- Updated dependencies [39f7f5f]
  - @znight/core@0.1.3
  - @znight/compiler@0.1.3

## 0.1.2

### Patch Changes

- @znight/compiler@0.1.2
  - @znight/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [dc8ac11]
  - @znight/compiler@0.1.1
  - @znight/core@0.1.1

## 0.1.0

### Initial release

- First public release of `@znight/config`. Znight config plugin: type-safe configuration classes loaded from env, files and secret stores.
