import type { ConfigLayer } from '../source.ts'
import type { ConfigLoader, ConfigLoaderContext } from './types.ts'

import { ConfigLoaderError, errorMessage, invalidConfig } from '../errors.ts'
import { nestUnder } from '../source.ts'
import { delay, isRecord, readOptionalFile, resolveFile, setting } from './shared.ts'

/** Options of {@link vault}. */
export interface VaultLoaderOptions {
  /**
   * Secrets to read, in precedence order (later paths override earlier ones). CLI style
   * `<mount>/<path>` (`secret/myapp` → `GET /v1/secret/data/myapp` with KV v2), or relative to
   * {@link mount} when it is set (mounts containing `/`).
   */
  readonly path: string | readonly string[]
  /** Vault server. Default: `VAULT_ADDR` (previous loaders, then the environment). */
  readonly address?: string
  /** Token. Default: the content of {@link tokenFile}, then `VAULT_TOKEN`. */
  readonly token?: string
  /** File containing the token (e.g. a Kubernetes/agent sink). Relative to the loader `cwd`. */
  readonly tokenFile?: string
  /** Secrets engine mount. Default: the first segment of each path. */
  readonly mount?: string
  /** KV secrets engine version. Default: `2`. */
  readonly kvVersion?: 1 | 2
  /** Enterprise namespace (`X-Vault-Namespace`). Default: `VAULT_NAMESPACE`. */
  readonly namespace?: string
  /** Key path under which the secret data is mounted (see `json()`). Default: the root. */
  readonly key?: string
  /** Skip secrets that do not exist (HTTP 404) instead of failing. Default: `false`. */
  readonly optional?: boolean
  /** Timeout of each HTTP request, in milliseconds. Default: `5000`. */
  readonly timeoutMs?: number
  /** Retries on network errors, timeouts, HTTP 429 and 5xx, and bodies that are not JSON. Default: `2`. */
  readonly retries?: number
  /** Base delay between retries (doubled each time), in milliseconds. Default: `200`. */
  readonly retryDelayMs?: number
  /** `fetch` implementation (tests, proxies). Default: the global `fetch`. */
  readonly fetch?: typeof fetch
}

interface SecretLocation {
  /** `<mount>/<path>`, used in messages and origins. */
  readonly label: string
  /** API path, appended to the server address. */
  readonly apiPath: string
}

class RetryableError extends Error {}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter(segment => segment !== '')
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

function locate(options: VaultLoaderOptions, path: string): SecretLocation {
  const trimmed = path.replace(/^\/+|\/+$/g, '')
  let mount = options.mount?.replace(/^\/+|\/+$/g, '')
  let secret = trimmed
  if (mount === undefined || mount === '') {
    const slash = trimmed.indexOf('/')
    if (slash <= 0) {
      throw invalidConfig(`vault(): path "${path}" must be "<mount>/<secret path>" (or set the "mount" option)`)
    }
    mount = trimmed.slice(0, slash)
    secret = trimmed.slice(slash + 1)
  }
  const kv2 = (options.kvVersion ?? 2) === 2
  if (secret === '') throw invalidConfig(`vault(): path "${path}" has no secret path after the mount "${mount}"`)
  const apiPath = `/v1/${encodePath(mount)}/${kv2 ? 'data/' : ''}${encodePath(secret)}`
  return { label: `${mount}/${secret}`, apiPath }
}

async function vaultErrors(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { errors?: unknown }
    if (Array.isArray(body.errors) && body.errors.length > 0) return `: ${body.errors.map(String).join('; ')}`
  } catch {
    // not JSON: the status is enough
  }
  return ''
}

/**
 * The JSON body of a secret response. A body that does not parse (truncated, a proxy page...) is a
 * retryable failure reported without the parser message, which quotes the payload: the secret.
 */
async function secretBody(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    const type = response.headers.get('content-type')
    throw new RetryableError(
      `the response body is not valid JSON (${text.length} characters${type === null ? '' : `, ${type}`})`,
    )
  }
}

async function resolveToken(context: ConfigLoaderContext, options: VaultLoaderOptions): Promise<string> {
  if (options.token !== undefined && options.token !== '') return options.token
  if (options.tokenFile !== undefined) {
    const text = await readOptionalFile('vault', resolveFile(context, options.tokenFile), options.tokenFile)
    const token = text?.trim()
    if (token === undefined || token === '') {
      throw new ConfigLoaderError('vault', `the token file ${options.tokenFile} is missing or empty`)
    }
    return token
  }
  const token = setting(context, undefined, 'VAULT_TOKEN')
  if (token === undefined) {
    throw new ConfigLoaderError('vault', 'no token: pass { token } or { tokenFile }, or set VAULT_TOKEN')
  }
  return token
}

