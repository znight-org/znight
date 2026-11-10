import type { ConfigLayer } from '../source.ts'
import type { NormalizedSecret } from './secret-store.ts'
import type { ConfigLoader, ConfigLoaderContext } from './types.ts'

import { invalidConfig } from '../errors.ts'
import {
  abortable,
  errorProperty,
  normalizeSecrets,
  noValueError,
  readError,
  readSecretLayers,
  requestSignal,
  requireOptions,
  secretLayer,
  secretValues,
} from './secret-store.ts'
import { importOptionalPeer, setting, timeoutOption } from './shared.ts'

/** One secret read by {@link awsSecretsManager}. */
export interface AwsSecretRef {
  /** Name or ARN of the secret. */
  readonly secretId: string
  /**
   * Key path under which the secret is mounted. JSON object secrets are merged at the root by
   * default; plain (non-object) secrets are stored under `key`, default the `secretId`.
   */
  readonly key?: string
  readonly versionStage?: string
  readonly versionId?: string
  /** Expand a JSON object secret into one value per entry. Default: the loader `json` (`true`). */
  readonly json?: boolean
  /** Skip the secret when it does not exist (`ResourceNotFoundException`). Default: the loader `optional`. */
  readonly optional?: boolean
}

/** Input of `GetSecretValue`. */
export interface GetSecretValueInputLike {
  readonly SecretId: string
  readonly VersionStage?: string
  readonly VersionId?: string
}

/** Output of `GetSecretValue` used by the loader. */
export interface GetSecretValueOutputLike {
  readonly SecretString?: string | undefined
  readonly SecretBinary?: Uint8Array | undefined
}

/**
 * A Secrets Manager client: the aggregated `SecretsManager` client (or any object with
 * `getSecretValue`), or the modular `SecretsManagerClient` (`send(command)`).
 */
