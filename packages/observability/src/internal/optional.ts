import { createRequire } from 'node:module'
import { ErrorCode, ZnightError } from '@znight/core'

const requireModule = createRequire(import.meta.url)

/**
 * Loads an optional peer dependency synchronously (CommonJS packages such as `prom-client` and
 * `pino-pretty`). Works on Node.js and Bun, from sources and from `dist`.
 *
 * @throws ZnightError (ZNIGHT001) naming the package and how to install it when it is missing.
 */
export function loadOptionalPeer<T>(specifier: string, feature: string, disableHint?: string): T {
  try {
    return requireModule(specifier) as T
  } catch (error) {
    if (!isModuleNotFound(error, specifier)) throw error
    const hints = [`Install it: bun add ${specifier} (or npm install ${specifier})`]
    if (disableHint !== undefined) hints.push(disableHint)
    throw new ZnightError(
      ErrorCode.MissingProvider,
      `${feature} requires the optional peer dependency "${specifier}", which is not installed`,
      { hints, cause: error },
    )
  }
}

/** Whether an optional peer dependency can be resolved. */
export function isPeerInstalled(specifier: string): boolean {
  try {
    requireModule.resolve(specifier)
    return true
  } catch {
    return false
  }
}

function isModuleNotFound(error: unknown, specifier: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return false
  // a missing transitive dependency of an installed peer is a different problem: rethrow it
  return typeof message !== 'string' || message.includes(`'${specifier}'`) || message.includes(`"${specifier}"`)
}
