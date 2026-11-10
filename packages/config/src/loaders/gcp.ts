import type { ConfigLayer } from '../source.ts'
import type { NormalizedSecret } from './secret-store.ts'
import type { ConfigLoader, ConfigLoaderContext } from './types.ts'

import { ConfigLoaderError, errorMessage, invalidConfig } from '../errors.ts'
import {
  abortable,
  errorProperty,
  isTimeout,
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

/** One secret read by {@link gcpSecretManager}. */
export interface GcpSecretRef {
  /**
   * Secret id (`DB_PASSWORD`, in the loader's project) or resource name
   * (`projects/<project>/secrets/<id>`, `projects/<project>/locations/<location>/secrets/<id>`,
   * optionally followed by `/versions/<version>`). A resource name is in the loader's `location`
   * (global without it): each location has its own endpoint.
   */
  readonly secretId: string
  /** Version or alias. Default: the version of the resource name, else `latest`. */
  readonly version?: string
  /**
   * Key path under which the secret is mounted. JSON object secrets are merged at the root by
   * default; plain (non-object) secrets are stored under `key`, default the secret id.
   */
  readonly key?: string
  /** Expand a JSON object secret into one value per entry. Default: the loader `json` (`true`). */
  readonly json?: boolean
  /** Skip the secret when it does not exist or has no version (`NOT_FOUND`). Default: the loader `optional`. */
  readonly optional?: boolean
}

/** Payload of a secret version, as returned by `accessSecretVersion`. */
export interface GcpSecretPayloadLike {
  readonly data?: Uint8Array | string | null
}

/** Response of `accessSecretVersion` used by the loader. */
export interface AccessSecretVersionResponseLike {
  readonly name?: string | null
  readonly payload?: GcpSecretPayloadLike | null
}

/**
 * A Secret Manager client: the `SecretManagerServiceClient` of `@google-cloud/secret-manager`, or
 * any object with the same methods (tests, wrappers).
 */
export interface SecretManagerServiceClientLike {
  accessSecretVersion(
    request: { name: string },
    options?: { timeout?: number },
  ): Promise<readonly [AccessSecretVersionResponseLike, ...unknown[]]>
  getProjectId?(): Promise<string>
  close?(): Promise<void>
}

/** Options of {@link gcpSecretManager}. */
export interface GcpSecretManagerLoaderOptions {
  /** Secrets to read, in precedence order (later secrets override earlier ones). */
  readonly secretId: string | GcpSecretRef | readonly (string | GcpSecretRef)[]
  /** Project of secret ids. Default: `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` (previous loaders, environment), then the client's. */
  readonly projectId?: string
  /**
   * Location of regional secrets (`europe-west1`): regional names and endpoint. Every resource name
   * of `secretId` must be in this location (global without it). Default: global secrets.
   */
  readonly location?: string
  /** Client to use (tests, custom credentials). Default: a `SecretManagerServiceClient`. */
  readonly client?: SecretManagerServiceClientLike
  /** Extra options of the default client (`credentials`, `keyFilename`, `apiEndpoint`, `port`, `fallback`...). */
  readonly clientConfig?: Readonly<Record<string, unknown>>
  /** Expand JSON object secrets into one value per entry. Default: `true`. */
  readonly json?: boolean
  /** Skip every secret that does not exist or has no version. Default: `false`. */
  readonly optional?: boolean
  /** Timeout of each request, in milliseconds. Default: `10000`. */
  readonly timeoutMs?: number
}

interface SecretManagerModule {
  SecretManagerServiceClient?: new (options: Record<string, unknown>) => SecretManagerServiceClientLike
  default?: { SecretManagerServiceClient?: new (options: Record<string, unknown>) => SecretManagerServiceClientLike }
}

/** A secret to read, before the project is known. */
interface Target extends NormalizedSecret<GcpSecretRef> {
  /** The secret id: the default key of a plain value. */
  readonly secretName: string
  /** `projects/<project>[/locations/<location>]/secrets/<id>`, `undefined` for an id of the loader's project. */
  readonly resource: string | undefined
  /** Location of a regional resource name, `undefined` for a global one or an id. */
  readonly location: string | undefined
  readonly version: string
}

const SDK = '@google-cloud/secret-manager'
const LOADER = 'gcp-secret-manager'
const WHERE = 'gcpSecretManager()'

const SECRET_ID = /^[\w-]{1,255}$/
const RESOURCE_NAME = /^(projects\/[^/]+\/(?:locations\/([^/]+)\/)?secrets\/([\w-]{1,255}))(?:\/versions\/([^/]+))?$/
const VERSION = /^[\w-]+$/
const SEGMENT = /^[^/\s]+$/

/** gRPC status names, by code. */
const STATUS = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const
const NOT_FOUND = 5
const PERMISSION_DENIED = 7
const FAILED_PRECONDITION = 9
const UNAUTHENTICATED = 16

const CREDENTIALS_HINT =
  'Set up Application Default Credentials: gcloud auth application-default login locally, a service account (workload identity, GOOGLE_APPLICATION_CREDENTIALS) elsewhere'

function optionalString(name: string, value: unknown, pattern?: RegExp): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '' || (pattern !== undefined && !pattern.test(value))) {
    throw invalidConfig(`${WHERE}: invalid "${name}" ${JSON.stringify(value)}`)
  }
  return value
}

