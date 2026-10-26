/**
 * Programmatic API (§6.2): `compile()` (pure), `generate()` (writes the generated module when it
 * changed) and `createCompiler()`, the incremental compiler shared by the Vite plugin, the Bun
 * preload and the CLI.
 *
 * Pipeline (§6.1): scan → parse (cached by content hash) → facts → resolution → class analysis
 * (core + extensions) → compiled provider libraries → binding → validation → emit → re-parse check.
 * Only parsing and per-file facts survive between compiles; everything else is recomputed.
 */
import type { CompileMode } from './codegen/container.ts'
import type { DecoratorRanges } from './decorator-ranges.ts'
import type { ExtensionLoadResult } from './extensions/loader.ts'
import type { ApplicationGraph } from './graph/types.ts'
import type { LibraryOutput } from './library/emit.ts'
import type { ResolvedOptions, StringAlias, ZnightOptions } from './options.ts'
import type { Diagnostic, ProjectChanges } from './project/index.ts'

import fs from 'node:fs'
import path from 'node:path'
import { ErrorCode } from '@znight/core'

import { analyzeProject } from './analyze.ts'
import { generateContainer } from './codegen/container.ts'
import { renderErrorModule } from './codegen/error-module.ts'
import { pruneGraph } from './codegen/prune.ts'
import { collectDecoratorRanges } from './decorator-ranges.ts'
import { discoverExtensionModules, loadExtensions } from './extensions/loader.ts'
import { emitLibrary } from './library/emit.ts'
import { compiledLibraries } from './library/merge.ts'
import { normalizeOptions } from './options.ts'
import { DiagnosticBag, Project, resolvePath } from './project/index.ts'
import { COMPILER_VERSION, checkVersionSkew } from './version.ts'

export type { CompileMode } from './codegen/container.ts'

/** Options of {@link compile} / {@link createCompiler}: the compiler options plus their environment. */
export interface CompileOptions extends ZnightOptions {
  /**
   * What the generated code is for: `'build'` omits provider `source` locations (with the default
   * `sourceLocations: 'dev'`), `'serve'` / `'test'` emit them. Default `'serve'`.
   */
  readonly mode?: CompileMode
  /** Base directory of a relative `root`. Default `process.cwd()`. */
  readonly cwd?: string
  /** Runtime conditions (Vite `resolve.conditions`). Default `['node', 'import', 'default']`. */
  readonly runtimeConditions?: readonly string[]
  /** String aliases (Vite `resolve.alias`). */
  readonly aliases?: readonly StringAlias[]
}

/** Statistics of a compile. */
export interface CompileStats {
  /** Scanned files (application + source libraries). */
  readonly files: number
  /** Providers in the generated module. */
  readonly providers: number
  readonly durationMs: number
  /** Files parsed by this compile (new or changed content). */
  readonly parsed: number
}

/** Result of a compile. */
export interface CompileResult {
  /**
   * The generated module. When there is an error it is the **error module** ({@link renderErrorModule}):
   * importing it throws a `ZnightError` with the formatted diagnostics.
   */
  readonly code: string
  /** Absolute path of the generated module. */
  readonly outFile: string
  /** Every diagnostic: syntax errors (ZNIGHT022) first, then the others sorted by location. */
  readonly diagnostics: readonly Diagnostic[]
  /** `false` when at least one diagnostic is an error. */
  readonly ok: boolean
  /** The application graph (pruned with `prune`). */
  readonly graph: ApplicationGraph
  readonly stats: CompileStats
  /** Library mode: the `znight.providers.json` fragment (`undefined` otherwise, or on errors). */
  readonly library: LibraryOutput | undefined
  /** Files the result depends on (scanned sources, package manifests, compiled libraries). */
  readonly watchFiles: readonly string[]
  /**
   * Znight decorators of each analysed file (absolute path → content hash + ranges), for
   * `stripDecorators`: remove exactly these ranges when the file content still has this hash.
   */
  readonly decorators: ReadonlyMap<string, DecoratorRanges>
}

/** Options of {@link generate}. */
export interface GenerateOptions {
  /**
   * Check mode: never write; `stale` tells whether the files on disk differ from what would be
   * generated (`znight generate --check`).
   */
  readonly check?: boolean
}

/** Result of {@link generate}. */
export interface GenerateResult extends CompileResult {
  /** Files written by this call (only when their content changed and there is no error). */
  readonly written: readonly string[]
  /** Check mode: the generated files on disk are missing or out of date. */
  readonly stale: boolean
}

