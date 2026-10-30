/**
 * `znight generate`: writes the DI container module (`src/.znight/container.generated.ts`) with the
 * compiler, checks that it is up to date (`--check`, for CI) or keeps it up to date (`--watch`, for
 * `tsc --watch` and editors).
 */
import type { Command } from '../command.ts'
import type { CliContext } from '../context.ts'
import type {
  CheckResultLike,
  CompileResultLike,
  CompilerApi,
  GenerateResultLike,
  IncrementalCompiler,
  ZnightConfigLike,
  ZnightOptions,
} from '../integrations/compiler.ts'

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineCommand } from '../command.ts'
import { CliError, errorMessage } from '../errors.ts'
import { hasErrors } from '../integrations/compiler.ts'
import { findViteConfig, readZnightPluginOptions, type ViteConfigLoader } from '../integrations/vite.ts'
import {
  changeKind,
  classifyChanges,
  realPath,
  TargetWatchers,
  toPosixPath,
  watchTargets,
} from '../integrations/watch.ts'
import { formatDuration, plural } from '../output.ts'
import { displayPath, onTermination, resolveRoot } from './shared.ts'

/** `znight generate` */
export const generateCommand: Command = defineCommand({
  meta: {
    name: 'generate',
    description: 'Generate the dependency injection container (src/.znight/container.generated.ts)',
    usage: '[options]',
    examples: ['znight generate', 'znight generate --check   # in CI, before tsc', 'znight generate --watch'],
    details: [
      'The compiler options are read from znight.config.* (or the file named by ZNIGHT_CONFIG), the file',
      'shared with the Bun preload; without one, from the znight() plugin of vite.config.ts, so that the',
      'generated file is the same as the one of the Vite build. --config reads the given Vite config.',
      '"znight generate <schematic> <name>" is an alias of "znight g <schematic> <name>".',
    ].join('\n'),
  },
  args: {
    check: {
      type: 'boolean',
      description: 'Do not write: exit with code 1 when the generated file is missing or out of date',
    },
    watch: { type: 'boolean', alias: 'w', description: 'Regenerate on every change' },
    root: { type: 'string', valueHint: 'dir', description: 'Project root (default: the current directory)' },
    config: {
      type: 'string',
      valueHint: 'file',
      description: 'Vite config file to read the znight() options from (instead of znight.config.*)',
    },
    'config-loader': {
      type: 'enum',
      options: ['bundle', 'runner', 'native'],
      description: 'How Vite loads the config file (default: bundle)',
    },
  },
  async run({ args, cli }) {
    const root = resolveRoot(cli, args.root)
    const compiler = await cli.services.loadCompiler(root)
    const configLoader = args['config-loader'] as ViteConfigLoader | undefined
    const options = await compilerOptions(cli, compiler, root, args.config, configLoader)
    if (args.check === true) return check(cli, compiler, options)
    if (args.watch === true) return watch(cli, compiler, options)
    const result = await generateOnce(cli, compiler, options)
    return hasErrors(result.diagnostics) ? 1 : 0
  },
})

/**
 * The compiler options, with `root`: those of `znight.config.*` when the project has one (unless a
 * Vite config is given with `--config`), else those of `znight()` in the Vite config (when exposed),
 * else the defaults.
 */
export async function compilerOptions(
  cli: CliContext,
  compiler: CompilerApi,
  root: string,
  configFile: string | undefined,
  configLoader: ViteConfigLoader | undefined,
): Promise<ZnightOptions> {
  if (configFile === undefined) {
    const shared = await znightConfigOptions(compiler, root)
    if (shared !== undefined) return shared
  }
  let options: ZnightOptions | undefined
  // no Vite config: nothing to read, do not even load Vite
  if (findViteConfig(root, configFile) === undefined) return { root }
  try {
    const vite = await cli.services.loadVite(root)
    const lookup = await readZnightPluginOptions(vite, root, configFile, configLoader)
    if (lookup !== undefined && !lookup.found) {
      cli.reporter.warn(`${displayPath(lookup.configFile, cli.cwd)} does not register the znight() plugin`)
    }
    options = lookup?.options
  } catch (error) {
    if (configFile !== undefined) {
      throw new CliError(`Cannot load the Vite config ${configFile}`, { cause: error, hints: [errorMessage(error)] })
    }
    cli.reporter.warn(
      `Cannot read the znight() options from the Vite config, using the defaults: ${errorMessage(error)}`,
    )
  }
  return { ...options, root: resolve(root, options?.root ?? '.') }
}

/** Options of `znight.config.*` (`loadZnightConfig()` of the compiler), `undefined` without the file. */
async function znightConfigOptions(compiler: CompilerApi, root: string): Promise<ZnightOptions | undefined> {
  if (compiler.loadConfig === undefined) return undefined
  let config: ZnightConfigLike
  try {
    config = await compiler.loadConfig(root)
  } catch (error) {
    throw new CliError('Cannot load the Znight config (znight.config.*)', {
      cause: error,
      hints: [errorMessage(error)],
    })
  }
  if (config.file === undefined) return undefined
  // `logLevel` is an option of the Bun preload only
  const { logLevel: _preloadLogLevel, ...options } = config.options
  return { ...options, root: resolve(root, options.root ?? '.') }
}

function printDiagnostics(cli: CliContext, compiler: CompilerApi, result: CompileResultLike, root: string): void {
  if (result.diagnostics.length === 0) return
  const text = compiler.formatDiagnostics(result.diagnostics, {
    color: cli.colors.isColorSupported,
    cwd: root,
    summary: false,
  })
  cli.reporter.logError(text.trimEnd())
  cli.reporter.logError()
}

