/**
 * `@znight/config`: type-safe configuration classes loaded from the environment, `.env` files,
 * JSON/YAML files and secret stores (HashiCorp Vault, AWS Secrets Manager, Google Cloud Secret Manager,
 * Azure Key Vault, OCI Vault).
 *
 * The compiler extension (`@znight/config/compiler`) turns every `@Config` class into a singleton
 * provider whose factory calls {@link loadConfig}; {@link ConfigPlugin} loads the sources and
 * validates every config class at once.
 */

export type { ConfigLoader, ConfigLoaderContext, ConfigLoaderResult } from './loaders/types.ts'

export { type CoercionOptions, type CoercionResult, coerceConfigValue } from './coerce.ts'
export {
  CONFIG_EXTENSION_NAME,
  CONFIG_SOURCE_TOKEN,
  constantCase,
  defaultEnvName,
  defaultKeyPath,
  SECRET_MASK,
} from './conventions.ts'
export {
  Config,
  type ConfigDefaultValue,
  Default,
  Env,
  Key,
  type PropertyMarker,
  Secret,
} from './decorators.ts'
export {
  ConfigLoaderError,
  type ConfigProblem,
  type ConfigProblemKind,
  ConfigValidationError,
} from './errors.ts'
export { type ConfigClass, configDefinitions, type LoadConfigOptions, loadConfig, validateConfigs } from './load.ts'
export {
  type AwsSecretRef,
  type AwsSecretsManagerLoaderOptions,
  awsSecretsManager,
  type GetSecretValueInputLike,
  type GetSecretValueOutputLike,
  type SecretsManagerClientLike,
} from './loaders/aws.ts'
export {
  type AzureKeyVaultLoaderOptions,
  type AzureSecretRef,
  azureKeyVault,
  azureSecretKey,
  type KeyVaultSecretClientLike,
  type KeyVaultSecretLike,
} from './loaders/azure.ts'
export { type DotenvLoaderOptions, dotenv, dotenvFiles } from './loaders/dotenv.ts'
export { type EnvLoaderOptions, env } from './loaders/env.ts'
export { type FileLoaderOptions, json, yaml } from './loaders/files.ts'
export {
  type AccessSecretVersionResponseLike,
  type GcpSecretManagerLoaderOptions,
  type GcpSecretPayloadLike,
  type GcpSecretRef,
  gcpSecretManager,
  type SecretManagerServiceClientLike,
} from './loaders/gcp.ts'
export { type InlineLoaderOptions, inline } from './loaders/inline.ts'
export {
  type OciAuth,
  type OciSecretBundleContentLike,
  type OciSecretBundleResponseLike,
  type OciSecretRef,
  type OciSecretStage,
  type OciSecretsClientLike,
  type OciVaultLoaderOptions,
  ociVault,
} from './loaders/oci.ts'
export { type LoadConfigSourceOptions, loadConfigSource } from './loaders/run.ts'
export { type VaultLoaderOptions, type VaultSecretRef, vault } from './loaders/vault.ts'
export {
  CONFIG_FIELD_TYPES,
  type ConfigClassDefinition,
  type ConfigEnumValue,
  type ConfigFieldDefinition,
  type ConfigFieldType,
  type ConfigMetadata,
} from './metadata.ts'
export { ConfigPlugin, type ConfigPluginInstance, type ConfigPluginOptions } from './plugin.ts'
export { type ResolvedFields, resolveFields } from './resolve.ts'
export {
  type ConfigLayer,
  type ConfigSource,
  createConfigSource,
  envSource,
} from './source.ts'
export { ConfigTokens } from './tokens.ts'
