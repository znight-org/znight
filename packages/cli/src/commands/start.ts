/**
 * `znight start`: runs the production build with Node.js (or Bun). On POSIX the CLI process is
 * replaced by the runtime (`execve`): same PID, signals and exit code are native (ideal as a
 * container entry point). Elsewhere the application runs as a child process; signals are forwarded
 * and its exit code is returned.
 */
import type { Command } from '../command.ts'

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineCommand } from '../command.ts'
import { CliError } from '../errors.ts'
import { exitCodeOf } from '../integrations/process.ts'
import { type RuntimeOption, resolveRuntime, runtimeArguments, runtimeExecutable } from '../runtime.ts'
import { displayPath, resolveRoot } from './shared.ts'

/** Entries tried when `--entry` is not given. */
const DEFAULT_ENTRIES = ['dist/main.js', 'dist/main.mjs']

/** `znight start` */
export const startCommand: Command = defineCommand({
  meta: {
    name: 'start',
    description: 'Run the production build',
    usage: '[options] [-- <application arguments>]',
    examples: ['znight start', 'znight start --runtime bun', 'znight start --entry dist/worker.js -- --verbose'],
    details:
      'NODE_ENV defaults to "production". Signals (SIGINT, SIGTERM) reach the application, which stops gracefully.',
  },
  args: {
    root: { type: 'string', valueHint: 'dir', description: 'Project root (default: the current directory)' },
    entry: { type: 'string', valueHint: 'file', description: 'File to run (default: dist/main.js)' },
    runtime: {
      type: 'enum',
      options: ['auto', 'node', 'bun'],
      default: 'auto',
      description: 'Runtime of the application (auto: the runtime running the CLI)',
    },
  },
  async run({ args, cli, passthrough }) {
    const root = resolveRoot(cli, args.root)
    const candidates = args.entry === undefined ? DEFAULT_ENTRIES : [args.entry]
    const entry = candidates.map(file => resolve(root, file)).find(file => existsSync(file))
    if (entry === undefined) {
      throw new CliError(`${displayPath(resolve(root, candidates[0] ?? ''), cli.cwd)} not found`, {
        hints: ['build the application first: znight build'],
      })
    }
    const runtime = resolveRuntime(args.runtime as RuntimeOption, cli.runtime)
    const executable = runtimeExecutable(runtime, cli.runtime, cli.env)
    if (executable === undefined) {
      throw new CliError(`Cannot find "${runtime}" in PATH`, { hints: ['install it, or choose another --runtime'] })
    }
    const argv = [...runtimeArguments(runtime), entry, ...passthrough]
    const env = { ...cli.env, NODE_ENV: cli.env['NODE_ENV'] ?? 'production' }
    const { processes } = cli.services
    if (processes.execve !== undefined) {
      const clean: Record<string, string> = {}
      for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value
      processes.execve(executable, [executable, ...argv], clean, root)
      // only reached with a test double (a real execve never returns)
      return 0
    }
    const child = processes.spawn(executable, argv, { cwd: root, env, detached: true })
    const forward = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal)
    }
    const listeners = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => [signal, forward(signal)] as const)
    for (const [signal, listener] of listeners) cli.signals.on(signal, listener)
    try {
      const status = await child.exited
      if (status.error !== undefined) throw new CliError(`Cannot start ${runtime}: ${status.error.message}`)
      return exitCodeOf(status)
    } finally {
      for (const [signal, listener] of listeners) cli.signals.off(signal, listener)
    }
  },
})
