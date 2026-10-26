/**
 * `znight dev`: Vite build in watch mode (no Vite dev server) and a full restart of the application
 * process after every successful rebuild — no partial hot replacement of providers: a restart is
 * fast and always consistent. A failed build keeps the last good process running, and so does a
 * failed compilation: in watch mode the `znight()` plugin does not fail the build (the bundle
 * contains a module throwing the diagnostics), so its result (`plugin.api.result`) is checked
 * before restarting.
 */
import type { Command } from '../command.ts'
import type { CliContext } from '../context.ts'
import type { Diagnostic } from '../integrations/compiler.ts'
import type { BuildWatcher, ViteConfigLoader, ViteLogLevel, WatcherEvent } from '../integrations/vite.ts'

import { resolve } from 'node:path'

import { defineCommand } from '../command.ts'
import { AppSupervisor } from '../dev/supervisor.ts'
import { CliError } from '../errors.ts'
import { fallbackFormatDiagnostics } from '../integrations/compiler.ts'
import { exitCodeOf } from '../integrations/process.ts'
import { createOutputTracker, formatBuildError, watchBuild } from '../integrations/vite.ts'
import { formatDuration, plural } from '../output.ts'
import { type RuntimeOption, resolveRuntime, runtimeArguments, runtimeExecutable } from '../runtime.ts'
import { displayPath, onTermination, parseNonNegativeInteger, resolveRoot } from './shared.ts'

/** Clears the terminal and its scrollback. */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

