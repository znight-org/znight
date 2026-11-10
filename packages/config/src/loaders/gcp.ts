import type { ConfigLayer } from '../source.ts'
import type { ConfigLoader, ConfigLoaderContext } from './types.ts'

import { ConfigLoaderError, errorMessage, invalidConfig } from '../errors.ts'
import { nestUnder } from '../source.ts'
import { importOptionalPeer, isRecord, readAll, setting, timeoutOption } from './shared.ts'

/** One secret read by {@link gcpSecretManager}. */
export interface GcpSecretRef {
  /**
   * Secret id (`DB_PASSWORD`, in the loader's project) or resource name
   * (`projects/<project>/secrets/<id>`, `projects/<project>/locations/<location>/secrets/<id>`,
   * optionally followed by `/versions/<version>`). A resource name is in the loader's `location`
   * (global without it): each location has its own endpoint.
   */
  readonly name: string
  /** Version or alias. Default: the version of the name, then the loader `version` (`latest`). */
  readonly version?: string
  /**
   * Key under which the value is stored. Default: the secret id, without the loader `stripPrefix`,
   * through the loader `mapKey`. A JSON object secret read with `json` is mounted under it (merged
   * at the root without it).
   */
  readonly key?: string
  /** Expand a JSON object value into one value per entry. Default: the loader `json`. */
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

/** A secret listed by `listSecrets` (its resource name, with the project number). */
export interface GcpSecretLike {
  readonly name?: string | null
}

/**
 * A Secret Manager client: the `SecretManagerServiceClient` of `@google-cloud/secret-manager`, or
 * any object with the same methods (tests, wrappers). `listSecrets` is needed to read secrets by
 * label or filter.
 */
export interface SecretManagerServiceClientLike {
  accessSecretVersion(
    request: { name: string },
    options?: { timeout?: number },
  ): Promise<readonly [AccessSecretVersionResponseLike, ...unknown[]]>
  listSecrets?(
    request: { parent: string; filter?: string },
    options?: { timeout?: number; autoPaginate?: boolean },
  ): Promise<readonly [readonly GcpSecretLike[], ...unknown[]]>
  getProjectId?(): Promise<string>
  close?(): Promise<void>
}

/** Options of {@link gcpSecretManager}. */
export interface GcpSecretManagerLoaderOptions {
  /** Secrets to read by name, in precedence order: later secrets override earlier ones, and listed ones. */
  readonly secrets?: string | GcpSecretRef | readonly (string | GcpSecretRef)[]
  /** Reads every secret of the project carrying these labels (`{ app: 'api' }` → `labels.app=api`). */
  readonly labels?: Readonly<Record<string, string>>
  /** Reads every secret matching this `listSecrets` filter (`name:PROD_`), combined with `labels`. */
  readonly filter?: string
  /** Project of secret ids and listings. Default: `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT`, then the client's. */
  readonly projectId?: string
  /**
   * Location of regional secrets (`europe-west1`): regional names and endpoint. Every resource name
   * of `secrets` must be in this location (global without it). Default: global secrets.
   */
  readonly location?: string
  /** Version or alias of every secret. Default: `latest`. */
  readonly version?: string
  /** Removed from the start of the secret ids to build the keys (`PROD_DB_PASSWORD` → `DB_PASSWORD`). */
  readonly stripPrefix?: string
  /** Builds the key of a secret from its id (after `stripPrefix`). Default: the id itself. */
  readonly mapKey?: (secretId: string) => string
  /** Expand JSON object values into one value per entry. Default: `false` (values are kept as text). */
  readonly json?: boolean
  /** Skip the secrets that do not exist or have no version. Default: `false`. */
  readonly optional?: boolean
  /** Client to use (tests, custom credentials). Default: a `SecretManagerServiceClient`. */
  readonly client?: SecretManagerServiceClientLike
  /** Extra options of the default client (`credentials`, `keyFilename`, `apiEndpoint`, `port`, `fallback`...). */
  readonly clientOptions?: Readonly<Record<string, unknown>>
  /** Timeout of each request, in milliseconds. Default: `10000`. */
  readonly timeoutMs?: number
}

interface SecretManagerModule {
  SecretManagerServiceClient?: new (options: Record<string, unknown>) => SecretManagerServiceClientLike
  default?: { SecretManagerServiceClient?: new (options: Record<string, unknown>) => SecretManagerServiceClientLike }
}

/** A secret to read, before the project is known. */
interface Target {
  /** Name shown in messages and origins: the name as given, or the id of a listed secret. */
  readonly label: string
  readonly id: string
  /** `projects/<project>[/locations/<location>]/secrets/<id>`, `undefined` for an id of the loader's project. */
  readonly secret: string | undefined
  /** Location of a regional resource name, `undefined` for a global one or an id. */
  readonly location: string | undefined
  readonly version: string
  readonly key: string | undefined
  readonly json: boolean
  readonly optional: boolean
}

/** A {@link Target} of a known project: its version's resource name and the key of its value. */
interface KeyedTarget extends Target {
  /** `projects/<project>[/locations/<location>]/secrets/<id>/versions/<version>`. */
  readonly name: string
  /** Key of a plain value: the ref `key`, else the id through `stripPrefix` and `mapKey`. */
  readonly valueKey: string
}

const SDK = '@google-cloud/secret-manager'
const LOADER = 'gcp-secret-manager'
const WHERE = 'gcpSecretManager()'

const SECRET_ID = /^[\w-]{1,255}$/
const RESOURCE_NAME = /^(projects\/[^/]+\/(?:locations\/([^/]+)\/)?secrets\/([\w-]{1,255}))(?:\/versions\/([^/]+))?$/
const VERSION = /^[\w-]+$/
const SEGMENT = /^[^/\s]+$/
const LABEL_KEY = /^[\p{Ll}\p{Lo}][\p{Ll}\p{Lo}\p{N}_-]{0,62}$/u
const LABEL_VALUE = /^[\p{Ll}\p{Lo}\p{N}_-]{1,63}$/u

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

function optionalBoolean(name: string, value: unknown): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value
  throw invalidConfig(`${WHERE}: "${name}" must be a boolean`)
}