/** An incremental compiler: a persistent project (parse cache) and loaded extensions. */
export interface ZnightCompiler {
  readonly options: ResolvedOptions
  readonly project: Project
  readonly mode: CompileMode
  /** Latest result. */
  readonly last: CompileResult | undefined
  /**
   * Compiles. Without `changes` (and on the first call) every file is re-read (unchanged contents
   * keep their parse); with `changes` only those files are re-read. Calls are serialized: calls
   * made while a compile runs are coalesced into the next one (their changes merged).
   */
  compile(changes?: ProjectChanges): Promise<CompileResult>
  /** {@link compile}, then writes the generated files when they changed (never when there are errors). */
  generate(changes?: ProjectChanges, options?: GenerateOptions): Promise<GenerateResult>
  /** `true` for the generated module (watchers must ignore it). */
  isOutFile(file: string): boolean
  /** Forgets the loaded compiler extensions (reloaded by the next compile). */
  reloadExtensions(): void
}

/** Compiles the application. Pure: reads sources, writes nothing. */
export function compile(options: CompileOptions = {}): Promise<CompileResult> {
  return createCompiler(options).compile()
}

/** Compiles and writes the generated module (and `znight.providers.json` in library mode). */
export function generate(options: CompileOptions & GenerateOptions = {}): Promise<GenerateResult> {
  return createCompiler(options).generate(undefined, options.check === undefined ? {} : { check: options.check })
}

/** Creates an incremental compiler. */
export function createCompiler(options: CompileOptions = {}): ZnightCompiler {
  return new IncrementalCompiler(options)
}

interface Job {
  changes: ProjectChanges | undefined
  full: boolean
  readonly promise: Promise<CompileResult>
  readonly resolve: (result: CompileResult) => void
  readonly reject: (error: unknown) => void
}

class IncrementalCompiler implements ZnightCompiler {
  readonly options: ResolvedOptions
  readonly project: Project
  readonly mode: CompileMode
  #last: CompileResult | undefined
  #extensions: { readonly key: string; readonly result: ExtensionLoadResult } | undefined
  #running = false
  #pending: Job | undefined

