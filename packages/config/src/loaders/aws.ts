import type { ConfigLayer } from '../source.ts'
import type { ConfigLoader, ConfigLoaderContext } from './types.ts'

import { ConfigLoaderError, errorMessage, invalidConfig } from '../errors.ts'
import { nestUnder } from '../source.ts'
import { importOptionalPeer, isRecord, setting } from './shared.ts'

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
  /** Skip the secret when it does not exist (`ResourceNotFoundException`). */
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

function normalizeRefs(secretId: AwsSecretsManagerLoaderOptions['secretId']): AwsSecretRef[] {
  const items = Array.isArray(secretId)
    ? (secretId as readonly (string | AwsSecretRef)[])
    : [secretId as string | AwsSecretRef]
  const refs = items.map(item => (typeof item === 'string' ? { secretId: item } : item))
  if (
    refs.length === 0 ||
    refs.some(ref => !isRecord(ref) || typeof ref.secretId !== 'string' || ref.secretId === '')
  ) {
    throw invalidConfig(
      'awsSecretsManager(): "secretId" must be a non-empty string, a { secretId } object or an array of them',
    )
  }
  return refs
}

function secretText(output: GetSecretValueOutputLike): string | undefined {
  if (typeof output.SecretString === 'string') return output.SecretString
  if (output.SecretBinary instanceof Uint8Array) return new TextDecoder().decode(output.SecretBinary)
  return undefined
}

/** JSON object secrets are key/value maps; anything else is a single value. */
function secretValues(ref: AwsSecretRef, text: string): Readonly<Record<string, unknown>> {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed)) return nestUnder(parsed, ref.key)
    } catch {
      // not JSON: a plain secret starting with "{"
    }
  }
  return { [ref.key ?? ref.secretId]: text }
}

function errorName(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null)?.name
  return typeof name === 'string' ? name : undefined
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
  const refs = normalizeRefs(options?.secretId)
  const client = options.client
  if (client !== undefined && typeof client?.getSecretValue !== 'function' && typeof client?.send !== 'function') {
    throw invalidConfig('awsSecretsManager(): "client" must have a getSecretValue(input) or send(command) method')
  }
  const timeoutMs = options.timeoutMs ?? 10_000

  return {
    name: LOADER,
    async load(context) {
      const { client, owned, sdk } = await createClient(context, options)
      const fetchSecret = (ref: AwsSecretRef): Promise<GetSecretValueOutputLike> => {
        const input: GetSecretValueInputLike = {
          SecretId: ref.secretId,
          ...(ref.versionStage === undefined ? {} : { VersionStage: ref.versionStage }),
          ...(ref.versionId === undefined ? {} : { VersionId: ref.versionId }),
        }
        const requestOptions = { abortSignal: AbortSignal.timeout(timeoutMs) }
        if (typeof client.getSecretValue === 'function') return client.getSecretValue(input, requestOptions)
        // createClient guarantees `send` and the SDK otherwise
        const { send } = client as Required<Pick<SecretsManagerClientLike, 'send'>>
        const command = new (sdk as SecretsManagerModule).GetSecretValueCommand(input)
        return send.call(client, command, requestOptions)
      }
      const read = async (ref: AwsSecretRef): Promise<ConfigLayer | undefined> => {
        let output: GetSecretValueOutputLike
        try {
          output = await fetchSecret(ref)
        } catch (error) {
          if (errorName(error) === 'ResourceNotFoundException' && (ref.optional ?? options.optional) === true) {
            return undefined
          }
          if (error instanceof ConfigLoaderError) throw error
          const name = errorName(error)
          const prefix = name === undefined || name === 'Error' ? '' : `${name}: `
          throw new ConfigLoaderError(LOADER, `cannot read secret "${ref.secretId}": ${prefix}${errorMessage(error)}`, {
            cause: error,
          })
        }
        const text = secretText(output ?? {})
        if (text === undefined) throw new ConfigLoaderError(LOADER, `secret "${ref.secretId}" has no value`)
        return { origin: `aws-secrets-manager:${ref.secretId}`, values: secretValues(ref, text) }
      }
      try {
        const layers = await Promise.all(refs.map(read))
        return layers.filter((layer): layer is ConfigLayer => layer !== undefined)
      } finally {
        if (owned) client.destroy?.()
      }
    },
  }
}
