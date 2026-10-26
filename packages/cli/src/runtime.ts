/**
 * JavaScript runtimes the application can run on (`znight dev`, `znight start`) and executable
 * lookup in `PATH`.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** Runtime of the application process. */
export type RuntimeName = 'node' | 'bun'

/** `--runtime` values: `auto` picks Bun when the CLI itself runs on Bun, Node.js otherwise. */
export type RuntimeOption = RuntimeName | 'auto'

/** The runtime executing the CLI. */
export interface HostRuntime {
  readonly name: RuntimeName
  /** Absolute path of the running executable (`process.execPath`). */
  readonly execPath: string
  readonly platform: NodeJS.Platform
}

/** Detects the runtime executing this process. */
export function detectHostRuntime(): HostRuntime {
  const isBun = typeof process.versions.bun === 'string'
  return { name: isBun ? 'bun' : 'node', execPath: process.execPath, platform: process.platform }
}

/** Resolves `auto`. */
export function resolveRuntime(option: RuntimeOption | undefined, host: HostRuntime): RuntimeName {
  return option === undefined || option === 'auto' ? host.name : option
}

/**
 * Finds an executable in `PATH` (`PATHEXT` extensions on Windows). Absolute paths are checked as is.
 * Returns `undefined` when not found.
 */
export function which(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const extensions =
    platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : ['']
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? env.Path ?? '')
        .split(platform === 'win32' ? ';' : delimiter)
        .filter(directory => directory !== '')
        .map(directory => join(directory, command))
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const file = candidate + extension
      if (isExecutable(file, platform)) return file
    }
  }
  return undefined
}

function isExecutable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The executable of `runtime`: the running executable when it is that runtime, otherwise the one
 * found in `PATH`.
 */
export function runtimeExecutable(
  runtime: RuntimeName,
  host: HostRuntime,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (runtime === host.name) return host.execPath
  return which(runtime, env, host.platform)
}

/** Runtime arguments placed before the entry file. */
export function runtimeArguments(runtime: RuntimeName, extra: readonly string[] = []): string[] {
  // Vite emits source maps for server builds: map stack traces to the TypeScript sources.
  return runtime === 'node' ? ['--enable-source-maps', ...extra] : [...extra]
}
