import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Imports `specifier` as resolved from the project `root` (the versions the project installed, like
 * `vite` and `tsc` do), or with `fallback` (resolved from the CLI) when the project does not have it.
 */
export async function importFromProject(
  specifier: string,
  root: string,
  fallback: () => Promise<unknown>,
): Promise<unknown> {
  const resolved = resolveFromProject(specifier, root)
  if (resolved !== undefined) {
    try {
      return await import(pathToFileURL(resolved).href)
    } catch (error) {
      // a broken project install must not hide behind the fallback
      if (!isModuleNotFound(error)) throw error
    }
  }
  return fallback()
}

/** Absolute path of `specifier` resolved from `root`, or `undefined`. */
export function resolveFromProject(specifier: string, root: string): string | undefined {
  try {
    return createRequire(join(root, 'package.json')).resolve(specifier)
  } catch {
    return undefined
  }
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}
