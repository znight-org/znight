/**
 * Process helpers of the end-to-end tests: run a command, start a long-running service, read its
 * JSON log lines, stop it with a signal.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { basename } from 'node:path'

/** Outcome of {@link run}: exit code and stdout + stderr. */
export interface Result {
  readonly code: number | null
  readonly output: string
}

/** Options of {@link run} and {@link start}. */
export interface ProcessOptions {
  readonly cwd: string
  readonly env?: Record<string, string>
}

const environment = (env: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  NO_COLOR: '1',
  ...env,
})

/** Runs a command to completion. */
export function run(command: string, args: readonly string[], options: ProcessOptions): Promise<Result> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: environment(options.env), stdio: 'pipe' })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.on('error', error => resolve({ code: null, output: `${output}\n${error.message}` }))
    child.on('close', code => resolve({ code, output }))
  })
}

/** Throws with the output of the command when it failed. */
export function expectSuccess(result: Result, step: string): void {
  if (result.code !== 0) throw new Error(`${step} failed (exit code ${result.code}):\n${result.output}`)
}

/** A JSON log line (pino). */
export type LogLine = Record<string, unknown> & { readonly msg?: string }

/** A long-running process. */
export interface Service {
  readonly child: ChildProcess
  /** Everything printed so far. */
  output(): string
  /** The JSON log lines printed so far. */
  logs(): LogLine[]
  /** Resolves with the first log line matching `predicate`; rejects on timeout or exit. */
  waitForLog(predicate: (line: LogLine) => boolean, timeoutMs?: number): Promise<LogLine>
  /** Sends `signal` and resolves with the exit code. */
  stop(signal?: NodeJS.Signals): Promise<number | null>
  readonly exit: Promise<number | null>
}

/** Starts a long-running process (stdin is a pipe: `service.child.stdin`). */
export function start(command: string, args: readonly string[], options: ProcessOptions): Service {
  const child = spawn(command, [...args], { cwd: options.cwd, env: environment(options.env), stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', chunk => {
    output += chunk
  })
  child.stderr.on('data', chunk => {
    output += chunk
  })
  let exited = false
  const exit = new Promise<number | null>(resolve => {
    child.once('exit', code => {
      exited = true
      resolve(code)
    })
  })
  const logs = (): LogLine[] =>
    output
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as LogLine)
  return {
    child,
    exit,
    output: () => output,
    logs,
    async waitForLog(predicate, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const line = logs().find(predicate)
        if (line !== undefined) return line
        if (exited) break
        await sleep(50)
      }
      throw new Error(`Log line not found (${exited ? 'the process exited' : 'timeout'}):\n${output}`)
    },
    async stop(signal = 'SIGTERM') {
      if (!exited) child.kill(signal)
      return await exit
    },
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Name of the executable running a process (POSIX `ps`): `node`, `bun`... */
export function executableOf(pid: number): string {
  const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  return basename(args.split(' ')[0] ?? '')
}

/** A port that was free a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject()))
    })
  })
}

/** Fetches `url` as soon as the service answers; fails early when it exits. */
export async function fetchWhenUp(url: string, service: Service, timeoutMs = 30_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  let exited = false
  void service.exit.then(() => {
    exited = true
  })
  while (Date.now() < deadline && !exited) {
    try {
      return await fetch(url)
    } catch {
      await sleep(100)
    }
  }
  throw new Error(`${url} did not answer (${exited ? 'the process exited' : 'timeout'}):\n${service.output()}`)
}
