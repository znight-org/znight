/**
 * Bun integration (§6.3), side-effect free (the `@znight/compiler/bun` preload runs it):
 *
 * - {@link createPreload}: generates the container before tests / the application start, prints
 *   the diagnostics, throws on errors and registers {@link znightBunPlugin};
 * - {@link znightBunPlugin}: a Bun plugin serving the generated module from memory (fresh under
 *   `bun --hot`) and blanking the Znight decorators of the analysed files;
 * - {@link loadZnightConfig}: the options of the preload (`znight.config.ts`).
 *
 * Bun only restarts `bun --watch` / `bun test --watch` for files it loaded. Files served by a
 * plugin are not watched, so the preload also loads every file the compile depends on **as text**
 * (`import(url, { with: { type: 'text' } })`: read, never executed), which makes Bun watch them —
 * including the provider files whose decorators are blanked and, after a failed compile, the files
 * the fix will touch.
 */
import type { CompileMode, CompileOptions, GenerateResult, ZnightCompiler } from './compiler.ts'
import type { Diagnostic } from './project/index.ts'

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ErrorCode, ZnightError } from '@znight/core'

import { createCompiler, generatedFiles, writeIfChanged } from './compiler.ts'
import { formatDiagnostics } from './diagnostics/format.ts'
import { resolvePath, toPosixPath } from './project/paths.ts'
import { applicableRanges, blankDecorators } from './strip.ts'

/** Loader of a module returned by a Bun `onLoad` callback. */
export type BunLoader = 'ts' | 'tsx' | 'js' | 'jsx'

/** Arguments of a Bun `onLoad` callback (the subset used by Znight). */
export interface BunOnLoadArgs {
  readonly path: string
}

/** Result of a Bun `onLoad` callback. */
export interface BunOnLoadResult {
  readonly contents: string
  readonly loader: BunLoader
}

/** The plugin builder given to `setup` by `Bun.plugin()` / `Bun.build()` (the subset used by Znight). */
export interface BunPluginBuild {
  onLoad(
    constraints: { readonly filter: RegExp },
    callback: (args: BunOnLoadArgs) => BunOnLoadResult | Promise<BunOnLoadResult>,
  ): unknown
}

/** A Bun plugin (`Bun.plugin(znightBunPlugin())`). */
export interface ZnightBunPlugin {
  readonly name: string
  /** The incremental compiler serving the generated module. */
  readonly compiler: ZnightCompiler
  setup(build: BunPluginBuild): Promise<void>
}

/** Options of {@link znightBunPlugin}. */
export interface ZnightBunPluginOptions extends CompileOptions {
  /** Compiler to serve (default: a new one created from the options). */
  readonly compiler?: ZnightCompiler
}

/** Options of {@link createPreload}: the compiler options plus the log level. */
export interface PreloadOptions extends CompileOptions {
  /**
   * `'info'`: diagnostics and a summary line; `'warn'` (default): diagnostics only; `'silent'`:
   * nothing (errors are then in the thrown error). Everything is printed on stderr.
   */
  readonly logLevel?: 'info' | 'warn' | 'silent'
}

/** Result of {@link loadZnightConfig}. */
export interface LoadedZnightConfig {
  /** The config file, `undefined` without one. */
  readonly file: string | undefined
  /** Its options, `root` resolved (default: the directory of the config file, else `cwd`). */
  readonly options: PreloadOptions
}

/** Config files looked up by {@link loadZnightConfig}, in order. */
export const ZNIGHT_CONFIG_FILES: readonly string[] = [
  'znight.config.ts',
  'znight.config.mts',
  'znight.config.js',
  'znight.config.mjs',
]

/** Runtime conditions of Bun (import routes and compiler extensions). */
const BUN_RUNTIME_CONDITIONS: readonly string[] = ['bun', 'node', 'import', 'default']

/** Query added to the text imports registering watched files (their module records stay distinct). */
const WATCH_QUERY = '?znight-watch'

