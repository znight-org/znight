/**
 * The Vite plugin (§6.3): `znight(options)` compiles the application with one incremental compiler
 * per plugin instance (shared by every Vite environment), serves the generated module from memory,
 * strips the Znight decorators from the bundle and recompiles when sources change, in `vite build`,
 * `vite build --watch`, the dev server and Vitest.
 *
 * ```ts
 * // vite.config.ts
 * import { znight } from '@znight/compiler'
 * export default { plugins: [znight()] }
 * ```
 *
 * Only `import type` from `vite`: importing `@znight/compiler` never loads Vite.
 */
import type {
  DevEnvironment,
  EnvironmentModuleNode,
  HotUpdateOptions,
  Plugin,
  ResolvedConfig,
  UserConfig,
  ViteDevServer,
} from 'vite'
import type { CompileMode, CompileResult, ZnightCompiler } from './compiler.ts'
import type { StringAlias, ZnightOptions } from './options.ts'
import type { StripResult } from './strip.ts'
import type { ChangeKind } from './watch.ts'

import fs from 'node:fs'
import path from 'node:path'
import pc from 'picocolors'

import { createCompiler, writeIfChanged } from './compiler.ts'
import { formatDiagnostics } from './diagnostics/format.ts'
import { DEFAULT_APP_ENTRY, DEFAULT_OUT_FILE } from './options.ts'
import { isWithin, realPath, resolvePath } from './project/paths.ts'
import { applicableRanges, stripDecorators } from './strip.ts'
import { includeRoots, isOutFile, isRelevantChange, PendingChanges } from './watch.ts'

/** What `znight()` exposes as `plugin.api` (read by the `znight` CLI and by tooling). */
export interface ZnightPluginApi {
  /** The options given to `znight()`, unchanged (`znight generate` compiles with them). */
  readonly options: ZnightOptions
  /** The incremental compiler, created when Vite resolves its config. */
  readonly compiler: ZnightCompiler | undefined
  /** The latest compile result (`undefined` before the first compile). */
  readonly result: CompileResult | undefined
  /** Compiles the pending changes (if any) and returns the up-to-date result. */
  ready(): Promise<CompileResult>
}

/** Rolldown `watchChange` events and `hotUpdate` types. */
const EVENT_KINDS: Readonly<Record<'create' | 'update' | 'delete', ChangeKind>> = {
  create: 'added',
  update: 'changed',
  delete: 'removed',
}

/** Dev server (chokidar) events that can change the compile result. */
const SERVER_EVENTS: ReadonlyMap<string, ChangeKind> = new Map([
  ['add', 'added'],
  ['change', 'changed'],
  ['unlink', 'removed'],
])

/** How long file events are batched before a compile in the dev server (ms). */
const DEBOUNCE_MS = 50

/** Files whose Znight decorators may be stripped. */
const SOURCE_FILTER = /\.(?:[cm]?[jt]sx?)(?:\?.*)?$/

/** Extensions an import of the generated module may use (`.js` is mapped to `.ts` by bundlers). */
const MODULE_EXTENSIONS = new Set(['', '.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'])

/**
 * The Znight Vite plugin. Applies to the server environments only (SSR, Vitest's node
 * environment); one compile is shared by all of them.
 *
 * - `vite build`: compile errors fail the build with formatted diagnostics, nothing is written;
 * - `vite build --watch`, dev server, Vitest: diagnostics are printed and, on errors, the generated
 *   module throws them when imported; sources are watched and recompiled incrementally;
 * - with the `app` defaults (unless `app: false` or `build.ssr`/`build.lib` is set), `vite build`
 *   builds `src/main.ts` for Node.js into `dist/`.
 */
