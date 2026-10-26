/**
 * Errors thrown by commands. The dispatcher turns them into a message on stderr and an exit code;
 * any other error is reported as an unexpected failure (exit code 1, stack trace with `--debug`).
 */

/** Exit codes of the `znight` binary. */
export const ExitCode = {
  /** The command succeeded. */
  Ok: 0,
  /** The command failed (compilation errors, failed build, stale generated file...). */
  Failure: 1,
  /** Invalid usage: unknown command or option, missing or invalid argument. */
  Usage: 2,
  /** The user cancelled an interactive prompt or interrupted the command. */
  Cancelled: 130,
} as const

/** One of the {@link ExitCode} values (or any process exit code). */
export type ExitCodeValue = number

/** Options of a {@link CliError}. */
export interface CliErrorOptions {
  /** Exit code of the process. Default {@link ExitCode.Failure}. */
  readonly exitCode?: number
  /** Lines printed after the message (`= hint: ...`). */
  readonly hints?: readonly string[]
  /** Original error. */
  readonly cause?: unknown
}

/** An expected failure: printed without stack trace. */
export class CliError extends Error {
  readonly exitCode: number
  readonly hints: readonly string[]

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CliError'
    this.exitCode = options.exitCode ?? ExitCode.Failure
    this.hints = options.hints ?? []
  }
}

/** Invalid command line usage (exit code 2). The usage of the command is printed after the message. */
export class UsageError extends CliError {
  constructor(message: string, hints: readonly string[] = []) {
    super(message, { exitCode: ExitCode.Usage, hints })
    this.name = 'UsageError'
  }
}

/** The user cancelled a prompt (exit code 130). */
export class CancelledError extends CliError {
  constructor(message = 'Cancelled') {
    super(message, { exitCode: ExitCode.Cancelled })
    this.name = 'CancelledError'
  }
}

/** Message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
