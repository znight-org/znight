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

/** A stage of a secret version. */
export type OciSecretStage = 'CURRENT' | 'PENDING' | 'LATEST' | 'PREVIOUS' | 'DEPRECATED'

const STAGES: readonly OciSecretStage[] = ['CURRENT', 'PENDING', 'LATEST', 'PREVIOUS', 'DEPRECATED']

/** One secret read by {@link ociVault}. */
export interface OciSecretRef {
  /** Secret OCID (`ocid1.vaultsecret...`), or secret name in the loader's `vaultId`. */
  readonly secretId: string
  /** Version number. Default: the version of `stage`. */
  readonly versionNumber?: number
  /** Version stage. Default: `CURRENT`. */
  readonly stage?: OciSecretStage
  /**
   * Key path under which the secret is mounted. JSON object secrets are merged at the root by
   * default; plain (non-object) secrets are stored under `key`, default the `secretId`.
   */
  readonly key?: string
  /** Expand a JSON object secret into one value per entry. Default: the loader `json` (`true`). */
  readonly json?: boolean
  /** Skip the secret when it is not found (HTTP 404). Default: the loader `optional`. */
  readonly optional?: boolean
}

/** Content of a secret bundle (`BASE64`). */
export interface OciSecretBundleContentLike {
  readonly contentType?: string
  readonly content?: string
}

/** Response of `getSecretBundle` / `getSecretBundleByName` used by the loader. */
export interface OciSecretBundleResponseLike {
  readonly secretBundle?: { readonly secretBundleContent?: OciSecretBundleContentLike | undefined } | undefined
}

/** Version selection of a request. */
interface OciVersionRequest {
  readonly versionNumber?: number
  readonly stage?: OciSecretStage
}

/**
 * A secrets client: the `SecretsClient` of `oci-secrets`, or any object with the same methods
 * (tests, wrappers).
 */
export interface OciSecretsClientLike {
  getSecretBundle(request: { secretId: string } & OciVersionRequest): Promise<OciSecretBundleResponseLike>
  getSecretBundleByName(
    request: { secretName: string; vaultId: string } & OciVersionRequest,
  ): Promise<OciSecretBundleResponseLike>
  close?(): void
}

/** How the default client authenticates. */
export type OciAuth = 'config-file' | 'resource-principal' | 'instance-principal'

/** Options of {@link ociVault}. */
export interface OciVaultLoaderOptions {
  /** Secrets to read, in precedence order (later secrets override earlier ones). */
  readonly secretId: string | OciSecretRef | readonly (string | OciSecretRef)[]
  /** Vault OCID of the secrets read by name. Default: `OCI_VAULT_ID` (previous loaders, environment). */
  readonly vaultId?: string
  /** Region (`eu-frankfurt-1`). Default: the region of the authentication (config file profile, resource principal). */
  readonly region?: string
  /** Service endpoint of the default client (private endpoint, tests). Default: the endpoint of the region. */
  readonly endpoint?: string
  /**
   * Authentication of the default client. Default: `resource-principal` when
   * `OCI_RESOURCE_PRINCIPAL_VERSION` is set (Functions, Container Instances...), else `config-file`.
   */
  readonly auth?: OciAuth
  /** Config file of `config-file`. Default: `OCI_CONFIG_FILE`, then `~/.oci/config`. */
  readonly configFile?: string
  /** Profile of `config-file`. Default: `OCI_CLI_PROFILE`, then `DEFAULT`. */
  readonly profile?: string
  /** Authentication details provider of the default client, instead of `auth` (session token, workload identity...). */
  readonly authenticationDetailsProvider?: object
  /** Client to use (tests, wrappers). Default: a `SecretsClient` from `oci-secrets`. */
  readonly client?: OciSecretsClientLike
  /** Client configuration of the default client (`retryConfiguration`, `circuitBreaker`). */
  readonly clientConfig?: Readonly<Record<string, unknown>>
  /** Expand JSON object secrets into one value per entry. Default: `true`. */
  readonly json?: boolean
  /** Skip every secret that is not found. Default: `false`. */
  readonly optional?: boolean
  /** Timeout of each request, in milliseconds. Default: `10000`. */
  readonly timeoutMs?: number
}