export function znight(options: ZnightOptions = {}): Plugin<ZnightPluginApi> {
  const state = new PluginState(options)
  const generatedId = new RegExp(escapeRegExp(stem(options.outFile ?? DEFAULT_OUT_FILE)))
  return {
    name: 'znight',
    enforce: 'pre',
    sharedDuringBuild: true,
    perEnvironmentStartEndDuringDev: true,
    api: {
      get options(): ZnightOptions {
        return options
      },
      get compiler(): ZnightCompiler | undefined {
        return state.compiler
      },
      get result(): CompileResult | undefined {
        return state.result
      },
      ready: () => state.ready(),
    },
    applyToEnvironment(environment) {
      return environment.config.consumer === 'server'
    },
    config(config) {
      return state.configure(config)
    },
    configResolved(config) {
      state.resolve(config)
    },
    configureServer(server) {
      state.attachServer(server)
    },
    closeServer() {
      state.detachServer()
    },
    async buildStart() {
      const kind = sessionKind(this.environment.mode === 'dev', this.meta.watchMode)
      let outcome: BuildStartOutcome
      try {
        outcome = await state.buildStart(kind)
      } catch (error) {
        return this.error(error instanceof Error ? error : String(error))
      }
      for (const file of outcome.watchPaths) {
        this.addWatchFile(file)
      }
      if (outcome.error !== undefined) {
        this.error(outcome.error)
      }
    },
    watchChange(id, change) {
      state.watchChange(id, change.event)
    },
    resolveId: {
      filter: { id: generatedId },
      handler(source, importer) {
        return state.resolveId(source, importer)
      },
    },
    load: {
      filter: { id: generatedId },
      async handler(id) {
        const code = await state.load(id, this.environment.name)
        return code === undefined ? null : { code, map: null }
      },
    },
    hotUpdate(options) {
      return state.hotUpdate(this.environment, options)
    },
    transform: {
      filter: { id: SOURCE_FILTER },
      async handler(code, id) {
        return (await state.transform(code, id)) ?? null
      },
    },
    async writeBundle() {
      await state.writeLibrary()
    },
  }
}

/** Kind of compile session: `vite build`, `vite build --watch`, or a dev server (Vitest included). */
type SessionKind = 'build' | 'watch' | 'dev'

interface BuildStartOutcome {
  /** Files and directories to watch (`addWatchFile`). */
  readonly watchPaths: readonly string[]
  /** The error failing a `vite build` (formatted diagnostics). */
  readonly error: Error | undefined
}

class PluginState {
  readonly options: ZnightOptions
  #compiler: ZnightCompiler | undefined
  #key: string | undefined
  #config: ResolvedConfig | undefined
  #server: ViteDevServer | undefined
  #kind: SessionKind = 'build'
  /** A full compile is due (first compile of a session: the config was (re)resolved). */
  #full = true
  readonly #pending = new PendingChanges()
  /** Latest requested compile. */
  #latest: Promise<CompileResult> | undefined
  #compiling = 0
  /** Latest published result. */
  #result: CompileResult | undefined
  #watched: ReadonlySet<string> = new Set()
  #roots: readonly string[] = []
  /** Debounce timer of the dev server file events. */
  #timer: ReturnType<typeof setTimeout> | undefined
  /** The compile the timer will start: module loads wait for it, so a burst of events is complete. */
  #scheduled: PromiseWithResolvers<CompileResult> | undefined
  #lastDiagnostics = ''
  readonly #serverWatched = new Set<string>()
  readonly #listeners: [event: string, listener: (file: string) => void][] = []
  /** Environments waiting for the generated module (`load`): they will get the next result. */
  readonly #loading = new Map<string, number>()

  constructor(options: ZnightOptions) {
    this.options = options
  }

  get compiler(): ZnightCompiler | undefined {
    return this.#compiler
  }

  get result(): CompileResult | undefined {
    return this.#result
  }

  // ------------------------------------------------------------------ config