/** `znight dev` */
export const devCommand: Command = defineCommand({
  meta: {
    name: 'dev',
    description: 'Build in watch mode and restart the application after every successful rebuild',
    usage: '[options] [-- <application arguments>]',
    examples: ['znight dev', 'znight dev --runtime bun --clear', 'znight dev --inspect -- --verbose'],
    details: [
      'Uses "vite build --watch" with the project Vite config (the znight() plugin regenerates the container).',
      'On every successful build the application receives SIGTERM, gets --kill-timeout ms to stop gracefully',
      '(then SIGKILL), and a new process starts. A failed build or compilation (ZNIGHT errors) keeps the',
      'last good process running.',
    ].join('\n'),
  },
  args: {
    root: { type: 'string', valueHint: 'dir', description: 'Project root (default: the current directory)' },
    config: { type: 'string', valueHint: 'file', description: 'Vite config file (default: vite.config.*)' },
    mode: { type: 'string', default: 'development', description: 'Vite mode' },
    'config-loader': {
      type: 'enum',
      options: ['bundle', 'runner', 'native'],
      description: 'How Vite loads the config file (default: bundle)',
    },
    runtime: {
      type: 'enum',
      options: ['auto', 'node', 'bun'],
      default: 'auto',
      description: 'Runtime of the application (auto: the runtime running the CLI)',
    },
    entry: { type: 'string', valueHint: 'file', description: 'File to run (default: the entry chunk of the build)' },
    inspect: { type: 'boolean', description: 'Start the application with --inspect (debugger)' },
    clear: { type: 'boolean', description: 'Clear the screen before each rebuild' },
    debounce: { type: 'string', valueHint: 'ms', default: '100', description: 'Delay before restarting after a build' },
    'kill-timeout': {
      type: 'string',
      valueHint: 'ms',
      default: '5000',
      description: 'Time the application gets to stop after SIGTERM before SIGKILL',
    },
    'log-level': {
      type: 'enum',
      options: ['info', 'warn', 'error', 'silent'],
      default: 'warn',
      description: 'Vite log level',
    },
  },
  async run({ args, cli, passthrough }) {
    const root = resolveRoot(cli, args.root)
    const debounceMs = parseNonNegativeInteger(args.debounce, 'debounce', 100)
    const killTimeoutMs = parseNonNegativeInteger(args['kill-timeout'], 'kill-timeout', 5000)
    const runtime = resolveRuntime(args.runtime as RuntimeOption, cli.runtime)
    const executable = runtimeExecutable(runtime, cli.runtime, cli.env)
    if (executable === undefined) {
      throw new CliError(`Cannot find "${runtime}" in PATH`, { hints: ['install it, or choose another --runtime'] })
    }
    const logLevel = args['log-level'] as ViteLogLevel
    const { colors, reporter } = cli
    const vite = await cli.services.loadVite(root)
    const tracker = createOutputTracker(root)
    let entry: string | undefined

    const supervisor = new AppSupervisor({
      debounceMs,
      killTimeoutMs,
      spawn: () => {
        const file = entry ?? resolve(root, 'dist/main.js')
        return cli.services.processes.spawn(
          executable,
          [...runtimeArguments(runtime, args.inspect === true ? ['--inspect'] : []), file, ...passthrough],
          { cwd: root, env: { ...cli.env, NODE_ENV: cli.env['NODE_ENV'] ?? 'development' }, detached: true },
        )
      },
      events: {
        onStart: (child, restart) => {
          const file = displayPath(entry ?? resolve(root, 'dist/main.js'), cli.cwd)
          reporter.info(
            `${restart ? 'Restarted' : 'Started'} ${colors.bold(file)} ${colors.dim(`(${runtime}, pid ${child.pid ?? '?'})`)}`,
          )
        },
        onStop: (_status, forced) => {
          if (forced) reporter.warn(`The application did not stop within ${killTimeoutMs}ms: killed`)
        },
        onExit: status => {
          if (status.error !== undefined) {
            reporter.error(`Cannot start ${runtime}: ${status.error.message}`)
            return
          }
          const code = exitCodeOf(status)
          const message = `The application exited with code ${code}${status.signal === null ? '' : ` (${status.signal})`}`
          if (code === 0) reporter.info(`${message}. Waiting for changes...`)
          else reporter.error(`${message}. Waiting for changes...`)
        },
        onError: error =>
          reporter.error(`Cannot start the application: ${error instanceof Error ? error.message : String(error)}`),
      },
    })

    const state = { failed: false, first: true, started: 0 }
    const onEvent = (event: WatcherEvent): void => {
      switch (event.code) {
        case 'START':
          state.failed = false
          state.started = performance.now()
          if (!state.first) {
            if (args.clear === true && cli.stdout.isTTY === true) cli.stdout.write(CLEAR_SCREEN)
            reporter.info(colors.dim('Change detected, rebuilding...'))
          }
          break
        case 'ERROR':
          state.failed = true
          state.first = false
          // Vite closes the build of BUNDLE_END itself, not the one of ERROR
          void Promise.resolve()
            .then(() => event.result?.close())
            .catch(() => undefined)
          // Vite logs build errors itself, unless it is silenced
          if (logLevel === 'silent') reporter.logError(formatBuildError(event.error))
          reporter.error(
            `Build failed. ${supervisor.running ? 'The last good build keeps running. ' : ''}Waiting for changes...`,
          )
          break
        case 'END': {
          state.first = false
          if (state.failed) break
          // the bundle was written, but with a failed compile it throws the diagnostics at startup
          const compile = tracker.compile()
          if (compile !== undefined && !compile.ok) {
            // a restart still pending for a previous build would run this broken output
            supervisor.cancelRestart()
            const errors = compile.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
            // the znight() plugin prints the diagnostics through the Vite logger, unless it is silenced
            const printed = logLevel === 'silent' ? printDiagnostics(cli, root, compile.diagnostics) : Promise.resolve()
            void printed.then(() =>
              reporter.error(
                `Compilation failed with ${plural(errors, 'error')}. ${supervisor.running ? 'The last good build keeps running. ' : ''}Waiting for changes...`,
              ),
            )
            break
          }
          entry = args.entry === undefined ? (tracker.entry() ?? entry) : resolve(root, args.entry)
          reporter.success(`Built in ${formatDuration(performance.now() - (tracker.startedAt() ?? state.started))}`)
          supervisor.scheduleRestart()
          break
        }
        default:
          break
      }
    }

    reporter.info(
      `${colors.bold('znight dev')} ${colors.dim(`v${cli.version}`)} — vite build --watch, ${runtime} runtime`,
    )
    let watcher: BuildWatcher
    try {
      watcher = await watchBuild(vite, {
        root,
        configFile: args.config,
        configLoader: args['config-loader'] as ViteConfigLoader | undefined,
        mode: args.mode,
        logLevel,
        plugins: [tracker.plugin],
      })
    } catch (error) {
      if (error instanceof CliError) throw error
      // configuration errors (the config file does not load, invalid options...)
      reporter.logError(formatBuildError(error))
      throw new CliError('Cannot start the Vite build', { cause: error })
    }
    watcher.on('event', onEvent)
    return waitForTermination(cli, watcher, supervisor)
  },
})

/** Prints compiler diagnostics with the project's `formatDiagnostics()` (a built-in formatter otherwise). */
async function printDiagnostics(cli: CliContext, root: string, diagnostics: readonly Diagnostic[]): Promise<void> {
  if (diagnostics.length === 0) return
  const options = { color: cli.colors.isColorSupported, cwd: root, summary: false }
  let text: string
  try {
    text = (await cli.services.loadCompiler(root)).formatDiagnostics(diagnostics, options)
  } catch {
    text = fallbackFormatDiagnostics(diagnostics, options)
  }
  cli.reporter.logError(text.trimEnd())
}

function waitForTermination(cli: CliContext, watcher: BuildWatcher, supervisor: AppSupervisor): Promise<number> {
  return new Promise<number>(resolveExit => {
    const dispose = onTermination(
      cli,
      signal => {
        cli.reporter.info(cli.colors.dim('Stopping... (press Ctrl+C again to force)'))
        void (async () => {
          try {
            await watcher.close()
          } finally {
            await supervisor.stop(signal)
            dispose()
            resolveExit(0)
          }
        })()
      },
      () => {
        supervisor.kill()
        dispose()
        resolveExit(130)
      },
    )
  })
}
