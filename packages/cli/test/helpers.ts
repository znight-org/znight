import type { CliContextOptions, CliServices, SignalSource } from '../src/context.ts'
import type { ChildHandle, ExitStatus, ProcessService, RunResult, SpawnOptions } from '../src/integrations/process.ts'
import type { OutputStream } from '../src/output.ts'
import type { HostRuntime } from '../src/runtime.ts'

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { main } from '../src/main.ts'

/** A stream capturing what is written. */
export class CaptureStream implements OutputStream {
  readonly chunks: string[] = []
  readonly isTTY: boolean

  constructor(isTTY = false) {
    this.isTTY = isTTY
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  text(): string {
    return this.chunks.join('')
  }
}

/** Process signals emitted by the test. */
export class FakeSignals implements SignalSource {
  readonly listeners = new Map<NodeJS.Signals, Set<() => void>>()

  on(signal: NodeJS.Signals, listener: () => void): void {
    let set = this.listeners.get(signal)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(signal, set)
    }
    set.add(listener)
  }

  off(signal: NodeJS.Signals, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener)
  }

  emit(signal: NodeJS.Signals): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener()
  }

  count(signal: NodeJS.Signals): number {
    return this.listeners.get(signal)?.size ?? 0
  }
}

/** Options of {@link FakeChild}. */
export interface FakeChildOptions {
  /** Exit automatically this many ms after SIGTERM/SIGINT (`undefined`: never, only on SIGKILL). */
  readonly exitAfterMs?: number | undefined
}

/** A fake application process. */
export class FakeChild implements ChildHandle {
  static nextPid = 1000
  readonly pid: number = FakeChild.nextPid++
  readonly signals: NodeJS.Signals[] = []
  readonly exited: Promise<ExitStatus>
  readonly command: string
  readonly args: readonly string[]
  readonly options: SpawnOptions
  #resolve!: (status: ExitStatus) => void
  #done = false
  readonly #exitAfterMs: number | undefined

  constructor(command: string, args: readonly string[], options: SpawnOptions, fake: FakeChildOptions = {}) {
    this.command = command
    this.args = args
    this.options = options
    this.#exitAfterMs = fake.exitAfterMs
    this.exited = new Promise(resolve => {
      this.#resolve = resolve
    })
  }

  get done(): boolean {
    return this.#done
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.#done) return false
    this.signals.push(signal)
    if (signal === 'SIGKILL') this.exit(null, 'SIGKILL')
    else if (this.#exitAfterMs !== undefined) setTimeout(() => this.exit(null, signal), this.#exitAfterMs)
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null, error?: Error): void {
    if (this.#done) return
    this.#done = true
    this.#resolve(error === undefined ? { code, signal } : { code, signal, error })
  }
}

/** Records spawned processes and `run` calls. */
export class FakeProcesses implements ProcessService {
  readonly children: FakeChild[] = []
  readonly runs: { command: string; args: readonly string[]; cwd: string }[] = []
  readonly execs: { file: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string }[] = []
  childOptions: FakeChildOptions = { exitAfterMs: 5 }
  runResult: (command: string, args: readonly string[]) => Partial<RunResult> = () => ({ code: 0 })
  execve: ProcessService['execve']

  constructor(options: { execve?: boolean } = {}) {
    this.execve =
      options.execve === true ? (file, args, env, cwd) => void this.execs.push({ file, args, env, cwd }) : undefined
  }

  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildHandle {
    const child = new FakeChild(command, args, options, this.childOptions)
    this.children.push(child)
    return child
  }

  run(command: string, args: readonly string[], options: { cwd: string }): Promise<RunResult> {
    this.runs.push({ command, args, cwd: options.cwd })
    return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', ...this.runResult(command, args) })
  }
}

export const NODE_RUNTIME: HostRuntime = { name: 'node', execPath: '/usr/bin/node', platform: 'linux' }

/** Result of {@link runCli}. */
export interface CliRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Options of {@link runCli}. */
export interface RunCliOptions extends Omit<CliContextOptions, 'services'> {
  readonly services?: Partial<CliServices>
}

/** Runs the CLI in-process with captured output (no colors, not interactive by default). */
export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<CliRun> {
  const stdout = new CaptureStream()
  const stderr = new CaptureStream()
  const code = await main(argv, {
    env: {},
    interactive: false,
    runtime: NODE_RUNTIME,
    version: '0.1.0',
    signals: new FakeSignals(),
    stdout,
    stderr,
    ...options,
    services: {
      processes: new FakeProcesses(),
      loadCompiler: () => Promise.reject(new Error('no compiler in this test')),
      loadVite: () => Promise.reject(new Error('no vite in this test')),
      loadPrompts: () => Promise.reject(new Error('no prompts in this test')),
      ...options.services,
    },
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

/** A temporary directory, removed by the returned `cleanup`. */
export function temporaryDirectory(prefix = 'znight-cli-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

/** Every file under `root` (POSIX paths, sorted), `.git` excluded. */
export function fileTree(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === '.git' || entry === 'node_modules') continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else files.push(relative(root, path).split('\\').join('/'))
    }
  }
  walk(root)
  return files.sort()
}

/** Resolves after `ms`. */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Waits until `condition()` holds (polling), or fails after `timeoutMs`. */
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: timed out')
    await delay(2)
  }
}