function normalizeTarget(item: unknown, options: GcpSecretManagerLoaderOptions): Target {
  let ref: Partial<GcpSecretRef> = {}
  if (typeof item === 'string') ref = { name: item }
  else if (isRecord(item)) ref = item
  const name = ref.name
  if (typeof name !== 'string' || name === '') {
    throw invalidConfig(
      `${WHERE}: "secrets" must be a non-empty secret name, a { name } object or an array of them, got ${JSON.stringify(item)}`,
    )
  }
  const resource = RESOURCE_NAME.exec(name)
  if (resource === null && !SECRET_ID.test(name)) {
    throw invalidConfig(
      `${WHERE}: invalid secret name "${name}"; expected a secret id (letters, digits, "_" and "-") or "projects/<project>/secrets/<id>"`,
    )
  }
  const refVersion = optionalString(`version" of "${name}`, ref.version, VERSION)
  if (refVersion !== undefined && resource?.[4] !== undefined) {
    throw invalidConfig(`${WHERE}: secret "${name}" names a version and sets "version"`)
  }
  return {
    label: name,
    id: resource?.[3] ?? name,
    secret: resource?.[1],
    location: resource?.[2],
    version: resource?.[4] ?? refVersion ?? options.version ?? 'latest',
    key: optionalString(`key" of "${name}`, ref.key),
    json: optionalBoolean(`json" of "${name}`, ref.json) ?? options.json === true,
    optional: optionalBoolean(`optional" of "${name}`, ref.optional) ?? options.optional === true,
  }
}

function normalizeTargets(
  secrets: GcpSecretManagerLoaderOptions['secrets'],
  options: GcpSecretManagerLoaderOptions,
): Target[] {
  if (secrets === undefined) return []
  const items: readonly unknown[] = Array.isArray(secrets) ? secrets : [secrets]
  const targets = items.map(item => normalizeTarget(item, options))
  for (const target of targets) {
    if (target.secret !== undefined && target.location !== options.location) {
      throw locationMismatch(target, options.location)
    }
  }
  return targets
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
  return invalidConfig(
    `${WHERE}: secret "${target.label}" is not in the loader's location: it reads ${where(location)}`,
    [`${fix}, and read the secrets of each location with its own gcpSecretManager()`],
  )
}

/** The `listSecrets` filter of the `labels` and `filter` options, `undefined` without discovery. */
function listFilter(options: GcpSecretManagerLoaderOptions): string | undefined {
  const parts: string[] = []
  if (options.labels !== undefined) {
    const labels: unknown = options.labels
    if (!isRecord(labels) || Object.keys(labels).length === 0) {
      throw invalidConfig(`${WHERE}: "labels" must be an object with at least one label`)
    }
    for (const [key, value] of Object.entries(labels)) {
      if (!LABEL_KEY.test(key) || typeof value !== 'string' || !LABEL_VALUE.test(value)) {
        throw invalidConfig(
          `${WHERE}: invalid label ${JSON.stringify(key)}=${JSON.stringify(value)}; labels use lowercase letters, digits, "_" and "-"`,
        )
      }
      parts.push(`labels.${key}=${value}`)
    }
  }
  const filter = optionalString('filter', options.filter)
  if (filter !== undefined) parts.push(parts.length === 0 ? filter : `(${filter})`)
  return parts.length === 0 ? undefined : parts.join(' AND ')
}

function grpcCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

/** `PERMISSION_DENIED: <message>` for gRPC errors (whose message may start with `7 PERMISSION_DENIED: `). */
function describeError(error: unknown, timeoutMs: number): string {
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return `timed out after ${timeoutMs} ms`
  const message = errorMessage(error).replace(/^\d+ [A-Z_]+: /, '')
  const code = grpcCode(error)
  const status = code === undefined ? undefined : STATUS[code]
  return status === undefined ? message : `${status}: ${message}`
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

function listHints(error: unknown): string[] {
  return grpcCode(error) === PERMISSION_DENIED
    ? ['Listing secrets needs the secretmanager.secrets.list permission (roles/secretmanager.viewer) on the project']
    : credentialsHints(error)
}

/** Settles like `promise`, or rejects with the reason of `signal` once it is aborted. */
function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason as Error)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error as Error)
      },
    )
  })
}

async function createClient(
  options: GcpSecretManagerLoaderOptions,
  projectId: string | undefined,
): Promise<{ client: SecretManagerServiceClientLike; owned: boolean }> {
  if (options.client !== undefined) return { client: options.client, owned: false }
  const sdk = await importOptionalPeer<SecretManagerModule>(SDK, LOADER)
  const Client = sdk.SecretManagerServiceClient ?? sdk.default?.SecretManagerServiceClient
  if (Client === undefined) throw new ConfigLoaderError(LOADER, `"${SDK}" does not export SecretManagerServiceClient`)
  const clientOptions: Record<string, unknown> = { ...options.clientOptions }
  if (projectId !== undefined) clientOptions['projectId'] ??= projectId
  if (options.location !== undefined) {
    clientOptions['apiEndpoint'] ??= `secretmanager.${options.location}.rep.googleapis.com`
  }
  return { client: new Client(clientOptions), owned: true }
}

/**
 * Reads secrets from Google Cloud Secret Manager, by name and/or by label: one value per secret,
 * under its id (`DB_PASSWORD` matches `@Secret('DB_PASSWORD')`), version `latest` by default.
 * Requires the optional peer dependency `@google-cloud/secret-manager`, imported only when the
 * loader runs without a `client`.
 *
 * ```ts
 * gcpSecretManager({ labels: { app: 'api', env: 'prod' }, stripPrefix: 'PROD_' })
 * ```
 */
