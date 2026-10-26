/**
 * The `@znight/compiler` programmatic API (spec §6.2), loaded lazily: commands that do not compile
 * (`new`, `g`, `start`) never load it. Commands use {@link CompilerApi} so tests can inject a fake.
 *
 * The CLI only relies on the documented shapes below (structural types, no type import from the
 * compiler), so any `@znight/compiler` of the same major version works.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

import { CliError } from '../errors.ts'
import { createColors } from '../output.ts'
import { importFromProject } from './resolve.ts'

/** Location of a diagnostic (`Diagnostic.location`, §6.2). */
export interface DiagnosticLocation {
  readonly file: string
  readonly line: number
  readonly column: number
}

/** A compiler diagnostic (§6.2). */
export interface Diagnostic {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly location?: DiagnosticLocation | undefined
  readonly hints?: readonly string[] | undefined
  readonly related?: readonly { readonly message: string; readonly location: DiagnosticLocation }[] | undefined
}

/** A string alias of Vite's `resolve.alias` (`CompileOptions.aliases` of the compiler). */
export interface StringAliasLike {
  readonly find: string
  readonly replacement: string
}

/**
 * Compiler options (`ZnightOptions`, §6.2, plus the `CompileOptions` the Vite plugin derives from the
 * Vite config). The CLI reads `root`, `include` and `outFile`; the others are passed through.
 */
export interface ZnightOptions {
  readonly root?: string | undefined
  readonly include?: readonly string[] | undefined
  readonly outFile?: string | undefined
  /** String aliases of the Vite config (`resolve.alias`). */
  readonly aliases?: readonly StringAliasLike[] | undefined
  readonly [option: string]: unknown
}

/** What the CLI reads from a compile result (`CompileResult`, §6.2). */
export interface CompileResultLike {
  /** Content of the generated module (with errors: a module throwing them, or empty). */
  readonly code: string
  /** Absolute path of the generated module. */
  readonly outFile: string
  readonly diagnostics: readonly Diagnostic[]
  readonly stats?: { readonly files?: number; readonly providers?: number; readonly durationMs?: number } | undefined
  /** Files the result depends on (`createCompiler()` results). */
  readonly watchFiles?: readonly string[] | undefined
}

/** Result of {@link CompilerApi.generate}. */
export interface GenerateResultLike extends CompileResultLike {
  /** Whether the generated module was written (its content changed). */
  readonly written: boolean
}

/** Result of {@link CompilerApi.check}. */
export interface CheckResultLike extends CompileResultLike {
  /** The generated files on disk are missing or differ from what would be generated. */
  readonly stale: boolean
  /**
   * The generated files that are missing or out of date (the module, and `znight.providers.json` in
   * library mode). Empty when `stale` is `false`; empty or absent with `stale` when the compiler
   * does not say which file is stale.
   */
  readonly staleFiles?: readonly string[] | undefined
}

/** Files changed since the previous compile of an {@link IncrementalCompiler}. */
export interface CompilerChanges {
  readonly changed?: readonly string[]
  readonly added?: readonly string[]
  readonly removed?: readonly string[]
}

/** Kind of a file system event (`ChangeKind` of the compiler). */
export type ChangeKind = 'changed' | 'added' | 'removed'

/** A compiler keeping its parse cache between compiles (`createCompiler()`), for watch mode. */
export interface IncrementalCompiler {
  /** Compiles (only `changes` are re-read, everything without) and writes the module when it changed. */
  generate(changes?: CompilerChanges): Promise<GenerateResultLike>
  /** Whether `file` is the generated module (watchers ignore it). */
  isOutFile(file: string): boolean
  /**
   * Directories where a created or deleted source changes the scan (`includeRoots()` of the
   * compiler: the bases of the `include` globs in the project and in every source library, known once
   * compiled), to watch recursively. The project root when the compiler does not tell.
   */
  includeRoots(): readonly string[]
  /**
   * Whether a file event can change the next compile (`isRelevantChange()` of the compiler): `watched`
   * are the `watchFiles` of the last compile, `roots` its {@link includeRoots}. When the compiler does
   * not tell, every event but the generated module is.
   */
  isRelevantChange(kind: ChangeKind, file: string, watched: ReadonlySet<string>, roots: readonly string[]): boolean
}

/** Options of {@link CompilerApi.formatDiagnostics}. */
export interface FormatDiagnosticsOptions {
  readonly color?: boolean
  readonly cwd?: string
  /** Append the summary line (`Build failed with 2 errors`). */
  readonly summary?: boolean
}

/** Options read from `znight.config.*` (`loadZnightConfig()`, §6.3). */
export interface ZnightConfigLike {
  /** The config file, `undefined` when the project has none. */
  readonly file: string | undefined
  /** Its options, `root` resolved against the config file directory. */
  readonly options: ZnightOptions
}