function toTarget(secret: NormalizedSecret<GcpSecretRef>, location: string | undefined): Target {
  const resource = RESOURCE_NAME.exec(secret.id)
  if (resource === null && !SECRET_ID.test(secret.id)) {
    throw invalidConfig(
      `${WHERE}: invalid secret "${secret.id}"; expected a secret id (letters, digits, "_" and "-") or "projects/<project>/secrets/<id>"`,
    )
  }
  const refVersion = optionalString(`version" of "${secret.id}`, secret.ref.version, VERSION)
  if (refVersion !== undefined && resource?.[4] !== undefined) {
    throw invalidConfig(`${WHERE}: secret "${secret.id}" names a version and sets "version"`)
  }
  const target: Target = {
    ...secret,
    secretName: resource?.[3] ?? secret.id,
    resource: resource?.[1],
    location: resource?.[2],
    version: resource?.[4] ?? refVersion ?? 'latest',
  }
  if (target.resource !== undefined && target.location !== location) throw locationMismatch(target, location)
  return target
}

/**
 * A resource name outside the loader's location: a regional secret is only served by the endpoint
 * of its location, a global one by the global endpoint, and a loader talks to one endpoint.
 */
function locationMismatch(target: Target, location: string | undefined): Error {
  const where = (value: string | undefined): string =>
    value === undefined ? 'global secrets' : `secrets of location "${value}"`
  const fix =
    target.location === undefined
      ? 'Remove "location" to read global secrets'
      : `Set location: '${target.location}' (endpoint secretmanager.${target.location}.rep.googleapis.com)`
  return invalidConfig(`${WHERE}: secret "${target.id}" is not in the loader's location: it reads ${where(location)}`, [
    `${fix}, and read the secrets of each location with its own gcpSecretManager()`,
  ])
}

function grpcCode(error: unknown): number | undefined {
  const code = errorProperty(error, 'code')
  return typeof code === 'number' ? code : undefined
}

/** The gRPC status name of an error (`PERMISSION_DENIED`), `undefined` when unknown. */
function grpcStatus(error: unknown): string | undefined {
  const code = grpcCode(error)
  return code === undefined ? undefined : STATUS[code]
}

function credentialsHints(error: unknown): string[] {
  return grpcCode(error) === UNAUTHENTICATED || /default credentials/i.test(errorMessage(error))
    ? [CREDENTIALS_HINT]
    : []
}

function accessHints(error: unknown, target: Target): string[] {
  switch (grpcCode(error)) {
    case PERMISSION_DENIED:
      return [
        'Grant roles/secretmanager.secretAccessor on the secret (or its project) to the identity the application runs as',
      ]
    case NOT_FOUND:
      return ['Check the secret name and its project, or mark the secret optional']
    case FAILED_PRECONDITION:
      return [`Version "${target.version}" is disabled or destroyed: enable it, or read another version`]
    default:
      return credentialsHints(error)
  }
}

async function createClient(
  options: GcpSecretManagerLoaderOptions,
  projectId: string | undefined,
): Promise<{ client: SecretManagerServiceClientLike; owned: boolean }> {
  if (options.client !== undefined) return { client: options.client, owned: false }
  const sdk = await importOptionalPeer<SecretManagerModule>(SDK, LOADER)
  const Client = sdk.SecretManagerServiceClient ?? sdk.default?.SecretManagerServiceClient
  if (Client === undefined) throw new ConfigLoaderError(LOADER, `"${SDK}" does not export SecretManagerServiceClient`)
  const clientOptions: Record<string, unknown> = { ...options.clientConfig }
  if (projectId !== undefined) clientOptions['projectId'] ??= projectId
  if (options.location !== undefined) {
    clientOptions['apiEndpoint'] ??= `secretmanager.${options.location}.rep.googleapis.com`
  }
  return { client: new Client(clientOptions), owned: true }
}

