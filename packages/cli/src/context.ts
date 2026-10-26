/**
 * Everything a command needs from the outside world: streams, environment, runtime and the
 * services (compiler, Vite, processes, prompts, file watching). Tests replace any of them.
 */
import type { CompilerApi } from './integrations/compiler.ts'
import type { ProcessService } from './integrations/process.ts'
import type { Prompts } from './integrations/prompts.ts'
import type { ViteApi } from './integrations/vite.ts'
import type { WatchFactory } from './integrations/watch.ts'
import type { Colors, OutputStream, Reporter } from './output.ts'
import type { HostRuntime } from './runtime.ts'

import { loadCompiler } from './integrations/compiler.ts'
import { createProcessService } from './integrations/process.ts'
import { loadPrompts } from './integrations/prompts.ts'
import { loadVite } from './integrations/vite.ts'
import { watchFiles } from './integrations/watch.ts'
import { createColors, createReporter, shouldUseColor } from './output.ts'
import { detectHostRuntime } from './runtime.ts'
import { cliVersion } from './version.ts'

/** A source of process signals (`process` by default). */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void
  off(signal: NodeJS.Signals, listener: () => void): void
}

/** External services, lazily loaded. */
export interface CliServices {
  /** Loads `@znight/compiler` for the project at `root`. */
  loadCompiler(root: string): Promise<CompilerApi>
  /** Loads `vite` for the project at `root`. */
  loadVite(root: string): Promise<ViteApi>
  /** Loads the interactive prompts. */
  loadPrompts(): Promise<Prompts>
  readonly processes: ProcessService
  readonly watch: WatchFactory
}

/** The execution context of a command. */
export interface CliContext {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdout: OutputStream
  readonly stderr: OutputStream
  /** Whether prompts may be shown (stdin and stdout are TTYs, not in CI). */
  readonly interactive: boolean
  readonly colors: Colors
  readonly reporter: Reporter
  readonly runtime: HostRuntime
  /** Version of `@znight/cli`. */
  readonly version: string
  readonly signals: SignalSource
  readonly services: CliServices
  /** Print stack traces of unexpected errors. */
  readonly debug: boolean
}

/** Overrides accepted by {@link createContext}. */
export interface CliContextOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly stdout?: OutputStream
  readonly stderr?: OutputStream
  readonly interactive?: boolean
  /** `--color` / `--no-color`. */
  readonly color?: boolean | undefined
  readonly runtime?: HostRuntime
  readonly version?: string
  readonly signals?: SignalSource
  readonly services?: Partial<CliServices>
  readonly debug?: boolean
}

const processSignals: SignalSource = {
  on: (signal, listener) => {
    process.on(signal, listener)
  },
  off: (signal, listener) => {
    process.off(signal, listener)
  },
}

/** Creates a context from the current process, with optional overrides. */
export function createContext(options: CliContextOptions = {}): CliContext {
  const env = options.env ?? process.env
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const colors = createColors(shouldUseColor({ env, stream: stdout, flag: options.color }))
  const interactive =
    options.interactive ??
    (process.stdin.isTTY === true && stdout.isTTY === true && env['CI'] === undefined && env['TERM'] !== 'dumb')
  return {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdout,
    stderr,
    interactive,
    colors,
    reporter: createReporter(stdout, stderr, colors),
    runtime: options.runtime ?? detectHostRuntime(),
    version: options.version ?? cliVersion(),
    signals: options.signals ?? processSignals,
    debug:
      options.debug ?? (env['ZNIGHT_DEBUG'] !== undefined && env['ZNIGHT_DEBUG'] !== '' && env['ZNIGHT_DEBUG'] !== '0'),
    services: {
      loadCompiler: options.services?.loadCompiler ?? loadCompiler,
      loadVite: options.services?.loadVite ?? loadVite,
      loadPrompts: options.services?.loadPrompts ?? loadPrompts,
      processes: options.services?.processes ?? createProcessService(),
      watch: options.services?.watch ?? watchFiles,
    },
  }
}
