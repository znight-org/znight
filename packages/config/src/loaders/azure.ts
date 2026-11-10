import type { ConfigLayer } from '../source.ts'
import type { NormalizedSecret } from './secret-store.ts'
import type { ConfigLoader, ConfigLoaderContext } from './types.ts'

import { ConfigLoaderError, errorMessage, invalidConfig } from '../errors.ts'
import {
  abortable,
  errorProperty,
  normalizeSecrets,
  noValueError,
  readError,
  readSecretLayers,
  requestSignal,
  secretLayer,
  secretValues,
} from './secret-store.ts'
import { importOptionalPeer, setting, timeoutOption } from './shared.ts'

/** One secret read by {@link azureKeyVault}. */
export interface AzureSecretRef {
  /** Secret name (`DB-PASSWORD`: letters, digits and `-`). */
  readonly secretId: string
  /** Secret version. Default: the current version. */
  readonly version?: string
  /**
   * Key path under which the secret is mounted. JSON object secrets are merged at the root by
   * default; plain (non-object) secrets are stored under `key`, default the name mapped by
   * {@link azureSecretKey} (`DB-PASSWORD` → `DB_PASSWORD`, `database--password` → `database.password`).
   */
  readonly key?: string
  /** Expand a JSON object secret into one value per entry. Default: the loader `json` (`true`). */
  readonly json?: boolean
  /** Skip the secret when it does not exist (HTTP 404). Default: the loader `optional`. */
  readonly optional?: boolean
}

/** A secret returned by `getSecret`. */
export interface KeyVaultSecretLike {
  readonly name?: string
  readonly value?: string | undefined
}

/**
 * A Key Vault secrets client: the `SecretClient` of `@azure/keyvault-secrets`, or any object with
 * `getSecret` (tests, wrappers).
 */
export interface KeyVaultSecretClientLike {
  getSecret(name: string, options?: { version?: string; abortSignal?: AbortSignal }): Promise<KeyVaultSecretLike>
}

/** Options of {@link azureKeyVault}. */
export interface AzureKeyVaultLoaderOptions {
  /** Secrets to read, in precedence order (later secrets override earlier ones). */
  readonly secretId: string | AzureSecretRef | readonly (string | AzureSecretRef)[]
  /** Vault URL (`https://<vault>.vault.azure.net`). Default: `AZURE_KEY_VAULT_URL` (previous loaders, environment). */
  readonly vaultUrl?: string
  /**
   * Credential of the default client (a `TokenCredential` of `@azure/identity`). Default: a
   * `DefaultAzureCredential` (environment, workload identity, managed identity, Azure CLI...).
   */
  readonly credential?: object
  /** Client to use (tests, wrappers). Default: a `SecretClient` from `@azure/keyvault-secrets`. */
  readonly client?: KeyVaultSecretClientLike
  /** Extra options of the default client (`retryOptions`, `serviceVersion`, `disableChallengeResourceVerification`...). */
  readonly clientConfig?: Readonly<Record<string, unknown>>
  /** Expand JSON object secrets into one value per entry. Default: `true`. */
  readonly json?: boolean
  /** Skip every secret that does not exist. Default: `false`. */
  readonly optional?: boolean
  /** Timeout of each request, in milliseconds. Default: `10000`. */
  readonly timeoutMs?: number
}

interface KeyVaultSecretsModule {
  SecretClient: new (
    vaultUrl: string,
    credential: object,
    options?: Record<string, unknown>,
  ) => KeyVaultSecretClientLike
}

interface IdentityModule {
  DefaultAzureCredential: new () => object
}

const SDK = '@azure/keyvault-secrets'
const IDENTITY = '@azure/identity'
const LOADER = 'azure-key-vault'
const WHERE = 'azureKeyVault()'

const SECRET_NAME = /^[0-9a-zA-Z-]{1,127}$/
const VERSION = /^[0-9a-zA-Z]{1,64}$/

const CREDENTIALS_HINT =
  'Sign in for DefaultAzureCredential: az login locally, a managed identity or workload identity in Azure, or AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET'

/**
 * The default config key of an Azure Key Vault secret name, which only holds letters, digits and
 * `-`: `--` becomes `.` (a key path separator) and `-` becomes `_`, so `DB-PASSWORD` fills
 * `@Secret('DB_PASSWORD')` and `database--password` the key path `database.password`.
 */
export function azureSecretKey(name: string): string {
  return name.replaceAll('--', '.').replaceAll('-', '_')
}

function statusCode(error: unknown): number | undefined {
  const status = errorProperty(error, 'statusCode')
  return typeof status === 'number' ? status : undefined
}

/** The Key Vault error code (`SecretNotFound`, `Forbidden`), else `HTTP <status>`, else the error name. */
function errorStatus(error: unknown): string | undefined {
  const code = errorProperty(error, 'code')
  if (typeof code === 'string' && code !== '') return code
  const status = statusCode(error)
  if (status !== undefined) return `HTTP ${status}`
  const name = errorProperty(error, 'name')
  return typeof name === 'string' && name !== 'Error' && name !== 'RestError' ? name : undefined
}