/** The part of `@znight/compiler` used by the CLI. */
export interface CompilerApi {
  /** Compiles and writes the generated module when its content changed (`generate()`). */
  generate(options: ZnightOptions): Promise<GenerateResultLike>
  /** Compiles without writing and compares with the files on disk (`generate({ check: true })`). */
  check(options: ZnightOptions): Promise<CheckResultLike>
  /** An incremental compiler (`createCompiler()`). */
  createIncremental(options: ZnightOptions): IncrementalCompiler
  /** Code frames for diagnostics (`formatDiagnostics()`). */
  formatDiagnostics(diagnostics: readonly Diagnostic[], options?: FormatDiagnosticsOptions): string
  /**
   * The options of `znight.config.*` (or of the file named by `ZNIGHT_CONFIG`) in `root`
   * (`loadZnightConfig()`). Absent for compilers without it.
   */
  loadConfig?(root: string): Promise<ZnightConfigLike>
}

/**
 * Not a literal in `import()`: the CLI type-checks and bundles without the compiler (an optional
 * peer dependency), whose version is the project's.
 */
const COMPILER_PACKAGE: string = '@znight/compiler'

/** A compile result as returned by any `@znight/compiler` version (extra fields are optional). */
interface ModuleResult extends CompileResultLike {
  /** The disk copy of the module (`code` before it existed; they differ in `build` mode only). */
  readonly diskCode?: string
  readonly written?: readonly string[]
  readonly stale?: boolean
  /** The stale generated files (check mode), when the compiler tells. */
  readonly staleFiles?: readonly string[]
  /** Library mode: `znight.providers.json` (`library` of a `CompileResult`). */
  readonly library?: { readonly file?: unknown; readonly content?: unknown } | undefined
}

/** The parts of a `ZnightCompiler` (`createCompiler()`) the CLI uses; all optional. */
export interface ModuleIncrementalCompiler {
  generate?: (changes?: CompilerChanges, options?: { check?: boolean }) => Promise<ModuleResult>
  isOutFile?: (file: string) => boolean
}

/** The shape of the `@znight/compiler` module (every export optional: partial versions are adapted). */
export interface CompilerModule {
  compile?: (options?: ZnightOptions) => Promise<ModuleResult>
  generate?: (options?: ZnightOptions & { check?: boolean }) => Promise<ModuleResult>
  createCompiler?: (options?: ZnightOptions) => ModuleIncrementalCompiler
  formatDiagnostics?: (diagnostics: readonly Diagnostic[], options?: FormatDiagnosticsOptions) => string
  loadZnightConfig?: (cwd?: string) => Promise<ZnightConfigLike>
  /** The watch roots of a compiler (`includeRoots(compiler)`). */
  includeRoots?: (compiler: ModuleIncrementalCompiler) => readonly string[]
  /** Whether a file event can change the next compile of a compiler (`isRelevantChange(compiler, ...)`). */
  isRelevantChange?: (
    compiler: ModuleIncrementalCompiler,
    kind: ChangeKind,
    file: string,
    watched: ReadonlySet<string>,
    roots: readonly string[],
  ) => boolean
}

/**
 * Loads `@znight/compiler` as installed in the project (falls back to the CLI's own peer) and adapts
 * it to {@link CompilerApi}.
 */
