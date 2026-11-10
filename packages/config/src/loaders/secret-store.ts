/**
 * The common contract of the secret-store loaders (internal, RFC 0013): which secrets to read, how
 * a value maps to config keys, JSON expansion, `optional`, timeouts and error messages.
 */
import type { ConfigLayer } from '../source.ts'

import { ConfigLoaderError, errorMessage, invalidConfig } from '../errors.ts'
import { nestUnder } from '../source.ts'
import { isRecord, readAll } from './shared.ts'

/** The per-secret options every cloud secret loader shares. */
export interface SecretRefOptions {
  /** Key path of the value: a plain value is stored under it, a JSON object mounted under it. */
  readonly key?: string
  /** Expand a JSON object value into one value per entry. Default: the loader `json` (`true`). */
  readonly json?: boolean
  /** Skip the secret when it does not exist. Default: the loader `optional` (`false`). */
  readonly optional?: boolean
}

/** A secret reference with its id under `field` (`secretId`, `path`) and the common options resolved. */
export interface NormalizedSecret<R> {
  readonly ref: R
  /** The identifier as written: messages, origins and the default key. */
  readonly id: string
  readonly key: string | undefined
  readonly json: boolean
  readonly optional: boolean
}

function optionalString(where: string, name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw invalidConfig(`${where}: "${name}" must be a non-empty string`)
  return value
}

/** A boolean option: `undefined` or a boolean (ZNIGHT012 otherwise). */
export function booleanOption(where: string, name: string, value: unknown): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value
  throw invalidConfig(`${where}: "${name}" must be a boolean`)
}

/**
 * Normalises the "which secrets" option of a loader: an id, a `{ [field]: id, key?, json?, optional? }`
 * object, or an array of them (in precedence order).
 *
 * @throws ZnightError (ZNIGHT012) when the list is empty or an entry is invalid.
 */
export function normalizeSecrets<R extends Readonly<Record<string, unknown>>>(
  where: string,
  field: string,
  value: unknown,
  defaults: { readonly json?: boolean | undefined; readonly optional?: boolean | undefined },
): NormalizedSecret<R>[] {
  let items: readonly unknown[] = []
  if (Array.isArray(value)) items = value
  else if (value !== undefined) items = [value]
  const usage = `"${field}" must be a non-empty string, a { ${field} } object or an array of them`
  if (items.length === 0) throw invalidConfig(`${where}: ${usage}`)
  booleanOption(where, 'json', defaults.json)
  booleanOption(where, 'optional', defaults.optional)
  return items.map(item => {
    const ref = (typeof item === 'string' ? { [field]: item } : item) as R
    const id = isRecord(ref) ? ref[field] : undefined
    if (typeof id !== 'string' || id.trim() === '')
      throw invalidConfig(`${where}: ${usage}, got ${JSON.stringify(item)}`)
    return {
      ref,
      id,
      key: optionalString(where, `key" of "${id}`, ref['key']),
      json: booleanOption(where, `json" of "${id}`, ref['json']) ?? defaults.json ?? true,
      optional: booleanOption(where, `optional" of "${id}`, ref['optional']) ?? defaults.optional ?? false,
    }
  })
}

/**
 * The values of one secret: with `json`, a JSON object provides one value per entry (at the root,
 * or under `key`); anything else (text, a JSON array, invalid JSON) is one value under `key`, else
 * `defaultKey`. A parse failure is never reported: its message would quote the secret.
 */
export function secretValues(
  text: string,
  secret: { readonly key: string | undefined; readonly json: boolean },
  defaultKey: string,
): Readonly<Record<string, unknown>> {
  const trimmed = text.trim()
  if (secret.json && trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed)) return nestUnder(parsed, secret.key)
    } catch {
      // not JSON: a plain secret starting with "{"
    }
  }
  return { [secret.key ?? defaultKey]: text }
}

/** A layer of secret values (`secret: true`: masked like `@Secret` values). */
export function secretLayer(origin: string, values: Readonly<Record<string, unknown>>): ConfigLayer {
  return { origin, values, secret: true }
}

/** Reads every secret concurrently (see {@link readAll}) and drops the skipped ones. */
export async function readSecretLayers<T>(
  secrets: readonly T[],
  read: (secret: T, signal: AbortSignal) => Promise<ConfigLayer | undefined>,
): Promise<ConfigLayer[]> {
  const layers = await readAll(secrets, read)
  return layers.filter((layer): layer is ConfigLayer => layer !== undefined)
}

/** Settles like `promise`, or rejects with the reason of `signal` once it is aborted. */
export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
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

/**
 * The signal of one request: aborted after `timeoutMs`, or as soon as `cancel` is (another secret
 * failed).
 */
export function requestSignal(cancel: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([cancel, AbortSignal.timeout(timeoutMs)])
}

/** Whether `error` is the timeout of {@link requestSignal}. */
export function isTimeout(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'TimeoutError'
}

/** A property of an SDK error (`name`, `code`, `statusCode`...), `undefined` when absent. */
export function errorProperty(error: unknown, name: string): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[name] : undefined
}

/**
 * `cannot read secret "<id>": <status>: <message>`, or `timed out after <n> ms`: the error of a
 * failed read. `status` is the provider's error code (`ResourceNotFoundException`, `NOT_FOUND`,
 * `SecretNotFound`...), left out when unknown.
 */
export function readError(
  loader: string,
  id: string,
  error: unknown,
  options: {
    readonly status?: string | undefined
    readonly timeoutMs: number
    readonly hints?: readonly string[]
    /** The provider's message, when `error.message` needs cleaning. Default: the error message. */
    readonly message?: string
  },
): ConfigLoaderError {
  if (error instanceof ConfigLoaderError) return error
  const reason = isTimeout(error)
    ? `timed out after ${options.timeoutMs} ms`
    : `${options.status === undefined ? '' : `${options.status}: `}${options.message ?? errorMessage(error)}`
  return new ConfigLoaderError(loader, `cannot read secret "${id}": ${reason}`, {
    cause: error,
    ...(options.hints === undefined || options.hints.length === 0 ? {} : { hints: options.hints }),
  })
}

/** `secret "<id>" has no value`: the store answered without a payload. */
export function noValueError(loader: string, id: string): ConfigLoaderError {
  return new ConfigLoaderError(loader, `secret "${id}" has no value`)
}