/**
 * A Bun plugin serving the generated module from memory and blanking the Znight decorators of the
 * analysed files (replaced by spaces: every position is unchanged, no source map needed).
 *
 * `setup` compiles when the compiler has no result yet. The first load of the generated module
 * serves that result; later loads (`bun --hot` reloads) recompile incrementally.
 */
export function znightBunPlugin(options: ZnightBunPluginOptions = {}): ZnightBunPlugin {
  const { compiler: given, ...compileOptions } = options
  const compiler = given ?? createBunCompiler(compileOptions)
  return {
    name: 'znight',
    compiler,
    async setup(build) {
      const initial = compiler.last ?? (await compiler.compile())
      let reuse = true
      build.onLoad({ filter: exactPaths([compiler.options.outFile]) }, async () => {
        const result = reuse && compiler.last !== undefined ? compiler.last : await compiler.compile()
        reuse = false
        return { contents: result.code, loader: 'ts' }
      })
      const files = [...initial.decorators.keys()]
      if (!compiler.options.stripDecorators || files.length === 0) {
        return
      }
      build.onLoad({ filter: exactPaths(files) }, async args => {
        const file = toPosixPath(args.path)
        const code = await fs.promises.readFile(args.path, 'utf8')
        const entry = applicableRanges(code, compiler.last?.decorators.get(file))
        return { contents: entry === undefined ? code : blankDecorators(code, entry), loader: loaderOf(file) }
      })
    },
  }
}

/**
 * What the `@znight/compiler/bun` preload runs: generates the container (the disk copy — the
 * `serve` rendering in every mode — is written when it changed, for `tsc` and editors), makes Bun
 * watch every file the result depends on, prints the diagnostics and, without errors, registers
 * {@link znightBunPlugin}.
 *
 * The module is served from memory: a disk copy that cannot be written (read-only file system of a
 * production image) is a warning, never a failure.
 *
 * Default mode: `test` under `bun test` (`NODE_ENV=test`), `build` with `NODE_ENV=production`,
 * else `serve`.
 *
 * @throws ZnightError when the compilation fails (the code of the first error), so `bun test`
 *   exits with code 1 and `bun --watch` waits for a fix.
 */
export async function createPreload(options: PreloadOptions = {}): Promise<GenerateResult> {
  const bun = bunRuntime()
  const { logLevel = 'warn', ...compileOptions } = options
  const compiler = createBunCompiler(compileOptions)
  const compiled = await compiler.compile()
  const written: string[] = []
  for (const output of generatedFiles(compiled)) {
    try {
      if (await writeIfChanged(output.file, output.content)) {
        written.push(output.file)
      }
    } catch (error) {
      if (logLevel !== 'silent') {
        console.error(
          `[znight] cannot write ${path.relative(compiler.options.root, output.file)}: ${error instanceof Error ? error.message : String(error)} (the generated module is served from memory; tsc and editors read the disk copy)`,
        )
      }
    }
  }
  const result: GenerateResult = { ...compiled, written, stale: false }
  await watchAsText([...result.watchFiles, ...tsconfigFiles(compiler)])
  const root = compiler.options.root
  const printed = logLevel !== 'silent' && result.diagnostics.length > 0
  if (printed) {
    console.error(formatDiagnostics(result.diagnostics, { cwd: root }))
  }
  if (!result.ok) {
    throw compileError(result.diagnostics, printed ? undefined : formatDiagnostics(result.diagnostics, { cwd: root }))
  }
  if (logLevel === 'info') {
    const providers = result.stats.providers
    console.error(
      `[znight] ${providers} provider${providers === 1 ? '' : 's'} compiled in ${Math.round(result.stats.durationMs)} ms`,
    )
  }
  await bun.plugin(znightBunPlugin({ compiler }))
  return result
}

/**
 * Options of the preload: the default export of `znight.config.{ts,mts,js,mjs}` in `cwd` (or of
 * the file named by the `ZNIGHT_CONFIG` environment variable): an options object, or a function
 * returning one. A relative `root` is resolved against the config file directory (its default).
 * Without a config file: `{ root: cwd }`.
 *
 * Share the file with the Vite plugin: `import options from './znight.config.ts'` in
 * `vite.config.ts`, then `znight(options)`.
 */