export function gcpSecretManager(options: GcpSecretManagerLoaderOptions): ConfigLoader {
  if (typeof options !== 'object' || options === null) {
    throw invalidConfig(`${WHERE}: options are required ({ secrets } and/or { labels })`)
  }
  const projectOption = optionalString('projectId', options.projectId, SEGMENT)
  const location = optionalString('location', options.location, SEGMENT)
  optionalString('version', options.version, VERSION)
  const stripPrefix = optionalString('stripPrefix', options.stripPrefix)
  const mapKey = options.mapKey
  if (mapKey !== undefined && typeof mapKey !== 'function') throw invalidConfig(`${WHERE}: "mapKey" must be a function`)
  optionalBoolean('json', options.json)
  optionalBoolean('optional', options.optional)
  const explicit = normalizeTargets(options.secrets, options)
  const filter = listFilter(options)
  if (explicit.length === 0 && filter === undefined) {
    throw invalidConfig(`${WHERE}: set "secrets", "labels" or "filter"`)
  }
  const client = options.client
  if (client !== undefined) {
    if (typeof client?.accessSecretVersion !== 'function') {
      throw invalidConfig(`${WHERE}: "client" must have an accessSecretVersion(request) method`)
    }
    if (filter !== undefined && typeof client.listSecrets !== 'function') {
      throw invalidConfig(
        `${WHERE}: "client" must have a listSecrets(request) method to read secrets by label or filter`,
      )
    }
  }
  const timeoutMs = timeoutOption(WHERE, options.timeoutMs, 10_000)

  const keyOf = (target: Target): string => {
    if (target.key !== undefined) return target.key
    const id =
      stripPrefix !== undefined && target.id.startsWith(stripPrefix) ? target.id.slice(stripPrefix.length) : target.id
    const key = mapKey === undefined ? id : mapKey(id)
    if (typeof key !== 'string' || key === '') {
      throw invalidConfig(`${WHERE}: "mapKey" must return a non-empty string, got ${JSON.stringify(key)} for "${id}"`)
    }
    return key
  }

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
      throw new ConfigLoaderError(
        LOADER,
        `cannot determine the Google Cloud project: ${describeError(error, timeoutMs)}`,
        { hints, cause: error },
      )
    }
    if (typeof found !== 'string' || found === '') {
      throw new ConfigLoaderError(LOADER, 'cannot determine the Google Cloud project', { hints })
    }
    return found
  }

  const list = async (client: SecretManagerServiceClientLike, parent: string, filter: string) => {
    let secrets: readonly GcpSecretLike[]
    try {
      // the constructor checked listSecrets when a filter is set
      const { listSecrets } = client as Required<Pick<SecretManagerServiceClientLike, 'listSecrets'>>
      const request = listSecrets.call(client, { parent, filter }, { timeout: timeoutMs, autoPaginate: true })
      ;[secrets] = await abortable(request, AbortSignal.timeout(timeoutMs))
    } catch (error) {
      throw new ConfigLoaderError(
        LOADER,
        `cannot list the secrets of "${parent}" (filter "${filter}"): ${describeError(error, timeoutMs)}`,
        { hints: listHints(error), cause: error },
      )
    }
    const targets = (secrets ?? []).map(secret => {
      const name = typeof secret?.name === 'string' ? RESOURCE_NAME.exec(secret.name) : null
      if (name === null || name[4] !== undefined) {
        throw new ConfigLoaderError(LOADER, `unexpected secret name ${JSON.stringify(secret?.name)} in the listing`)
      }
      return normalizeTarget({ name: name[1] }, options)
    })
    // ids are unique within a project (and location)
    targets.sort((a, b) => (a.id < b.id ? -1 : 1))
    return targets.map(target => ({ ...target, label: target.id }))
  }

  const read = async (
    client: SecretManagerServiceClientLike,
    target: KeyedTarget,
    cancel: AbortSignal,
  ): Promise<ConfigLayer | undefined> => {
    let response: AccessSecretVersionResponseLike | undefined
    try {
      const request = client.accessSecretVersion({ name: target.name }, { timeout: timeoutMs })
      ;[response] = await abortable(request, AbortSignal.any([cancel, AbortSignal.timeout(timeoutMs)]))
    } catch (error) {
      if (grpcCode(error) === NOT_FOUND && target.optional) return undefined
      throw new ConfigLoaderError(LOADER, `cannot read secret "${target.label}": ${describeError(error, timeoutMs)}`, {
        hints: accessHints(error, target),
        cause: error,
      })
    }
    const data = response?.payload?.data
    if (data === undefined || data === null) {
      throw new ConfigLoaderError(LOADER, `secret "${target.label}" has no value`)
    }
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    return { origin: `${LOADER}:${target.label}`, values: secretValues(target, text), secret: true }
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
        const needsProject = filter !== undefined || explicit.some(target => target.secret === undefined)
        const project = needsProject ? await resolveProject(client, projectSetting) : undefined
        const parent = `projects/${project}${location === undefined ? '' : `/locations/${location}`}`
        const discovered = filter === undefined ? [] : await list(client, parent, filter)
        const keyed = (targets: readonly Target[]) =>
          targets.map(target => ({
            ...target,
            name: `${target.secret ?? `${parent}/secrets/${target.id}`}/versions/${target.version}`,
            valueKey: keyOf(target),
          }))
        const listed = keyed(discovered)
        const owners = new Map<string, string>()
        for (const target of listed) {
          const owner = owners.get(target.valueKey)
          if (owner !== undefined) {
            throw new ConfigLoaderError(
              LOADER,
              `secrets "${owner}" and "${target.id}" both map to the key "${target.valueKey}"`,
              { hints: ['Give them distinct keys with "mapKey", or narrow the labels or the filter'] },
            )
          }
          owners.set(target.valueKey, target.id)
        }
        const layers = await readAll([...listed, ...keyed(explicit)], (target, cancel) => read(client, target, cancel))
        return layers.filter((layer): layer is ConfigLayer => layer !== undefined)
      } finally {
        if (owned) await client.close?.().catch(() => undefined)
      }
    },
  }
}

/** The value of a secret under its key; a JSON object, with `json`, provides one value per entry. */
function secretValues(target: KeyedTarget, text: string): Readonly<Record<string, unknown>> {
  const trimmed = text.trim()
  if (target.json && trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed)) return nestUnder(parsed, target.key)
    } catch {
      // not JSON: a plain secret starting with "{"
    }
  }
  return { [target.valueKey]: text }
}
