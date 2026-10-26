/**
 * Child processes: the application (`znight dev` / `znight start`) and tools (`git`, package
 * managers). Behind {@link ProcessService} so that tests can use fake processes.
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { constants } from 'node:os'

/** How a child process ended. */
export interface ExitStatus {
  /** Exit code, `null` when killed by a signal or when the process could not start. */
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** Spawn failure (`ENOENT`...). */
  readonly error?: Error | undefined
}

/** A running child process. */
export interface ChildHandle {
  readonly pid: number | undefined
  /** Sends a signal (to its process group when it runs detached). Returns `false` when it already exited. */
  kill(signal: NodeJS.Signals): boolean
  /** Resolves once the process exited (never rejects). */
  readonly exited: Promise<ExitStatus>
}

/** Options of {@link ProcessService.spawn}. */
export interface SpawnOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Default `'inherit'`. */
  readonly stdio?: 'inherit' | 'ignore'
  /**
   * POSIX only: run the process in its own process group, so that a terminal Ctrl+C reaches the CLI
   * only (the CLI then forwards exactly one signal). The process is killed when the CLI exits.
   */
  readonly detached?: boolean
}

/** Result of {@link ProcessService.run}. */
export interface RunResult extends ExitStatus {
  readonly stdout: string
  readonly stderr: string
}

/** Options of {@link ProcessService.run}. */
export interface RunOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * Replaces the current process image (`execve(2)`) after changing the working directory to `cwd`.
 * `args[0]` is the program name. Never returns on success.
 */
export type ExecveFunction = (
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string,
) => void

/** Process primitives used by the commands. */
export interface ProcessService {
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildHandle
  /** Runs a command to completion, capturing its output. */
  run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult>
  /** `process.execve` when the runtime supports it (POSIX). */
  readonly execve?: ExecveFunction | undefined
}

const detachedChildren = new Set<ChildProcess>()
let exitHookInstalled = false

function killDetachedChildren(): void {
  for (const child of detachedChildren) {
    killTree(child, 'SIGKILL', true)
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals, detached: boolean): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false
  if (detached && child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {
      // the group is gone: fall back to the process itself
    }
  }
  return child.kill(signal)
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

/** Starts a process with `node:child_process`. */
export function spawnProcess(command: string, args: readonly string[], options: SpawnOptions): ChildHandle {
  const detached = options.detached === true && process.platform !== 'win32'
  const child = nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: cleanEnv(options.env),
    stdio: options.stdio ?? 'inherit',
    detached,
    windowsHide: true,
  })
  if (detached) {
    detachedChildren.add(child)
    if (!exitHookInstalled) {
      exitHookInstalled = true
      process.on('exit', killDetachedChildren)
    }
  }
  const exited = new Promise<ExitStatus>(resolve => {
    child.once('error', error => {
      detachedChildren.delete(child)
      resolve({ code: null, signal: null, error })
    })
    child.once('exit', (code, signal) => {
      detachedChildren.delete(child)
      resolve({ code, signal })
    })
  })
  return {
    pid: child.pid,
    kill: signal => killTree(child, signal, detached),
    exited,
  }
}

/** Runs a command to completion with `node:child_process`, capturing stdout and stderr. */
export function runProcess(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise<RunResult>(resolve => {
    const child = nodeSpawn(command, [...args], {
      cwd: options.cwd,
      env: cleanEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // package managers are `.cmd` shims on Windows
      shell: process.platform === 'win32',
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', error => resolve({ code: null, signal: null, error, stdout, stderr }))
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

/** The default {@link ProcessService}. */
export function createProcessService(): ProcessService {
  const execve = (process as { execve?: (file: string, args: string[], env: Record<string, string>) => void }).execve
  return {
    spawn: spawnProcess,
    run: runProcess,
    execve:
      typeof execve === 'function' && process.platform !== 'win32'
        ? (file, args, env, cwd) => {
            process.chdir(cwd)
            execve.call(process, file, [...args], { ...env })
          }
        : undefined,
  }
}

/** Exit code of the CLI mirroring a child's exit status (`128 + n` for signals, like shells). */
export function exitCodeOf(status: ExitStatus): number {
  if (status.code !== null) return status.code
  if (status.signal !== null) return 128 + (constants.signals[status.signal] ?? 1)
  return 1
}