/**
 * Reads KV secrets from HashiCorp Vault (KV v1 or v2) over its HTTP API. Each path is a layer whose
 * values are the secret's key/value pairs (`{ DB_PASSWORD: '...' }` matches `@Secret('DB_PASSWORD')`,
 * nested values match key paths). Requests have a timeout and are retried on transient failures.
 *
 * ```ts
 * ConfigPlugin.configure({
 *   loaders: [dotenv(), env(), vault({ path: 'secret/myapp' })], // VAULT_ADDR / VAULT_TOKEN from the env
 * })
 * ```
 */
export function vault(options: VaultLoaderOptions): ConfigLoader {
  const paths = [options?.path].flat()
  if (paths.length === 0 || paths.some(path => typeof path !== 'string' || path.trim() === '')) {
    throw invalidConfig('vault(): "path" must be a non-empty string or an array of them')
  }
  if (options.kvVersion !== undefined && options.kvVersion !== 1 && options.kvVersion !== 2) {
    throw invalidConfig('vault(): "kvVersion" must be 1 or 2')
  }
  const locations = paths.map(path => locate(options, path))
  const timeoutMs = options.timeoutMs ?? 5000
  const retries = Math.max(0, Math.floor(options.retries ?? 2))
  const retryDelayMs = options.retryDelayMs ?? 200

  return {
    name: 'vault',
    async load(context) {
      const address = setting(context, options.address, 'VAULT_ADDR')?.replace(/\/+$/, '')
      if (address === undefined) {
        throw new ConfigLoaderError('vault', 'no server address: pass { address } or set VAULT_ADDR')
      }
      if (!URL.canParse(address)) {
        throw new ConfigLoaderError('vault', `invalid server address ${JSON.stringify(address)}`)
      }
      const token = await resolveToken(context, options)
      const headers: Record<string, string> = {
        'X-Vault-Token': token,
        'X-Vault-Request': 'true',
        Accept: 'application/json',
      }
      const namespace = setting(context, options.namespace, 'VAULT_NAMESPACE')
      if (namespace !== undefined) headers['X-Vault-Namespace'] = namespace
      const fetchImpl = options.fetch ?? globalThis.fetch
      const kv2 = (options.kvVersion ?? 2) === 2

      const read = async (location: SecretLocation): Promise<ConfigLayer | undefined> => {
        let lastError: unknown
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) await delay(retryDelayMs * 2 ** (attempt - 1))
          try {
            const response = await fetchImpl(`${address}${location.apiPath}`, {
              headers,
              signal: AbortSignal.timeout(timeoutMs),
            })
            if (response.status === 404) {
              await response.body?.cancel()
              if (options.optional === true) return undefined
              throw new ConfigLoaderError('vault', `secret ${location.label} not found (HTTP 404)`, {
                hints: ['Check the path, the mount and kvVersion, or pass { optional: true }'],
              })
            }
            if (response.status === 429 || response.status >= 500) {
              throw new RetryableError(`HTTP ${response.status}${await vaultErrors(response)}`)
            }
            if (!response.ok) {
              throw new ConfigLoaderError(
                'vault',
                `cannot read secret ${location.label}: HTTP ${response.status}${await vaultErrors(response)}`,
                { hints: response.status === 403 ? ['Check the token and its policies'] : [] },
              )
            }
            const body = (await secretBody(response)) as { data?: { data?: unknown } } | null
            const data = kv2 ? body?.data?.data : body?.data
            if (!isRecord(data)) {
              throw new ConfigLoaderError(
                'vault',
                `unexpected response for ${location.label}: no secret data (is kvVersion ${kv2 ? 2 : 1} correct?)`,
              )
            }
            return { origin: `vault:${location.label}`, values: nestUnder(data, options.key) }
          } catch (error) {
            if (error instanceof ConfigLoaderError) throw error
            lastError = error
          }
        }
        throw new ConfigLoaderError(
          'vault',
          `cannot read secret ${location.label} after ${retries + 1} attempt(s): ${errorMessage(lastError)}`,
          { cause: lastError },
        )
      }

      const layers = await Promise.all(locations.map(read))
      return layers.filter((layer): layer is ConfigLayer => layer !== undefined)
    },
  }
}