interface OciSecretsModule {
  SecretsClient: new (
    params: { authenticationDetailsProvider: object },
    clientConfiguration?: Record<string, unknown>,
  ) => OciSecretsClientLike & { regionId?: string; endpoint?: string }
}

interface OciCommonModule {
  ConfigFileAuthenticationDetailsProvider: new (configurationFilePath?: string, profile?: string) => object
  ResourcePrincipalAuthenticationDetailsProvider: { builder(): object }
  InstancePrincipalsAuthenticationDetailsProviderBuilder: new () => { build(): Promise<object> }
}

const SDK = 'oci-secrets'
const COMMON = 'oci-common'
const LOADER = 'oci-vault'
const WHERE = 'ociVault()'
const AUTH: readonly OciAuth[] = ['config-file', 'resource-principal', 'instance-principal']

const OCID = /^ocid1\.[a-z0-9]+\.[^\s/]+$/
const SECRET_NAME = /^[^\s/]{1,255}$/

function statusCode(error: unknown): number | undefined {
  const status = errorProperty(error, 'statusCode')
  return typeof status === 'number' ? status : undefined
}

/** `NotAuthorizedOrNotFound (HTTP 404)`, the service code and status of an `OciError`. */
function errorStatus(error: unknown): string | undefined {
  const code = errorProperty(error, 'serviceCode')
  const status = statusCode(error)
  if (typeof code === 'string' && code !== '') return status === undefined ? code : `${code} (HTTP ${status})`
  return status === undefined ? undefined : `HTTP ${status}`
}

function accessHints(error: unknown): string[] {
  switch (statusCode(error)) {
    case 401:
      return [
        'Check the authentication: the config file profile (oci setup config), the resource principal or the instance principal',
      ]
    case 404:
      return [
        'Check the secret OCID or name and the vault, and that a policy allows the identity to "read secret-bundles" in its compartment (OCI answers 404 for both), or mark the secret optional',
      ]
    default:
      return []
  }
}

function optionalString(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '')
    throw invalidConfig(`${WHERE}: "${name}" must be a non-empty string`)
  return value
}

async function authProvider(context: ConfigLoaderContext, options: OciVaultLoaderOptions): Promise<object> {
  if (options.authenticationDetailsProvider !== undefined) return options.authenticationDetailsProvider
  const common = await importOptionalPeer<OciCommonModule>(COMMON, LOADER)
  const auth =
    options.auth ??
    (setting(context, undefined, 'OCI_RESOURCE_PRINCIPAL_VERSION') === undefined ? 'config-file' : 'resource-principal')
  try {
    switch (auth) {
      case 'resource-principal':
        return common.ResourcePrincipalAuthenticationDetailsProvider.builder()
      case 'instance-principal':
        return await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build()
      default:
        return new common.ConfigFileAuthenticationDetailsProvider(
          setting(context, options.configFile, 'OCI_CONFIG_FILE'),
          setting(context, options.profile, 'OCI_CLI_PROFILE'),
        )
    }
  } catch (error) {
    throw new ConfigLoaderError(LOADER, `cannot set up the ${auth} authentication: ${errorMessage(error)}`, {
      hints:
        auth === 'config-file'
          ? ['Create the config file with "oci setup config", or pass { auth } on OCI (resource or instance principal)']
          : [],
      cause: error,
    })
  }
}

async function createClient(
  context: ConfigLoaderContext,
  options: OciVaultLoaderOptions,
): Promise<{ client: OciSecretsClientLike; owned: boolean }> {
  if (options.client !== undefined) return { client: options.client, owned: false }
  const sdk = await importOptionalPeer<OciSecretsModule>(SDK, LOADER)
  const provider = await authProvider(context, options)
  const client = new sdk.SecretsClient({ authenticationDetailsProvider: provider }, { ...options.clientConfig })
  if (options.region !== undefined) client.regionId = options.region
  if (options.endpoint !== undefined) client.endpoint = options.endpoint
  return { client, owned: true }
}

function decode(content: OciSecretBundleContentLike | undefined): string | undefined {
  if (typeof content?.content !== 'string') return undefined
  return content.contentType === undefined || content.contentType === 'BASE64'
    ? Buffer.from(content.content, 'base64').toString('utf8')
    : content.content
}

