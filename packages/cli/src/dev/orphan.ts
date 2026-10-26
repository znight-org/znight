/**
 * The orphan guard of `znight dev`. The application runs detached (its own process group, so that a
 * terminal Ctrl+C reaches the CLI only), so when the CLI dies without stopping it (`kill -9`, the OOM
 * killer) it keeps running, holding its port. The CLI therefore preloads `orphan-guard.ts` into the
 * application (`--import` on Node.js, `--preload` on Bun): it watches the CLI process and stops the
 * application once the CLI is gone. No cooperation of the application is needed.
 */
import type { RuntimeName } from '../runtime.ts'

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Environment variable configuring the guard in the application process:
 * `<CLI pid>:<poll interval ms>:<kill timeout ms>`. The guard removes it from the environment right
 * away, so that the processes the application starts itself are not guarded.
 */
export const ORPHAN_GUARD_ENV = 'ZNIGHT_DEV_PARENT'

/** Package export of the preloaded module (resolved from the CLI itself). */
const ORPHAN_GUARD_MODULE = '@znight/cli/orphan-guard'

/** Settings of the guard. */
export interface OrphanGuardSettings {
  /** The CLI process, parent of the application. */
  readonly parentPid: number
  /** How often the guard checks that the CLI is still there. */
  readonly pollMs: number
  /** Time the application gets to stop after SIGTERM before SIGKILL. */
  readonly killTimeoutMs: number
}

/** What a spawned application needs for the guard: runtime arguments and environment. */
export interface OrphanGuard {
  /** Runtime arguments preloading the guard (before the entry file). */
  readonly args: readonly string[]
  /** Environment variables configuring it. */
  readonly env: Readonly<Record<string, string>>
}

/** Default {@link OrphanGuardSettings.pollMs}. */
export const ORPHAN_GUARD_POLL_MS = 500

/**
 * The runtime arguments and environment installing the guard in an application run with `runtime`,
 * `undefined` when the guard module cannot be located (the application then runs without it).
 */
export function orphanGuard(
  runtime: RuntimeName,
  settings: OrphanGuardSettings,
  resolveModule: (specifier: string) => string = specifier => import.meta.resolve(specifier),
): OrphanGuard | undefined {
  let url: string
  try {
    url = resolveModule(ORPHAN_GUARD_MODULE)
  } catch {
    return undefined
  }
  // a missing preload would stop the application from starting
  if (!url.startsWith('file:') || !existsSync(fileURLToPath(url))) return undefined
  // Node.js imports URLs; Bun preloads paths (and ignores data: URLs)
  const args = runtime === 'node' ? ['--import', url] : ['--preload', fileURLToPath(url)]
  const value = `${settings.parentPid}:${settings.pollMs}:${settings.killTimeoutMs}`
  return { args, env: { [ORPHAN_GUARD_ENV]: value } }
}

/** Reads {@link ORPHAN_GUARD_ENV}: `undefined` when it is missing or malformed. */
export function parseOrphanGuard(value: string | undefined): OrphanGuardSettings | undefined {
  const parts = value?.split(':') ?? []
  if (parts.length !== 3 || parts.some(part => !/^\d+$/.test(part))) return undefined
  const [parentPid = 0, pollMs = 0, killTimeoutMs = 0] = parts.map(Number)
  if (parentPid <= 0 || pollMs <= 0) return undefined
  return { parentPid, pollMs, killTimeoutMs }
}