export async function loadCompiler(root: string): Promise<CompilerApi> {
  let module: CompilerModule
  try {
    module = (await importFromProject(COMPILER_PACKAGE, root, () => import(COMPILER_PACKAGE))) as CompilerModule
  } catch (error) {
    throw new CliError('Cannot load @znight/compiler', {
      cause: error,
      hints: ['install it in your project: npm install -D @znight/compiler vite'],
    })
  }
  return adaptCompilerModule(module)
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Adapts a loaded compiler module: `generate()` / `generate({ check })` / `createCompiler()` when
 * available, otherwise the same behaviour built on `compile()`.
 */
export function adaptCompilerModule(module: CompilerModule): CompilerApi {
  const { compile, generate, createCompiler, loadZnightConfig } = module
  if (typeof compile !== 'function' && typeof generate !== 'function') {
    throw new CliError('This version of @znight/compiler exposes neither compile() nor generate()', {
      hints: ['upgrade @znight/compiler to the version of @znight/cli'],
    })
  }
  const format = module.formatDiagnostics ?? fallbackFormatDiagnostics

  /** Pure compile: `compile()`, else `generate({ check: true })` (never writes). */
  const compileOnly = (options: ZnightOptions): Promise<ModuleResult> =>
    typeof compile === 'function'
      ? compile(options)
      : (generate as NonNullable<CompilerModule['generate']>)({ ...options, check: true })

  /** Write-if-changed on top of a compile result, when the compiler did not write itself. */
  const written = (result: ModuleResult, before: string | undefined): GenerateResultLike => ({
    ...result,
    written: Array.isArray(result.written) ? result.written.length > 0 : before !== readText(result.outFile),
  })

  const generateOnce = async (options: ZnightOptions): Promise<GenerateResultLike> => {
    if (typeof generate === 'function') {
      const before = readText(resolveOutFile(options))
      return written(await generate(options), before)
    }
    const result = await compileOnly(options)
    const changed = !hasErrors(result.diagnostics) && writeIfChanged(result.outFile, result.diskCode ?? result.code)
    return { ...result, written: changed }
  }

  return {
    generate: generateOnce,
    check: async options => {
      const result =
        typeof generate === 'function' ? await generate({ ...options, check: true }) : await compileOnly(options)
      const staleFiles = Array.isArray(result.staleFiles) ? result.staleFiles : staleOutputs(result)
      const stale = typeof result.stale === 'boolean' ? result.stale : staleFiles.length > 0
      return { ...result, stale, staleFiles: stale ? staleFiles : [] }
    },
    createIncremental: options => {
      const compiler = typeof createCompiler === 'function' ? createCompiler(options) : undefined
      const incremental = compiler?.generate
      const outFile = resolveOutFile(options)
      const isOutFile = (file: string): boolean =>
        typeof compiler?.isOutFile === 'function' ? compiler.isOutFile(file) : resolve(file) === outFile
      const { includeRoots, isRelevantChange } = module
      return {
        generate: async changes => {
          if (compiler === undefined || typeof incremental !== 'function') return generateOnce(options)
          const before = readText(outFile)
          return written(await incremental.call(compiler, changes), before)
        },
        isOutFile,
        includeRoots: () =>
          compiler !== undefined && typeof includeRoots === 'function'
            ? includeRoots(compiler)
            : [resolve(options.root ?? '.')],
        isRelevantChange: (kind, file, watched, roots) =>
          compiler !== undefined && typeof isRelevantChange === 'function'
            ? isRelevantChange(compiler, kind, file, watched, roots)
            : !isOutFile(file),
      }
    },
    formatDiagnostics: (diagnostics, options) => format(diagnostics, options),
    ...(typeof loadZnightConfig === 'function'
      ? { loadConfig: (root: string): Promise<ZnightConfigLike> => loadZnightConfig(root) }
      : {}),
  }
}

/**
 * The generated files of a compile result that differ from the disk: the module, and
 * `znight.providers.json` in library mode. None with errors (nothing would be written).
 */
function staleOutputs(result: ModuleResult): string[] {
  if (hasErrors(result.diagnostics)) return []
  const outputs: { file: string; content: string }[] = [
    { file: result.outFile, content: result.diskCode ?? result.code },
  ]
  const { file, content } = result.library ?? {}
  if (typeof file === 'string' && typeof content === 'string') outputs.push({ file, content })
  return outputs.filter(output => readText(output.file) !== output.content).map(output => output.file)
}

/** Default `outFile` of the compiler (§6.2). */
export const DEFAULT_OUT_FILE = 'src/.znight/container.generated.ts'

/** Absolute path of the generated module for `options`. */
export function resolveOutFile(options: ZnightOptions): string {
  return resolve(options.root ?? '.', options.outFile ?? DEFAULT_OUT_FILE)
}

/** Whether a list of diagnostics contains an error. */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === 'error')
}

/** Writes `content` to `file` unless it already has that exact content. Returns whether it wrote. */
export function writeIfChanged(file: string, content: string): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return false
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return true
}

/**
 * Plain formatter used when the installed compiler has no `formatDiagnostics()`:
 *
 * ```
 * ✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService
 *   --> src/notification/notification.service.ts:12:5
 *   = hint: Add @Injectable() to EmailService
 * ```
 */
export function fallbackFormatDiagnostics(
  diagnostics: readonly Diagnostic[],
  options: FormatDiagnosticsOptions = {},
): string {
  const colors = createColors(options.color === true)
  const blocks: string[] = []
  for (const diagnostic of diagnostics) {
    const isError = diagnostic.severity === 'error'
    const head = isError
      ? colors.red(`✗ ${diagnostic.code}: ${diagnostic.message}`)
      : colors.yellow(`! ${diagnostic.code}: ${diagnostic.message}`)
    const lines = [colors.bold(head)]
    if (diagnostic.location !== undefined) {
      lines.push(`  ${colors.cyan('-->')} ${formatLocation(diagnostic.location, options.cwd)}`)
    }
    for (const hint of diagnostic.hints ?? []) lines.push(`  ${colors.dim('=')} ${colors.bold('hint:')} ${hint}`)
    for (const related of diagnostic.related ?? []) {
      lines.push(
        `  ${colors.dim('=')} ${colors.bold('note:')} ${related.message} (${formatLocation(related.location, options.cwd)})`,
      )
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

function formatLocation(location: { file: string; line: number; column: number }, cwd: string | undefined): string {
  const file = cwd === undefined ? location.file : relative(cwd, location.file).replaceAll('\\', '/')
  return `${file}:${location.line}:${location.column}`
}