function statsOf(result: CompileResultLike, elapsedMs: number): string {
  const parts: string[] = []
  if (result.stats?.providers !== undefined) parts.push(plural(result.stats.providers, 'provider'))
  if (result.stats?.files !== undefined) parts.push(plural(result.stats.files, 'file'))
  parts.push(formatDuration(result.stats?.durationMs ?? elapsedMs))
  return parts.join(', ')
}

function failure(cli: CliContext, result: CompileResultLike): void {
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
  cli.reporter.error(`Generation failed with ${plural(errors, 'error')}`)
}

/** Prints the outcome of a generation. */
function report(
  cli: CliContext,
  compiler: CompilerApi,
  result: GenerateResultLike,
  root: string,
  elapsed: number,
): void {
  printDiagnostics(cli, compiler, result, root)
  if (hasErrors(result.diagnostics)) {
    failure(cli, result)
    return
  }
  const file = displayPath(result.outFile, cli.cwd)
  cli.reporter.success(
    `${result.written ? 'Generated' : 'Up to date:'} ${cli.colors.bold(file)} ${cli.colors.dim(`(${statsOf(result, elapsed)})`)}`,
  )
}

async function generateOnce(
  cli: CliContext,
  compiler: CompilerApi,
  options: ZnightOptions,
): Promise<GenerateResultLike> {
  const started = performance.now()
  const result = await compiler.generate(options)
  report(cli, compiler, result, options.root ?? cli.cwd, performance.now() - started)
  return result
}

/**
 * The generated files `--check` reports, the module first: those the compiler says are stale (the
 * module when it does not say which), and the module when it is missing.
 */
function staleFilesOf(result: CheckResultLike): string[] {
  const stale = new Set<string>()
  if (!existsSync(result.outFile)) stale.add(result.outFile)
  if (result.stale) {
    const files = result.staleFiles ?? []
    for (const file of files.length > 0 ? files : [result.outFile]) stale.add(file)
  }
  return [...stale].sort((a, b) => Number(b === result.outFile) - Number(a === result.outFile))
}

async function check(cli: CliContext, compiler: CompilerApi, options: ZnightOptions): Promise<number> {
  const root = options.root ?? cli.cwd
  const started = performance.now()
  const result = await compiler.check(options)
  printDiagnostics(cli, compiler, result, root)
  if (hasErrors(result.diagnostics)) {
    failure(cli, result)
    return 1
  }
  const file = displayPath(result.outFile, cli.cwd)
  const stale = staleFilesOf(result)
  for (const path of stale) {
    const shown = displayPath(path, cli.cwd)
    // the other generated file is the library manifest (`dist/znight.providers.json`)
    const hint =
      path === result.outFile
        ? 'run "znight generate" (it is git-ignored: generate it before tsc and tests)'
        : 'run "znight generate" after the build: a build cleaning dist/ (tsdown, tsc --build --clean...) deletes it'
    if (existsSync(path)) cli.reporter.error(`${shown} is out of date`, ['run "znight generate"'])
    else cli.reporter.error(`${shown} is missing`, [hint])
  }
  if (stale.length > 0) return 1
  cli.reporter.success(
    `${cli.colors.bold(file)} is up to date ${cli.colors.dim(`(${statsOf(result, performance.now() - started)})`)}`,
  )
  return 0
}

/** What the watcher knows about the last compile. */
interface WatchState {
  /** Files the last compile depends on (`watchFiles`): absolute, real, POSIX-style. */
  readonly known: ReadonlySet<string>
  /** Directories where a created or deleted source changes the scan (`includeRoots()`). */
  readonly roots: readonly string[]
}

async function watch(cli: CliContext, compiler: CompilerApi, options: ZnightOptions): Promise<number> {
  const root = options.root ?? cli.cwd
  const realRoot = realPath(root)
  const incremental: IncrementalCompiler = compiler.createIncremental(options)
  let state: WatchState = { known: new Set(), roots: [] }
  let pending = new Set<string>()
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined

  // which events matter is the compiler's call: the CLI only tells their kind, which fs.watch does not
  const watchers = new TargetWatchers(cli.services.watch, file => {
    const path = realPath(file)
    if (!incremental.isRelevantChange(changeKind(path, state.known), path, state.known, state.roots)) return
    pending.add(path)
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void run(false)
    }, 50)
  })

  const run = async (initial: boolean): Promise<void> => {
    if (running) return
    running = true
    let first = initial
    try {
      do {
        const files = pending
        pending = new Set()
        const started = performance.now()
        let known = state.known
        try {
          const result = await incremental.generate(first ? undefined : classifyChanges(files, state.known))
          if (result.watchFiles !== undefined) {
            known = new Set(result.watchFiles.map(file => toPosixPath(resolve(file))))
          }
          report(cli, compiler, result, root, performance.now() - started)
        } catch (error) {
          cli.reporter.error(`Generation failed: ${errorMessage(error)}`)
        }
        // the include directories of the source libraries are known once compiled
        state = { known, roots: incremental.includeRoots().map(realPath) }
        watchers.update(watchTargets(realRoot, state.roots, state.known), files)
        first = false
      } while (pending.size > 0)
    } finally {
      running = false
    }
  }

  await run(true)
  cli.reporter.info(cli.colors.dim('Watching for changes... (Ctrl+C to stop)'))

  return new Promise<number>(resolveExit => {
    const dispose = onTermination(
      cli,
      () => {
        if (timer !== undefined) clearTimeout(timer)
        watchers.close()
        dispose()
        resolveExit(0)
      },
      () => undefined,
    )
  })
}