  constructor(options: CompileOptions) {
    this.options = normalizeOptions(options, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.runtimeConditions === undefined ? {} : { runtimeConditions: options.runtimeConditions }),
      ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
    })
    const mode = options.mode ?? 'serve'
    if (mode !== 'build' && mode !== 'serve' && mode !== 'test') {
      throw new TypeError(`[znight] option "mode" must be 'build', 'serve' or 'test' (got ${JSON.stringify(mode)})`)
    }
    this.mode = mode
    this.project = new Project(this.options)
  }

  get last(): CompileResult | undefined {
    return this.#last
  }

  compile(changes?: ProjectChanges): Promise<CompileResult> {
    let job = this.#pending
    if (!job) {
      let resolve!: (result: CompileResult) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<CompileResult>((onResolve, onReject) => {
        resolve = onResolve
        reject = onReject
      })
      job = { changes: undefined, full: false, promise, resolve, reject }
      this.#pending = job
    }
    if (changes === undefined) {
      job.full = true
      job.changes = undefined
    } else if (!job.full) {
      job.changes = mergeChanges(job.changes, this.#withoutOutFile(changes))
    }
    if (!this.#running) {
      void this.#drain()
    }
    return job.promise
  }

  async generate(changes?: ProjectChanges, options: GenerateOptions = {}): Promise<GenerateResult> {
    const result = await this.compile(changes)
    const outputs: { readonly file: string; readonly content: string }[] = []
    if (result.ok) {
      outputs.push({ file: result.outFile, content: result.code })
      if (result.library) {
        outputs.push({ file: result.library.file, content: result.library.content })
      }
    }
    if (options.check) {
      const stale = result.ok && outputs.some(output => readText(output.file) !== output.content)
      return { ...result, written: [], stale }
    }
    const written: string[] = []
    for (const output of outputs) {
      if (await writeIfChanged(output.file, output.content)) {
        written.push(output.file)
      }
    }
    return { ...result, written, stale: false }
  }

  isOutFile(file: string): boolean {
    return resolvePath(file, this.options.root) === this.options.outFile
  }

  /** Watchers report the generated module itself: it is never a source. */
  #withoutOutFile(changes: ProjectChanges): ProjectChanges {
    const keep = (paths: Iterable<string> | undefined): string[] =>
      [...(paths ?? [])].filter(path => !this.isOutFile(path))
    return { changed: keep(changes.changed), added: keep(changes.added), removed: keep(changes.removed) }
  }

  reloadExtensions(): void {
    this.#extensions = undefined
  }

  async #drain(): Promise<void> {
    this.#running = true
    try {
      while (this.#pending) {
        const job = this.#pending
        this.#pending = undefined
        try {
          const result = await this.#run(job.full || this.#last === undefined ? undefined : job.changes)
          this.#last = result
          job.resolve(result)
        } catch (error) {
          job.reject(error)
        }
      }
    } finally {
      this.#running = false
    }
  }

  async #run(changes: ProjectChanges | undefined): Promise<CompileResult> {
    const start = performance.now()
    const project = this.project
    const refresh = project.refresh(changes)
    const extensions = await this.#loadExtensions()
    const analysis = analyzeProject(project, extensions)

    const syntax = new DiagnosticBag()
    for (const { error, location } of project.syntaxErrors()) {
      syntax.add({
        code: ErrorCode.SyntaxError,
        severity: 'error',
        message: `Syntax error: ${error.message}`,
        location,
        hints: [...(error.help ? [error.help] : []), 'The file is ignored by the compiler until it parses again'],
      })
    }
    const bag = new DiagnosticBag()
    bag.addAll(checkVersionSkew(project))
    bag.addAll(this.options.library ? analysis.diagnostics.map(libraryDiagnostic) : analysis.diagnostics)

    const graph = this.options.prune ? pruneGraph(analysis.graph) : analysis.graph
    let hasErrors = syntax.size > 0 || bag.toArray().some(diagnostic => diagnostic.severity === 'error')
    let code = ''
    let library: LibraryOutput | undefined
    if (!hasErrors) {
      const container = generateContainer({
        project,
        graph,
        extensions: analysis.extensions,
        mode: this.mode,
        version: COMPILER_VERSION,
      })
      bag.addAll(container.diagnostics)
      code = container.code
      if (this.options.library) {
        const emitted = emitLibrary({ project, analysis, version: COMPILER_VERSION })
        bag.addAll(emitted.diagnostics)
        library = emitted.output
      }
      hasErrors = bag.toArray().some(diagnostic => diagnostic.severity === 'error')
    }
    const diagnostics = [...syntax.toArray(), ...bag.toArray()]
    if (hasErrors) {
      code = renderErrorModule(diagnostics, {
        cwd: this.options.root,
        readFile: file => project.getFile(file)?.text ?? readText(file),
      })
      library = undefined
    }
    return {
      code,
      outFile: this.options.outFile,
      diagnostics,
      ok: !hasErrors,
      graph,
      stats: {
        files: refresh.files,
        providers: graph.providers.length,
        durationMs: performance.now() - start,
        parsed: refresh.parsed,
      },
      library,
      watchFiles: this.#watchFiles(),
      decorators: collectDecoratorRanges(project, analysis.classes),
    }
  }

  async #loadExtensions(): Promise<ExtensionLoadResult> {
    const key = discoverExtensionModules(this.project)
      .map(module => `${module.packageName}\0${module.specifier}\0${module.package.dir}\0${module.trusted}`)
      .join('\n')
    if (this.#extensions?.key !== key) {
      this.#extensions = { key, result: await loadExtensions(this.project) }
    }
    return this.#extensions.result
  }

  #watchFiles(): string[] {
    const files = new Set(this.project.scannedFiles())
    const root = this.project.rootPackage
    if (root) {
      files.add(root.packageJsonPath)
    }
    for (const library of this.project.libraries()) {
      files.add(library.package.packageJsonPath)
    }
    for (const library of compiledLibraries(this.project)) {
      files.add(library.package.packageJsonPath)
      files.add(library.file)
    }
    return [...files].sort()
  }
}

/**
 * Library mode: a missing provider may be supplied by the applications using the library (they
 * validate the library's dependencies when they merge it), so ZNIGHT001 is a warning.
 */
function libraryDiagnostic(diagnostic: Diagnostic): Diagnostic {
  if (diagnostic.code !== ErrorCode.MissingProvider || diagnostic.severity !== 'error') {
    return diagnostic
  }
  return {
    ...diagnostic,
    severity: 'warning',
    hints: [
      ...(diagnostic.hints ?? []),
      'Library mode: the applications using this library must provide it (checked when they compile)',
    ],
  }
}

function mergeChanges(current: ProjectChanges | undefined, next: ProjectChanges): ProjectChanges {
  if (!current) {
    return { changed: [...(next.changed ?? [])], added: [...(next.added ?? [])], removed: [...(next.removed ?? [])] }
  }
  return {
    changed: [...(current.changed ?? []), ...(next.changed ?? [])],
    added: [...(current.added ?? []), ...(next.added ?? [])],
    removed: [...(current.removed ?? []), ...(next.removed ?? [])],
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

let temporaryCounter = 0

/** Writes `content` to `file` when it differs (atomic rename). Returns `true` when written. */
async function writeIfChanged(file: string, content: string): Promise<boolean> {
  if (readText(file) === content) {
    return false
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${++temporaryCounter}.tmp`
  await fs.promises.writeFile(temporary, content)
  try {
    await fs.promises.rename(temporary, file)
  } catch (error) {
    await fs.promises.rm(temporary, { force: true })
    throw error
  }
  return true
}