/**
 * Reads secrets from Google Cloud Secret Manager, version `latest` by default. A JSON object secret
 * (`{"DB_PASSWORD": "..."}`) provides one value per entry; a plain secret provides one value under
 * its `key` (default: its id, so `DB_PASSWORD` matches `@Secret('DB_PASSWORD')`). Requires the
 * optional peer dependency `@google-cloud/secret-manager`, imported only when the loader runs
 * without a `client`.
 *
 * ```ts
 * gcpSecretManager({ secretId: ['DB_PASSWORD', { secretId: 'smtp', key: 'mail' }] })
 * ```
 */
export function gcpSecretManager(options: GcpSecretManagerLoaderOptions): ConfigLoader {
  requireOptions(WHERE, options)
  const projectOption = optionalString('projectId', options.projectId, SEGMENT)
  const location = optionalString('location', options.location, SEGMENT)
  const targets = normalizeSecrets<GcpSecretRef & Record<string, unknown>>(WHERE, 'secretId', options.secretId, {
    json: options.json,
    optional: options.optional,
  }).map(secret => toTarget(secret, location))
  const client = options.client
  if (client !== undefined && typeof client?.accessSecretVersion !== 'function') {
    throw invalidConfig(`${WHERE}: "client" must have an accessSecretVersion(request) method`)
  }
  const timeoutMs = timeoutOption(WHERE, options.timeoutMs, 10_000)

  const resolveProject = async (client: SecretManagerServiceClientLike, project: string | undefined) => {
    if (project !== undefined) return project
    const hints = ['Set the "projectId" option, or GOOGLE_CLOUD_PROJECT (environment or a previous loader)']
    if (typeof client.getProjectId !== 'function') {
      throw new ConfigLoaderError(LOADER, 'cannot determine the Google Cloud project', { hints })
    }
    let found: unknown
    try {
      found = await abortable(client.getProjectId(), AbortSignal.timeout(timeoutMs))
    } catch (error) {
      const reason = isTimeout(error) ? `timed out after ${timeoutMs} ms` : errorMessage(error)
      throw new ConfigLoaderError(LOADER, `cannot determine the Google Cloud project: ${reason}`, {
        hints: [...hints, ...credentialsHints(error)],
        cause: error,
      })
    }
    if (typeof found !== 'string' || found === '') {
      throw new ConfigLoaderError(LOADER, 'cannot determine the Google Cloud project', { hints })
    }
    return found
  }

  const read = async (
    client: SecretManagerServiceClientLike,
    target: Target,
    parent: string,
    cancel: AbortSignal,
  ): Promise<ConfigLayer | undefined> => {
    const name = `${target.resource ?? `${parent}/secrets/${target.secretName}`}/versions/${target.version}`
    let response: AccessSecretVersionResponseLike | undefined
    try {
      const request = client.accessSecretVersion({ name }, { timeout: timeoutMs })
      ;[response] = await abortable(request, requestSignal(cancel, timeoutMs))
    } catch (error) {
      if (grpcCode(error) === NOT_FOUND && target.optional) return undefined
      throw readError(LOADER, target.id, error, {
        status: grpcStatus(error),
        timeoutMs,
        hints: accessHints(error, target),
        // google-gax messages start with `<code> <STATUS>: `, which the status already says
        message: errorMessage(error).replace(/^\d+ [A-Z_]+: /, ''),
      })
    }
    const data = response?.payload?.data
    if (data === undefined || data === null) throw noValueError(LOADER, target.id)
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    return secretLayer(`${LOADER}:${target.id}`, secretValues(text, target, target.secretName))
  }

  return {
    name: LOADER,
    async load(context: ConfigLoaderContext) {
      const projectSetting =
        projectOption ??
        setting(context, undefined, 'GOOGLE_CLOUD_PROJECT') ??
        setting(context, undefined, 'GCLOUD_PROJECT')
      const { client, owned } = await createClient(options, projectSetting)
      try {
        const needsProject = targets.some(target => target.resource === undefined)
        const project = needsProject ? await resolveProject(client, projectSetting) : undefined
        const parent = `projects/${project}${location === undefined ? '' : `/locations/${location}`}`
        return await readSecretLayers(targets, (target, cancel) => read(client, target, parent, cancel))
      } finally {
        if (owned) await client.close?.().catch(() => undefined)
      }
    },
  }
}