function accessHints(error: unknown): string[] {
  switch (statusCode(error)) {
    case 401:
      return [CREDENTIALS_HINT]
    case 403:
      return [
        'Grant the identity the application runs as the "Key Vault Secrets User" role on the vault (or a "Get" secret access policy), and check the vault firewall',
      ]
    case 404:
      return ['Check the secret name and the vault URL, or mark the secret optional']
    default:
      return /credential/i.test(errorMessage(error)) ? [CREDENTIALS_HINT] : []
  }
}

async function createClient(
  context: ConfigLoaderContext,
  options: AzureKeyVaultLoaderOptions,
): Promise<KeyVaultSecretClientLike> {
  if (options.client !== undefined) return options.client
  const vaultUrl = setting(context, options.vaultUrl, 'AZURE_KEY_VAULT_URL')
  if (vaultUrl === undefined) {
    throw new ConfigLoaderError(LOADER, 'no vault URL: pass { vaultUrl } or set AZURE_KEY_VAULT_URL', {
      hints: ['The vault URL is https://<vault name>.vault.azure.net (the "Vault URI" of the vault)'],
    })
  }
  if (!URL.canParse(vaultUrl)) throw new ConfigLoaderError(LOADER, `invalid vault URL ${JSON.stringify(vaultUrl)}`)
  const sdk = await importOptionalPeer<KeyVaultSecretsModule>(SDK, LOADER)
  const credential =
    options.credential ?? new (await importOptionalPeer<IdentityModule>(IDENTITY, LOADER)).DefaultAzureCredential()
  return new sdk.SecretClient(vaultUrl, credential, { ...options.clientConfig })
}

/**
 * Reads secrets from Azure Key Vault. A JSON object secret (`{"DB_PASSWORD": "..."}`) provides one
 * value per entry; a plain secret provides one value under its `key` (default: its name through
 * {@link azureSecretKey}, `DB-PASSWORD` → `DB_PASSWORD`). Requires the optional peer dependencies
 * `@azure/keyvault-secrets` and `@azure/identity` (for the default `DefaultAzureCredential`),
 * imported only when the loader runs without a `client`.
 *
 * ```ts
 * azureKeyVault({ vaultUrl: 'https://acme.vault.azure.net', secretId: ['DB-PASSWORD', 'smtp'] })
 * ```
 */
export function azureKeyVault(options: AzureKeyVaultLoaderOptions): ConfigLoader {
  if (typeof options !== 'object' || options === null) throw invalidConfig(`${WHERE}: options are required`)
  const secrets = normalizeSecrets<AzureSecretRef & Record<string, unknown>>(WHERE, 'secretId', options.secretId, {
    json: options.json,
    optional: options.optional,
  })
  for (const { id, ref } of secrets) {
    if (!SECRET_NAME.test(id)) {
      throw invalidConfig(
        `${WHERE}: invalid secret name "${id}"; Key Vault names have 1 to 127 letters, digits and "-"`,
        [
          'Name the secret DB-PASSWORD for the key DB_PASSWORD, database--password for database.password, or set its "key"',
        ],
      )
    }
    if (ref.version !== undefined && (typeof ref.version !== 'string' || !VERSION.test(ref.version))) {
      throw invalidConfig(`${WHERE}: invalid "version" of "${id}" ${JSON.stringify(ref.version)}`)
    }
  }
  const client = options.client
  if (client !== undefined && typeof client?.getSecret !== 'function') {
    throw invalidConfig(`${WHERE}: "client" must have a getSecret(name, options) method`)
  }
  if (options.credential !== undefined && (typeof options.credential !== 'object' || options.credential === null)) {
    throw invalidConfig(`${WHERE}: "credential" must be a TokenCredential (an object with getToken())`)
  }
  const timeoutMs = timeoutOption(WHERE, options.timeoutMs, 10_000)

  return {
    name: LOADER,
    async load(context) {
      const client = await createClient(context, options)
      const read = async (
        secret: NormalizedSecret<AzureSecretRef>,
        cancel: AbortSignal,
      ): Promise<ConfigLayer | undefined> => {
        let result: KeyVaultSecretLike
        try {
          const signal = requestSignal(cancel, timeoutMs)
          const request = client.getSecret(secret.id, {
            abortSignal: signal,
            ...(secret.ref.version === undefined ? {} : { version: secret.ref.version }),
          })
          result = await abortable(request, signal)
        } catch (error) {
          if (statusCode(error) === 404 && secret.optional) return undefined
          throw readError(LOADER, secret.id, error, {
            status: errorStatus(error),
            timeoutMs,
            hints: accessHints(error),
          })
        }
        if (typeof result?.value !== 'string') throw noValueError(LOADER, secret.id)
        return secretLayer(`${LOADER}:${secret.id}`, secretValues(result.value, secret, azureSecretKey(secret.id)))
      }
      return readSecretLayers(secrets, read)
    },
  }
}