/**
 * Reads secrets from Oracle Cloud Infrastructure Vault, by OCID or by name in a vault. A JSON object
 * secret (`{"DB_PASSWORD": "..."}`) provides one value per entry; a plain secret provides one value
 * under its `key` (default: its `secretId`). Requires the optional peer dependencies `oci-secrets`
 * and `oci-common`, imported only when the loader runs without a `client`.
 *
 * ```ts
 * ociVault({ vaultId: 'ocid1.vault.oc1...', secretId: ['DB_PASSWORD', 'app-config'] })
 * ```
 */
export function ociVault(options: OciVaultLoaderOptions): ConfigLoader {
  if (typeof options !== 'object' || options === null) throw invalidConfig(`${WHERE}: options are required`)
  const secrets = normalizeSecrets<OciSecretRef & Record<string, unknown>>(WHERE, 'secretId', options.secretId, {
    json: options.json,
    optional: options.optional,
  })
  for (const { id, ref } of secrets) {
    if (!OCID.test(id) && !SECRET_NAME.test(id)) throw invalidConfig(`${WHERE}: invalid secret "${id}"`)
    const { versionNumber, stage } = ref
    if (versionNumber !== undefined && (!Number.isInteger(versionNumber) || versionNumber < 1)) {
      throw invalidConfig(`${WHERE}: "versionNumber" of "${id}" must be a positive integer`)
    }
    if (stage !== undefined && !STAGES.includes(stage)) {
      throw invalidConfig(`${WHERE}: "stage" of "${id}" must be one of ${STAGES.join(', ')}`)
    }
  }
  const vaultOption = optionalString('vaultId', options.vaultId)
  optionalString('region', options.region)
  optionalString('endpoint', options.endpoint)
  optionalString('configFile', options.configFile)
  optionalString('profile', options.profile)
  if (options.auth !== undefined && !AUTH.includes(options.auth)) {
    throw invalidConfig(`${WHERE}: "auth" must be one of ${AUTH.join(', ')}`)
  }
  const client = options.client
  if (
    client !== undefined &&
    (typeof client?.getSecretBundle !== 'function' || typeof client.getSecretBundleByName !== 'function')
  ) {
    throw invalidConfig(
      `${WHERE}: "client" must have getSecretBundle(request) and getSecretBundleByName(request) methods`,
    )
  }
  const timeoutMs = timeoutOption(WHERE, options.timeoutMs, 10_000)

  return {
    name: LOADER,
    async load(context) {
      const vaultId = setting(context, vaultOption, 'OCI_VAULT_ID')
      const byName = secrets.find(secret => !OCID.test(secret.id))
      if (byName !== undefined && vaultId === undefined) {
        throw new ConfigLoaderError(LOADER, `secret "${byName.id}" is read by name but no vault is set`, {
          hints: ['Pass { vaultId } or set OCI_VAULT_ID, or read the secret by its OCID'],
        })
      }
      const { client, owned } = await createClient(context, options)
      const read = async (
        secret: NormalizedSecret<OciSecretRef>,
        cancel: AbortSignal,
      ): Promise<ConfigLayer | undefined> => {
        const version: OciVersionRequest = {
          ...(secret.ref.versionNumber === undefined ? {} : { versionNumber: secret.ref.versionNumber }),
          ...(secret.ref.stage === undefined ? {} : { stage: secret.ref.stage }),
        }
        let response: OciSecretBundleResponseLike
        try {
          const request = OCID.test(secret.id)
            ? client.getSecretBundle({ secretId: secret.id, ...version })
            : client.getSecretBundleByName({ secretName: secret.id, vaultId: vaultId as string, ...version })
          response = await abortable(request, requestSignal(cancel, timeoutMs))
        } catch (error) {
          if (statusCode(error) === 404 && secret.optional) return undefined
          throw readError(LOADER, secret.id, error, {
            status: errorStatus(error),
            timeoutMs,
            hints: accessHints(error),
          })
        }
        const text = decode(response?.secretBundle?.secretBundleContent)
        if (text === undefined) throw noValueError(LOADER, secret.id)
        return secretLayer(`${LOADER}:${secret.id}`, secretValues(text, secret, secret.id))
      }
      try {
        return await readSecretLayers(secrets, read)
      } finally {
        if (owned) client.close?.()
      }
    },
  }
}
