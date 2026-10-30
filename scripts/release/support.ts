/**
 * Process, logging and GitHub Actions helpers shared by the release scripts (`scripts/release/*`).
 */
import { appendFileSync } from 'node:fs'

/** True when running in GitHub Actions. */
export const inGitHubActions: boolean = process.env['GITHUB_ACTIONS'] === 'true'

export interface RunOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * Gives the command the console instead of capturing its output: it can also read the terminal
   * (npm's two-factor prompts).
   */
  readonly inherit?: boolean
}

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a command to completion. The environment is `process.env` merged with `options.env`. */
export async function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const env = { ...process.env, ...options.env }
  if (options.inherit === true) {
    const child = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    return { code: await child.exited, stdout: '', stderr: '' }
  }
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

/** Runs a command and throws (with its output) when it fails. */
export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await run(command, args, options)
  if (result.code !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim()
    throw new Error(
      `\`${[command, ...args].join(' ')}\` failed (exit code ${result.code})${output ? `\n${output}` : ''}`,
    )
  }
  return result
}

/** Escapes a message for a GitHub Actions workflow command (`::warning::...`). */
function escapeAnnotation(message: string): string {
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

export const log = {
  info(message: string): void {
    console.log(message)
  },
  step(message: string): void {
    console.log(`\n▸ ${message}`)
  },
  warn(message: string): void {
    console.log(inGitHubActions ? `::warning::${escapeAnnotation(message)}` : `⚠ warning: ${message}`)
  },
  error(message: string): void {
    console.error(inGitHubActions ? `::error::${escapeAnnotation(message)}` : `✖ error: ${message}`)
  },
  /** Prints a block of output, collapsed in GitHub Actions. */
  block(title: string, body: string): void {
    if (body.trim() === '') return
    if (inGitHubActions) console.log(`::group::${title}\n${body.trimEnd()}\n::endgroup::`)
    else console.log(`--- ${title}\n${body.trimEnd()}\n---`)
  },
}

/** Sets a step output (`$GITHUB_OUTPUT`); no-op outside GitHub Actions. Values must fit on one line. */
export function setOutput(name: string, value: string): void {
  const file = process.env['GITHUB_OUTPUT']
  if (file) appendFileSync(file, `${name}=${value}\n`)
}

/** Appends Markdown to the job summary (`$GITHUB_STEP_SUMMARY`); no-op outside GitHub Actions. */
export function summary(markdown: string): void {
  const file = process.env['GITHUB_STEP_SUMMARY']
  if (file) appendFileSync(file, `${markdown}\n`)
}

/** Formats a byte count (`12.3 kB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`
  return `${(bytes / 1_000_000).toFixed(2)} MB`
}

/** Runs `main` and exits with code 1 (printing the error) when it throws. */
export function main(entry: () => Promise<void> | void): void {
  Promise.resolve()
    .then(entry)
    .catch((error: unknown) => {
      log.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
