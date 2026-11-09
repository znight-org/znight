/** Helpers shared by the built-in loaders (internal). */
import type { ConfigLoaderContext } from './types.ts'

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { ConfigLoaderError, invalidConfig } from '../errors.ts'

/** Absolute path of `path` relative to the loader context. */
export function resolveFile(context: ConfigLoaderContext, path: string): string {
  return isAbsolute(path) ? path : resolve(context.cwd, path)
}

function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Reads a UTF-8 file, `undefined` when it does not exist. */
export async function readOptionalFile(loader: string, file: string, label: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, 'utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new ConfigLoaderError(loader, `cannot read ${label}: ${(error as Error).message}`, { cause: error })
  }
}

/** A string setting from the loader options, the previously loaded values or the environment. */
export function setting(context: ConfigLoaderContext, explicit: string | undefined, name: string): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit
  const loaded = context.source.get(name)
  if (typeof loaded === 'string' && loaded.trim() !== '') return loaded.trim()
  const value = context.env[name]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/** Whether `value` is a plain object (not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Imports an optional peer dependency. The specifier is a variable so bundlers leave the import
 * alone when the peer is not installed.
 *
 * @throws ConfigLoaderError with installation hints when the package is not installed.
 */
export async function importOptionalPeer<T>(specifier: string, loader: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as T
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'ERR_MODULE_NOT_FOUND' && message.includes(`'${specifier}'`)) {
      throw new ConfigLoaderError(loader, `the optional peer dependency "${specifier}" is not installed`, {
        hints: [`Install it: bun add ${specifier} (or npm install ${specifier})`],
        cause: error,
      })
    }
    throw error
  }
}

/** Largest timer delay: `setTimeout` clamps above it and `AbortSignal.timeout` throws. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Upper bound of one delay between two attempts of a loader request. */
export const MAX_RETRY_DELAY_MS = 30_000

/** Delay before retry `attempt` (1-based): `base` doubled at each retry, at most {@link MAX_RETRY_DELAY_MS}. */
export function retryDelay(base: number, attempt: number): number {
  return base === 0 ? 0 : Math.min(base * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
}

/** A request timeout option: an integer number of milliseconds from 1 to 2^31 - 1 (ZNIGHT012 otherwise). */
export function timeoutOption(where: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw invalidConfig(`${where}: "timeoutMs" must be an integer from 1 to ${MAX_TIMER_DELAY_MS}, got ${value}`)
  }
  return value
}

/** A non-negative finite number option (ZNIGHT012 otherwise). */
export function nonNegativeOption(where: string, name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidConfig(`${where}: "${name}" must be a finite number >= 0, got ${value}`)
  }
  return value
}

/** Resolves after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}
