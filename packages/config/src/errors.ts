/**
 * Config errors. Invalid or missing values are aggregated into one {@link ConfigValidationError}
 * (ZNIGHT006) so every problem is fixed in a single round.
 */
import { ErrorCode, ZnightError, type ZnightErrorOptions } from '@znight/core'

/** Kind of a {@link ConfigProblem}. */
export type ConfigProblemKind = 'missing' | 'invalid'

/** One missing or invalid configuration value. */
export interface ConfigProblem {
  /** Display name of the config class (`DatabaseConfig`). */
  readonly config: string
  readonly property: string
  /** Environment variable name of the property. */
  readonly env: string
  /** Key path of the property in structured sources. */
  readonly key: string
  readonly kind: ConfigProblemKind
  /** What is wrong (`expected a number but got "abc"`); secret values are masked. */
  readonly message: string
  /** Name under which the faulty value was found (`env`, `key` or `@Default`). */
  readonly name?: string
  /** Origin of the faulty value (`process.env`, `.env.local`, `vault:secret/app`, `@Default`). */
  readonly origin?: string
}

function formatProblem(problem: ConfigProblem): string {
  const target = `${problem.config}.${problem.property}`
  if (problem.kind === 'missing') {
    const keys = problem.env === problem.key ? problem.env : `${problem.env} (or key "${problem.key}")`
    return `${target}: ${problem.message}; set ${keys}`
  }
  const where =
    problem.name === undefined
      ? ''
      : ` (${problem.name}${problem.origin === undefined || problem.origin === problem.name ? '' : ` from ${problem.origin}`})`
  return `${target}: ${problem.message}${where}`
}

/** Thrown when configuration values are missing or invalid: lists every problem at once. */
export class ConfigValidationError extends ZnightError {
  readonly problems: readonly ConfigProblem[]

  constructor(problems: readonly ConfigProblem[], options: ZnightErrorOptions = {}) {
    const count = problems.length
    const title = count === 1 ? 'Invalid configuration: 1 problem' : `Invalid configuration: ${count} problems`
    super(ErrorCode.MissingConfig, `${title}\n${problems.map(problem => `  - ${formatProblem(problem)}`).join('\n')}`, {
      ...options,
      hints: options.hints ?? [
        'Set the missing variables in the environment or in a .env file (ConfigPlugin loads .env files by default)',
      ],
    })
    this.name = 'ConfigValidationError'
    this.problems = Object.freeze([...problems])
  }
}

/** Thrown when a config loader fails (unreadable file, secret store error...). */
export class ConfigLoaderError extends ZnightError {
  /** Name of the failing loader (`dotenv`, `vault`...). */
  readonly loader: string

  constructor(loader: string, message: string, options: ZnightErrorOptions = {}) {
    super(ErrorCode.MissingConfig, `Config loader "${loader}" failed: ${message}`, options)
    this.name = 'ConfigLoaderError'
    this.loader = loader
  }
}

/** Thrown for invalid config definitions or options (generated metadata, loader options). */
export function invalidConfig(message: string, hints?: readonly string[]): ZnightError {
  return new ZnightError(ErrorCode.InvalidConfig, message, hints === undefined ? {} : { hints })
}

/** The message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
