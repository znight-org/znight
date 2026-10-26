/**
 * Terminal output: color detection (NO_COLOR, FORCE_COLOR, `--color` / `--no-color`, TTY), a small
 * reporter writing consistent status lines, and formatting helpers.
 */
import { stripVTControlCharacters } from 'node:util'
import picocolors from 'picocolors'

/** picocolors formatters (`colors.red('x')`...). */
export type Colors = ReturnType<typeof picocolors.createColors>

/** A writable text stream (`process.stdout`, or a test double). */
export interface OutputStream {
  write(chunk: string): unknown
  readonly isTTY?: boolean | undefined
  readonly columns?: number | undefined
}

/** Inputs of {@link shouldUseColor}. */
export interface ColorInputs {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stream: OutputStream
  /** `true` for `--color`, `false` for `--no-color`, `undefined` when neither was passed. */
  readonly flag?: boolean | undefined
}

/**
 * Whether colors should be written: `--no-color` and a non-empty `NO_COLOR` disable them,
 * `--color` and `FORCE_COLOR` (other than `0`/`false`) force them, otherwise a TTY that is not
 * `TERM=dumb` gets colors.
 */
export function shouldUseColor({ env, stream, flag }: ColorInputs): boolean {
  if (flag !== undefined) return flag
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  const force = env.FORCE_COLOR
  if (force !== undefined) return force !== '0' && force !== 'false'
  return stream.isTTY === true && env.TERM !== 'dumb'
}

/** picocolors formatters, enabled or not. */
export function createColors(enabled: boolean): Colors {
  return picocolors.createColors(enabled)
}

/** Removes ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text)
}

/** Writes consistent status lines. Errors and warnings go to stderr, everything else to stdout. */
export interface Reporter {
  readonly colors: Colors
  /** A raw line on stdout. */
  log(message?: string): void
  /** `› message` */
  info(message: string): void
  /** `✓ message` */
  success(message: string): void
  /** `! message` (stderr) */
  warn(message: string, hints?: readonly string[]): void
  /** `✗ message` (stderr) */
  error(message: string, hints?: readonly string[]): void
  /** A raw line on stderr. */
  logError(message?: string): void
}

/** Creates a {@link Reporter} writing to the given streams. */
export function createReporter(stdout: OutputStream, stderr: OutputStream, colors: Colors): Reporter {
  const line = (stream: OutputStream, text: string): void => {
    stream.write(`${text}\n`)
  }
  const withHints = (stream: OutputStream, hints: readonly string[] | undefined): void => {
    for (const hint of hints ?? []) line(stream, `  ${colors.dim('=')} ${colors.bold('hint:')} ${hint}`)
  }
  return {
    colors,
    log: (message = '') => line(stdout, message),
    info: message => line(stdout, `${colors.cyan('›')} ${message}`),
    success: message => line(stdout, `${colors.green('✓')} ${message}`),
    warn: (message, hints) => {
      line(stderr, `${colors.yellow('!')} ${message}`)
      withHints(stderr, hints)
    },
    error: (message, hints) => {
      line(stderr, `${colors.red('✗')} ${colors.red(message)}`)
      withHints(stderr, hints)
    },
    logError: (message = '') => line(stderr, message),
  }
}

/** `850ms`, `1.24s`, `2m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** `512 B`, `1.5 kB`, `2.31 MB` (SI units, like Vite). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(2)} kB`
  return `${(bytes / 1_000_000).toFixed(2)} MB`
}

/** `1 provider`, `3 providers`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