  /** `config` hook: a new session (next compile is full), app defaults, watchers ignore the outFile. */
  configure(config: UserConfig): UserConfig {
    this.#full = true
    const viteRoot = resolvePath(config.root ?? '.')
    const root = resolvePath(this.options.root ?? '.', viteRoot)
    const outFile = resolvePath(this.options.outFile ?? DEFAULT_OUT_FILE, root)
    // the generated module and the temporary files of its atomic writes, also through symlinks
    const outFiles = [...new Set([outFile, `${realPath(root) ?? root}/${path.posix.relative(root, outFile)}`])]
    const ignored = outFiles.map(file => new RegExp(`^${escapeRegExp(file)}(?:\\.[^/]*\\.tmp)?$`))
    const result: UserConfig = {}
    if (config.server?.watch !== null) {
      result.server = {
        watch: { ignored: [(file: string) => ignored.some(pattern => pattern.test(resolvePath(file)))] },
      }
    }
    const build: NonNullable<UserConfig['build']> = {}
    if (config.build?.watch) {
      build.watch = { exclude: ignored }
    }
    const app = this.options.app
    if (app !== false && !config.build?.ssr && !config.build?.lib) {
      build.ssr = resolvePath(app?.entry ?? DEFAULT_APP_ENTRY, root)
      if (config.build?.outDir === undefined) {
        build.outDir = 'dist'
      }
      if (config.build?.target === undefined) {
        build.target = 'node24'
      }
      if (config.build?.sourcemap === undefined) {
        build.sourcemap = true
      }
      if (config.ssr?.target === undefined) {
        result.ssr = { target: 'node' }
      }
    }
    if (Object.keys(build).length > 0) {
      result.build = build
    }
    return result
  }

  /** `configResolved` hook: creates the compiler (kept when the environment-dependent inputs are the same). */
  resolve(config: ResolvedConfig): void {
    this.#config = config
    const server = Object.values(config.environments).find(environment => environment.consumer === 'server')
    const environmentCondition = config.isProduction ? 'production' : 'development'
    const conditions = (server?.resolve.conditions ?? []).map(condition =>
      condition === 'development|production' ? environmentCondition : condition,
    )
    const runtimeConditions = [...new Set([...conditions, 'node', 'import', 'default'])]
    const aliases: StringAlias[] = []
    for (const alias of config.resolve.alias) {
      if (typeof alias.find === 'string') {
        aliases.push({ find: alias.find, replacement: alias.replacement })
      }
    }
    const mode = compileMode(config)
    const key = JSON.stringify([config.root, mode, runtimeConditions, aliases])
    if (this.#compiler && this.#key === key) {
      return
    }
    this.#compiler = createCompiler({ ...this.options, cwd: config.root, mode, runtimeConditions, aliases })
    this.#key = key
    this.#full = true
    this.#latest = undefined
    this.#result = undefined
    this.#pending.clear()
  }

  // ------------------------------------------------------------------ compile