export async function loadZnightConfig(cwd: string = process.cwd()): Promise<LoadedZnightConfig> {
  const explicit = process.env['ZNIGHT_CONFIG']
  let file: string | undefined
  if (explicit !== undefined && explicit !== '') {
    file = path.resolve(cwd, explicit)
    if (!fs.existsSync(file)) {
      throw new Error(`[znight] ZNIGHT_CONFIG points to a missing file: ${file}`)
    }
  } else {
    file = ZNIGHT_CONFIG_FILES.map(name => path.join(cwd, name)).find(candidate => fs.existsSync(candidate))
  }
  if (file === undefined) {
    return { file: undefined, options: { root: resolvePath(cwd) } }
  }
  const loaded = (await import(pathToFileURL(file).href)) as { readonly default?: unknown }
  let value = loaded.default
  if (typeof value === 'function') {
    value = await (value as () => unknown)()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`[znight] ${file} must default-export the compiler options (an object)`)
  }
  const options = value as PreloadOptions
  return {
    file: resolvePath(file),
    options: { ...options, root: resolvePath(options.root ?? '.', path.dirname(file)) },
  }
}

// ---------------------------------------------------------------------------- internals

interface BunRuntime {
  plugin(plugin: ZnightBunPlugin): unknown
}

function bunRuntime(): BunRuntime {
  const bun = (globalThis as unknown as { readonly Bun?: BunRuntime }).Bun
  if (bun === undefined || typeof bun.plugin !== 'function') {
    throw new Error('[znight] the Znight preload runs under Bun only (bunfig.toml `preload`, `bun --preload`)')
  }
  return bun
}

function createBunCompiler(options: CompileOptions): ZnightCompiler {
  return createCompiler({ mode: bunCompileMode(), runtimeConditions: BUN_RUNTIME_CONDITIONS, ...options })
}

function bunCompileMode(): CompileMode {
  const env = process.env['NODE_ENV']
  if (env === 'test') {
    return 'test'
  }
  return env === 'production' ? 'build' : 'serve'
}

/** Makes Bun watch `files` by loading them as text modules (read, never executed). */
async function watchAsText(files: readonly string[]): Promise<void> {
  await Promise.allSettled(
    [...new Set(files)].map(file => import(`${pathToFileURL(file).href}${WATCH_QUERY}`, { with: { type: 'text' } })),
  )
}

/** The root tsconfig and the `tsconfig` option, when they exist (module resolution inputs). */
function tsconfigFiles(compiler: ZnightCompiler): string[] {
  const tsconfig = compiler.options.tsconfig
  return [`${compiler.options.root}/tsconfig.json`, ...(typeof tsconfig === 'string' ? [tsconfig] : [])].filter(file =>
    fs.existsSync(file),
  )
}

function compileError(diagnostics: readonly Diagnostic[], formatted: string | undefined): ZnightError {
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  const first = errors[0] ?? diagnostics[0]
  const summary = `The Znight compilation failed with ${errors.length} error${errors.length === 1 ? '' : 's'}`
  // no stack: Bun would print a code frame of the compiler, which says nothing useful
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 0
  try {
    return new ZnightError(
      first?.code ?? ErrorCode.VersionMismatch,
      formatted === undefined ? `${summary} (see the diagnostics above)` : `${summary}\n\n${formatted}`,
    )
  } finally {
    Error.stackTraceLimit = limit
  }
}

/** A filter matching exactly these absolute paths (either separator). */
function exactPaths(files: readonly string[]): RegExp {
  const alternatives = files.map(file =>
    toPosixPath(file)
      .split('/')
      .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\\\/]'),
  )
  return new RegExp(`^(?:${alternatives.join('|')})$`)
}

function loaderOf(file: string): BunLoader {
  const extension = path.posix.extname(file)
  if (extension === '.tsx') {
    return 'tsx'
  }
  if (extension === '.jsx') {
    return 'jsx'
  }
  return extension === '.js' || extension === '.mjs' || extension === '.cjs' ? 'js' : 'ts'
}
