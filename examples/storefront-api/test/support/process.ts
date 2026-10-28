import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The example's directory: the working directory of every command (`.env` files, `dist/`). */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The built CLI (`znight`), run with Node.js like `npm run build` does. */
export function znightCli(): string {
  const cli = join(ROOT, 'node_modules/@znight/cli/dist/cli.mjs')
  if (!existsSync(cli))
    throw new Error('The @znight/* packages are not built: run `bun run build` at the repository root')
  return cli
}

/** A JSON log line of the application. */
export interface LogEntry {
  readonly level: number
  readonly msg: string
  readonly [field: string]: unknown
}

export interface Exit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** Runs a command to completion. */
export function run(command: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.once('exit', code => resolve({ code, output }))
  })
}

/** The application running in a child process, configured by its environment. */
export class AppProcess {
  readonly #child: ChildProcess
  readonly exited: Promise<Exit>
  #output = ''

  constructor(command: string, args: readonly string[], env: Record<string, string | undefined>) {
    this.#child = spawn(command, [...args], {
      cwd: ROOT,
      env: Object.fromEntries(
        Object.entries({ ...process.env, NO_COLOR: '1', ...env }).filter(([, value]) => value !== undefined),
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child.stdout?.on('data', chunk => {
      this.#output += chunk
    })
    this.#child.stderr?.on('data', chunk => {
      this.#output += chunk
    })
    this.exited = new Promise(resolve => this.#child.once('exit', (code, signal) => resolve({ code, signal })))
  }

  get output(): string {
    return this.#output
  }

  /** The JSON log lines written so far. */
  logs(): LogEntry[] {
    return this.#output
      .split('\n')
      .filter(line => line.startsWith('{'))
      .flatMap(line => {
        try {
          return [JSON.parse(line) as LogEntry]
        } catch {
          return []
        }
      })
  }

  /** Waits for a log entry (fails early when the process exits). */
  async waitForLog(message: string, timeoutMs = 30_000): Promise<LogEntry> {
    const deadline = Date.now() + timeoutMs
    let exited = false
    void this.exited.then(() => {
      exited = true
    })
    while (Date.now() < deadline) {
      const entry = this.logs().find(log => log.msg === message)
      if (entry !== undefined) return entry
      if (exited) throw new Error(`The application exited before logging "${message}":\n${this.#output}`)
      await Bun.sleep(50)
    }
    throw new Error(`The application did not log "${message}" within ${timeoutMs} ms:\n${this.#output}`)
  }

  /** Sends SIGTERM and waits for the process to exit. */
  async stop(): Promise<Exit> {
    this.#child.kill('SIGTERM')
    return await this.exited
  }

  kill(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL')
  }
}