  /** Compiles what changed since the last compile (everything at the start of a session), now. */
  ready(): Promise<CompileResult> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    const scheduled = this.#scheduled
    this.#scheduled = undefined
    const promise = this.#compile()
    if (scheduled !== undefined) {
      promise.then(scheduled.resolve, scheduled.reject)
    }
    return promise
  }

  /** The up-to-date result, once the pending (debounced) file events are compiled. */
  settled(): Promise<CompileResult> {
    return this.#scheduled?.promise ?? this.ready()
  }

  async #compile(): Promise<CompileResult> {
    const compiler = this.#require()
    const full = this.#full || this.#latest === undefined
    const changes = this.#pending.take()
    if (!full && changes === undefined && this.#latest !== undefined) {
      return this.#latest
    }
    this.#full = false
    const promise = compiler.compile(full ? undefined : changes)
    this.#latest = promise
    this.#compiling++
    try {
      const result = await promise
      if (this.#latest === promise) {
        await this.#publish(compiler, result)
      }
      return result
    } catch (error) {
      if (this.#latest === promise) {
        this.#latest = undefined
        this.#full = true
      }
      throw error
    } finally {
      this.#compiling--
    }
  }

  /** `buildStart`: compiles; in `vite build` errors are returned formatted (the build fails). */
  async buildStart(kind: SessionKind): Promise<BuildStartOutcome> {
    this.#kind = this.#server ? 'dev' : kind
    const result = await this.ready()
    const compiler = this.#require()
    const watchPaths = kind === 'dev' ? [] : this.#watchPaths(compiler, result)
    const error = kind === 'build' && !result.ok ? compileFailure(result, compiler.options.root) : undefined
    return { watchPaths, error }
  }

  /** `watchChange` (`vite build --watch`): records the change for the next `buildStart`. */
  watchChange(id: string, event: 'create' | 'update' | 'delete'): void {
    const compiler = this.#compiler
    if (compiler === undefined || this.#server !== undefined) {
      return
    }
    // editors often replace a file (reported as a creation): a known file is a change
    const kind = event === 'create' && this.#watched.has(resolvePath(id)) ? 'changed' : EVENT_KINDS[event]
    if (isRelevantChange(compiler, kind, id, this.#watched, this.#roots)) {
      this.#pending.add(kind, id)
    }
  }

  // ------------------------------------------------------------------ modules

  /** Imports of the generated module (relative, absolute or root-relative) resolve to the outFile. */
  resolveId(source: string, importer: string | undefined): string | null {
    const compiler = this.#compiler
    if (compiler === undefined) {
      return null
    }
    const specifier = withoutQuery(source)
    const candidates: string[] = []
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (importer !== undefined && path.isAbsolute(withoutQuery(importer))) {
        candidates.push(path.resolve(path.dirname(withoutQuery(importer)), specifier))
      }
    } else if (path.isAbsolute(specifier)) {
      candidates.push(specifier)
      if (specifier.startsWith('/') && this.#config !== undefined) {
        candidates.push(path.join(this.#config.root, specifier))
      }
    }
    const outFile = compiler.options.outFile
    for (const candidate of candidates) {
      const resolved = resolvePath(candidate)
      const extension = path.posix.extname(resolved)
      const base = MODULE_EXTENSIONS.has(extension) ? resolved.slice(0, resolved.length - extension.length) : resolved
      if (isOutFile(compiler, `${base}${path.posix.extname(outFile)}`) || isOutFile(compiler, resolved)) {
        return outFile
      }
    }
    return null
  }

  /** The generated module, from memory (the error module when the compilation failed). */
  async load(id: string, environment: string): Promise<string | undefined> {
    const compiler = this.#compiler
    if (compiler === undefined || !isOutFile(compiler, withoutQuery(id))) {
      return undefined
    }
    this.#loading.set(environment, (this.#loading.get(environment) ?? 0) + 1)
    try {
      return (await this.settled()).code
    } finally {
      const count = (this.#loading.get(environment) ?? 1) - 1
      if (count === 0) {
        this.#loading.delete(environment)
      } else {
        this.#loading.set(environment, count)
      }
    }
  }

  /**
   * `hotUpdate` (dev server): a change that can change the compile result also updates the
   * generated module, in the same HMR batch (its reload then waits for the recompile).
   */
  hotUpdate(environment: DevEnvironment, options: HotUpdateOptions): EnvironmentModuleNode[] | undefined {
    const compiler = this.#compiler
    if (compiler === undefined) {
      return undefined
    }
    const kind = EVENT_KINDS[options.type]
    if (!isRelevantChange(compiler, kind, options.file, this.#watched, this.#roots)) {
      return undefined
    }
    const generated = environment.moduleGraph.getModuleById(compiler.options.outFile)
    if (generated === undefined || options.modules.includes(generated)) {
      return undefined
    }
    return [...options.modules, generated]
  }

  /** Strips the decorator ranges recorded for exactly this content. */
  async transform(code: string, id: string): Promise<StripResult | undefined> {
    const compiler = this.#compiler
    if (compiler === undefined || !compiler.options.stripDecorators || id.startsWith('\0')) {
      return undefined
    }
    // the generated module is not scanned: it is never stripped
    const file = resolvePath(withoutQuery(id))
    let entry = applicableRanges(code, this.#result?.decorators.get(file))
    if (entry === undefined && this.#busy() && compiler.project.isScanned(file)) {
      entry = applicableRanges(code, (await this.settled()).decorators.get(file))
    }
    return entry === undefined ? undefined : stripDecorators(code, entry, file)
  }

  /** `writeBundle`: library mode writes `znight.providers.json` once the output directory is written. */
  async writeLibrary(): Promise<void> {
    const library = this.#result?.library
    if (library !== undefined) {
      await writeIfChanged(library.file, library.content)
    }
  }

  // ------------------------------------------------------------------ dev server

  /**
   * Listens to the server watcher **before** Vite's own handlers (prepended): when Vite reloads a
   * module importing the generated one, the change is already recorded and the load waits for it.
   */
  attachServer(server: ViteDevServer): void {
    this.#server = server
    this.#kind = 'dev'
    for (const event of SERVER_EVENTS.keys()) {
      const listener = (file: string): void => this.#onServerEvent(event, file)
      server.watcher.prependListener(event, listener)
      this.#listeners.push([event, listener])
    }
  }

  detachServer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    for (const [event, listener] of this.#listeners.splice(0)) {
      this.#server?.watcher.off(event, listener)
    }
  }

  #onServerEvent(event: string, file: string): void {
    const compiler = this.#compiler
    const kind = SERVER_EVENTS.get(event)
    if (compiler === undefined || kind === undefined) {
      return
    }
    if (!isRelevantChange(compiler, kind, file, this.#watched, this.#roots)) {
      return
    }
    this.#pending.add(kind, file)
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
    }
    if (this.#scheduled === undefined) {
      const scheduled = Promise.withResolvers<CompileResult>()
      scheduled.promise.catch((error: unknown) => {
        this.#config?.logger.error(
          `${pc.cyan('[znight]')} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        )
      })
      this.#scheduled = scheduled
    }
    this.#timer = setTimeout(() => {
      this.ready().catch(() => {
        // reported by the scheduled promise
      })
    }, DEBOUNCE_MS)
    this.#timer.unref?.()
  }

  /** Watches the include roots and the files of the result that the server does not watch yet. */
  #watchServerPaths(compiler: ZnightCompiler, result: CompileResult): void {
    const server = this.#server
    if (server === undefined) {
      return
    }
    const root = resolvePath(server.config.root)
    const paths = this.#watchPaths(compiler, result).filter(
      file => !isWithin(root, file) && !this.#serverWatched.has(file),
    )
    for (const file of paths) {
      this.#serverWatched.add(file)
    }
    if (paths.length > 0) {
      server.watcher.add(paths)
    }
  }

  /** Re-executes the generated module (and its importers) in the server environments. */
  async #reloadGenerated(outFile: string): Promise<void> {
    const server = this.#server
    if (server === undefined) {
      return
    }
    for (const environment of Object.values(server.environments)) {
      if (environment.config.consumer !== 'server' || this.#loading.has(environment.name)) {
        continue
      }
      const module = environment.moduleGraph.getModuleById(outFile)
      if (module !== undefined) {
        await environment.reloadModule(module)
      }
    }
  }

  // ------------------------------------------------------------------ internals

  #require(): ZnightCompiler {
    if (this.#compiler === undefined) {
      throw new Error('[znight] the Vite config is not resolved yet')
    }
    return this.#compiler
  }

  /** A compile is running or due: transforms wait for it rather than skipping a stale file. */
  #busy(): boolean {
    return this.#compiling > 0 || this.#timer !== undefined || this.#pending.size > 0 || this.#full
  }

  #watchPaths(compiler: ZnightCompiler, result: CompileResult): string[] {
    // module resolution inputs: the root tsconfig and the `tsconfig` option
    const tsconfig = compiler.options.tsconfig
    const paths = new Set([
      ...includeRoots(compiler),
      ...result.watchFiles,
      `${compiler.options.root}/tsconfig.json`,
      ...(typeof tsconfig === 'string' ? [tsconfig] : []),
    ])
    return [...paths].filter(file => fs.existsSync(file)).sort()
  }

  async #publish(compiler: ZnightCompiler, result: CompileResult): Promise<void> {
    const previous = this.#result
    this.#result = result
    this.#watched = new Set(result.watchFiles)
    this.#roots = includeRoots(compiler)
    if (result.ok) {
      await writeIfChanged(result.outFile, result.code)
      if (result.library !== undefined && this.#kind === 'dev') {
        await writeIfChanged(result.library.file, result.library.content)
      }
    }
    this.#report(compiler, result, previous)
    if (this.#server !== undefined) {
      this.#watchServerPaths(compiler, result)
      if (previous !== undefined && previous.code !== result.code) {
        await this.#reloadGenerated(result.outFile)
      }
    }
  }

  /** Prints diagnostics (deduplicated in the dev server) and the summary line. */
  #report(compiler: ZnightCompiler, result: CompileResult, previous: CompileResult | undefined): void {
    const logger = this.#config?.logger
    if (logger === undefined) {
      return
    }
    const kind = this.#kind
    const timestamp = kind !== 'build'
    if (result.diagnostics.length > 0 && !(kind === 'build' && !result.ok)) {
      const text = formatDiagnostics(result.diagnostics, { cwd: compiler.options.root })
      if (kind !== 'dev' || text !== this.#lastDiagnostics) {
        if (result.ok) {
          logger.warn(text, { timestamp })
        } else {
          logger.error(text, { timestamp })
        }
      }
      this.#lastDiagnostics = text
    } else {
      this.#lastDiagnostics = ''
    }
    if (result.ok && (kind !== 'dev' || previous?.code !== result.code)) {
      const providers = result.stats.providers
      logger.info(
        `${pc.cyan('[znight]')} ${providers} provider${providers === 1 ? '' : 's'} compiled in ${Math.round(result.stats.durationMs)} ms`,
        { timestamp },
      )
    }
  }
}

/**
 * The error failing `vite build`: its message is the formatted diagnostics; `code` is the code of
 * the first error and `diagnostics` the diagnostics. Its stack is the message only (Rolldown and
 * Vite print the stack, and the plugin's frames say nothing useful).
 */
function compileFailure(result: CompileResult, root: string): Error {
  const first = result.diagnostics.find(diagnostic => diagnostic.severity === 'error')
  const error = Object.assign(new Error(formatDiagnostics(result.diagnostics, { cwd: root })), {
    code: first?.code,
    diagnostics: result.diagnostics,
  })
  error.name = 'ZnightError'
  error.stack = `${error.name}: ${error.message}`
  return error
}

function sessionKind(dev: boolean, watchMode: boolean): SessionKind {
  if (dev) {
    return 'dev'
  }
  return watchMode ? 'watch' : 'build'
}

/**
 * Compile mode of a Vite command: the dev server compiles for `serve` (`test` under Vitest), a
 * build for `build` unless it is a development build (`vite build --mode development`, used by
 * `znight dev`), which keeps the provider source locations.
 */
function compileMode(config: ResolvedConfig): CompileMode {
  if (config.command === 'serve') {
    return process.env['VITEST'] !== undefined || config.mode === 'test' ? 'test' : 'serve'
  }
  return config.mode === 'development' ? 'serve' : 'build'
}

/** File name without its extension (`container.generated` for the default outFile). */
function stem(file: string): string {
  const base = path.posix.basename(file.replaceAll('\\', '/'))
  const extension = path.posix.extname(base)
  return extension === '' ? base : base.slice(0, base.length - extension.length)
}

function withoutQuery(id: string): string {
  const index = id.indexOf('?')
  return index === -1 ? id : id.slice(0, index)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}
