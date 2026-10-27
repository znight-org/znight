/** Helpers shared by the commands. */
import type { CliContext } from '../context.ts'

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { CliError, UsageError } from '../errors.ts'

/** `--root`, resolved against the working directory. Must be an existing directory. */
export function resolveRoot(cli: CliContext, root: string | undefined): string {
  const directory = resolve(cli.cwd, root ?? '.')
  let isDirectory = false
  try {
    isDirectory = statSync(directory).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) throw new CliError(`Project root not found: ${directory}`)
  return directory
}

/** The nearest directory containing a `package.json`, from `start` upwards (`start` when none). */
export function findProjectRoot(start: string): string {
  let directory = start
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return start
    directory = parent
  }
}

/** Reads `package.json` of `root` (an empty object when missing or invalid). */
export function readManifest(root: string): {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return typeof manifest === 'object' && manifest !== null ? manifest : {}
  } catch {
    return {}
  }
}

/** Parses a non-negative integer option (milliseconds...). */
export function parseNonNegativeInteger(value: string | undefined, option: string, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`Invalid value for --${option}: expected a non-negative integer, got "${value}"`)
  }
  return parsed
}

/** An HTTP prefix option (`/api`, the `prefix` of `HttpPlugin`): `undefined` when not given. */
export function parseHttpPrefix(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined
  if (!value.startsWith('/')) {
    throw new UsageError(`Invalid --${option} "${value}": expected a path starting with "/"`)
  }
  return value
}

/** A path for messages: relative to `from`, or absolute when that is shorter. POSIX separators. */
export function displayPath(file: string, from: string): string {
  const path = relative(from, file)
  if (path === '') return '.'
  const shortest = isAbsolute(path) || (path.startsWith('..') && file.length < path.length) ? file : path
  return shortest.split(sep).join('/')
}

/**
 * Signals stopping a long-running command: Ctrl+C, `kill`, the terminal closed (`SIGHUP`) and, on
 * POSIX, `Ctrl+\` (`SIGQUIT`). Without a listener the last two kill the CLI without running its exit
 * hooks, leaving the application of `znight dev` (in its own session) running.
 */
export const TERMINATION_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

/**
 * Calls `onFirst` on the first {@link TERMINATION_SIGNALS termination signal}; `onRepeat` runs on
 * any later one (force quit). Returns a function removing the listeners.
 */
export function onTermination(
  cli: CliContext,
  onFirst: (signal: NodeJS.Signals) => void,
  onRepeat: (signal: NodeJS.Signals) => void,
): () => void {
  let received = false
  const listeners = TERMINATION_SIGNALS.map(signal => {
    const listener = (): void => {
      if (received) {
        onRepeat(signal)
        return
      }
      received = true
      onFirst(signal)
    }
    cli.signals.on(signal, listener)
    return [signal, listener] as const
  })
  return () => {
    for (const [signal, listener] of listeners) cli.signals.off(signal, listener)
  }
}
