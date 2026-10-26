/**
 * Detection of Bun's automatic `.env` loading (internal).
 *
 * Unless disabled (`env = false` in `bunfig.toml`, `bun --no-env-file`), Bun loads `.env`,
 * `.env.<mode>`, `.env.local` (not in `test`) and `.env.<mode>.local` from the working directory
 * into `process.env` before the application starts (`mode`: `production`, `test` or `development`),
 * with its own precedence (`.env.local` wins over `.env.<mode>`) and `${VAR}` expansion. `env()`
 * then reads those files with Bun's rules instead of the documented `dotenv()` ones, and even when
 * `dotenv()` is not configured.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

/** What {@link bunLoadedDotenvFiles} inspects. */
export interface BunDotenvProbe {
  /** Whether the process runs on Bun. */
  readonly bun: boolean
  /** Directory Bun loads the files from: the working directory of the process. */
  readonly cwd: string
  /** The environment Bun filled (`process.env`). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Runtime flags (`process.execArgv`). */
  readonly execArgv: readonly string[]
}

/**
 * Files Bun loads automatically for `NODE_ENV`. Bun only knows three modes: `production` and `test`
 * when `NODE_ENV` is exactly that, `development` otherwise (unset, `staging`, `Production`...).
 */
export function bunDotenvFiles(nodeEnv: string | undefined): string[] {
  const mode = nodeEnv === 'production' || nodeEnv === 'test' ? nodeEnv : 'development'
  const files = ['.env', `.env.${mode}`]
  if (mode !== 'test') files.push('.env.local')
  files.push(`.env.${mode}.local`)
  return files
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Whether `bunfig.toml` in `cwd` sets `env = false` (in its root table). */
function disabledInBunfig(cwd: string): boolean {
  const text = readText(join(cwd, 'bunfig.toml'))
  if (text === undefined) return false
  const root = text.split(/^\s*\[/m)[0] ?? ''
  return /^\s*env\s*=\s*false\s*(?:#.*)?$/m.test(root)
}

/**
 * The `.env` files Bun loaded into `probe.env` when the process started: the files of
 * {@link bunDotenvFiles} found in `probe.cwd` defining at least one variable of `probe.env`.
 * `[]` when not on Bun or when Bun's automatic loading is disabled or replaced (`--env-file`).
 */
export function bunLoadedDotenvFiles(probe: BunDotenvProbe): string[] {
  if (!probe.bun) return []
  if (probe.execArgv.some(arg => arg === '--no-env-file' || arg === '--env-file' || arg.startsWith('--env-file='))) {
    return []
  }
  if (disabledInBunfig(probe.cwd)) return []
  const loaded: string[] = []
  for (const file of bunDotenvFiles(probe.env['NODE_ENV'])) {
    const text = readText(join(probe.cwd, file))
    if (text === undefined) continue
    let names: string[]
    try {
      names = Object.keys(parseEnv(text))
    } catch {
      continue
    }
    if (names.some(name => probe.env[name] !== undefined)) loaded.push(file)
  }
  return loaded
}

/** The warning for files Bun loaded into `process.env` (see {@link bunLoadedDotenvFiles}). */
export function bunDotenvWarning(files: readonly string[]): string {
  return (
    `Bun loaded ${files.join(', ')} into process.env before the application started: env() reads ` +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} (Bun's expansion syntax)
    "them with Bun's precedence and ${VAR} expansion, even without dotenv(). Disable Bun's automatic " +
    '.env loading (`env = false` in bunfig.toml, or `bun --no-env-file`) and let dotenv() load the files'
  )
}

let checked = false

/**
 * Warns once per process (`process.emitWarning`, type `ZnightWarning`) when `env` is `process.env`
 * and Bun loaded `.env` files into it.
 */
export function warnBunLoadedDotenv(env: Readonly<Record<string, string | undefined>>): void {
  if (checked || env !== process.env) return
  checked = true
  const files = bunLoadedDotenvFiles({
    bun: process.versions['bun'] !== undefined,
    cwd: process.cwd(),
    env,
    execArgv: process.execArgv,
  })
  if (files.length > 0) process.emitWarning(bunDotenvWarning(files), { type: 'ZnightWarning' })
}