export interface SecretsManagerClientLike {
  getSecretValue?(
    input: GetSecretValueInputLike,
    options?: { abortSignal?: AbortSignal },
  ): Promise<GetSecretValueOutputLike>
  send?(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<GetSecretValueOutputLike>
  destroy?(): void
}

/** Options of {@link awsSecretsManager}. */
export interface AwsSecretsManagerLoaderOptions {
  /** Secrets to read, in precedence order (later secrets override earlier ones). */
  readonly secretId: string | AwsSecretRef | readonly (string | AwsSecretRef)[]
  /** AWS region. Default: `AWS_REGION` / `AWS_DEFAULT_REGION` (previous loaders, environment), then the SDK chain. */
  readonly region?: string
  /** Client to use (tests, custom credentials). Default: a `SecretsManagerClient` from `@aws-sdk/client-secrets-manager`. */
  readonly client?: SecretsManagerClientLike
  /** Extra configuration of the default client (`endpoint`, `credentials`, `maxAttempts`...). */
  readonly clientConfig?: Readonly<Record<string, unknown>>
  /** Expand JSON object secrets into one value per entry. Default: `true`. */
  readonly json?: boolean
  /** Skip every secret that does not exist. Default: `false`. */
  readonly optional?: boolean
  /** Timeout of each request, in milliseconds. Default: `10000`. */
  readonly timeoutMs?: number
}

interface SecretsManagerModule {
  SecretsManagerClient: new (config: Record<string, unknown>) => SecretsManagerClientLike
  GetSecretValueCommand: new (input: GetSecretValueInputLike) => unknown
}

const SDK = '@aws-sdk/client-secrets-manager'
const LOADER = 'aws-secrets-manager'
const WHERE = 'awsSecretsManager()'

function secretText(output: GetSecretValueOutputLike): string | undefined {
  if (typeof output.SecretString === 'string') return output.SecretString
  if (output.SecretBinary instanceof Uint8Array) return new TextDecoder().decode(output.SecretBinary)
  return undefined
}

/** The SDK exception name (`ResourceNotFoundException`), `undefined` for a plain `Error`. */
function errorName(error: unknown): string | undefined {
  const name = errorProperty(error, 'name')
  return typeof name === 'string' && name !== 'Error' ? name : undefined
}

const CREDENTIALS_HINT =
  'Check the AWS credentials: the default chain reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, AWS_PROFILE (shared config, SSO), web identity and the container or instance role; or pass clientConfig.credentials'

/** Exceptions of a missing, invalid or expired identity. */
const CREDENTIALS_ERRORS: ReadonlySet<string> = new Set([
  'CredentialsProviderError',
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'InvalidSignatureException',
  'ExpiredTokenException',
  'ExpiredToken',
])

function accessHints(error: unknown): string[] {
  const name = errorName(error)
  switch (name) {
    case 'AccessDeniedException':
      return [
        'Allow secretsmanager:GetSecretValue on the secret to the identity the application runs as (and kms:Decrypt on its key when the secret uses a customer managed KMS key)',
      ]
    case 'ResourceNotFoundException':
      return ['Check the secret name or ARN and the region, or mark the secret optional']
    case 'DecryptionFailure':
      return [
        'Secrets Manager cannot decrypt the secret: allow kms:Decrypt on its KMS key to the identity the application runs as',
      ]
    default:
      return name !== undefined && CREDENTIALS_ERRORS.has(name) ? [CREDENTIALS_HINT] : []
  }
}

async function createClient(
  context: ConfigLoaderContext,
  options: AwsSecretsManagerLoaderOptions,
): Promise<{ client: SecretsManagerClientLike; owned: boolean; sdk: SecretsManagerModule | undefined }> {
  if (options.client !== undefined) {
    const client = options.client
    const sdk =
      typeof client.getSecretValue === 'function'
        ? undefined
        : await importOptionalPeer<SecretsManagerModule>(SDK, LOADER)
    return { client, owned: false, sdk }
  }
  const sdk = await importOptionalPeer<SecretsManagerModule>(SDK, LOADER)
  const region =
    options.region ?? setting(context, undefined, 'AWS_REGION') ?? setting(context, undefined, 'AWS_DEFAULT_REGION')
  const config: Record<string, unknown> = { ...options.clientConfig }
  if (region !== undefined) config['region'] = region
  return { client: new sdk.SecretsManagerClient(config), owned: true, sdk }
}

/**
 * Reads secrets from AWS Secrets Manager. A JSON object secret (`{"DB_PASSWORD": "..."}`) provides
 * one value per entry; a plain secret provides one value under its `key` (default: its id).
 * Requires the optional peer dependency `@aws-sdk/client-secrets-manager`, imported only when the
 * loader runs (unless a client with `getSecretValue` is given).
 *
 * ```ts
 * awsSecretsManager({ secretId: ['prod/app', { secretId: 'prod/db-password', key: 'DB_PASSWORD' }] })
 * ```
 */
export function awsSecretsManager(options: AwsSecretsManagerLoaderOptions): ConfigLoader {
  requireOptions(WHERE, options)
  const secrets = normalizeSecrets<AwsSecretRef & Record<string, unknown>>(WHERE, 'secretId', options.secretId, {
    json: options.json,
    optional: options.optional,
  })
  const client = options.client
  if (client !== undefined && typeof client?.getSecretValue !== 'function' && typeof client?.send !== 'function') {
    throw invalidConfig(`${WHERE}: "client" must have a getSecretValue(input) or send(command) method`)
  }
  const timeoutMs = timeoutOption(WHERE, options.timeoutMs, 10_000)

  return {
    name: LOADER,
    async load(context) {
      const { client, owned, sdk } = await createClient(context, options)
      const fetchSecret = (ref: AwsSecretRef, signal: AbortSignal): Promise<GetSecretValueOutputLike> => {
        const input: GetSecretValueInputLike = {
          SecretId: ref.secretId,
          ...(ref.versionStage === undefined ? {} : { VersionStage: ref.versionStage }),
          ...(ref.versionId === undefined ? {} : { VersionId: ref.versionId }),
        }
        const requestOptions = { abortSignal: signal }
        if (typeof client.getSecretValue === 'function') return client.getSecretValue(input, requestOptions)
        // createClient guarantees `send` and the SDK otherwise
        const { send } = client as Required<Pick<SecretsManagerClientLike, 'send'>>
        const command = new (sdk as SecretsManagerModule).GetSecretValueCommand(input)
        return send.call(client, command, requestOptions)
      }
      const read = async (
        secret: NormalizedSecret<AwsSecretRef>,
        cancel: AbortSignal,
      ): Promise<ConfigLayer | undefined> => {
        let output: GetSecretValueOutputLike
        try {
          const signal = requestSignal(cancel, timeoutMs)
          output = await abortable(fetchSecret(secret.ref, signal), signal)
        } catch (error) {
          if (errorName(error) === 'ResourceNotFoundException' && secret.optional) return undefined
          throw readError(LOADER, secret.id, error, { status: errorName(error), timeoutMs, hints: accessHints(error) })
        }
        const text = secretText(output ?? {})
        if (text === undefined) throw noValueError(LOADER, secret.id)
        return secretLayer(`${LOADER}:${secret.id}`, secretValues(text, secret, secret.id))
      }
      try {
        return await readSecretLayers(secrets, read)
      } finally {
        if (owned) client.destroy?.()
      }
    },
  }
}
