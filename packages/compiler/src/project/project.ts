/**
 * The project model: the entry point of the compiler foundation layer.
 *
 * A `Project` owns the caches that survive between compiles (parsed files keyed by content hash,
 * module resolution, package.json lookups) and the per-compile services rebuilt by every
 * {@link Project.refresh} (symbol resolution, identities, types, evaluation, import routes), as
 * required by §6.1: only parsing and per-file facts are cached across compiles.
 */
import type { Expression, TSType, TSTypeAnnotation } from 'oxc-parser'
import type { ResolvedOptions } from '../options.ts'
import type { Diagnostic } from './diagnostics.ts'
import type { EvaluateOptions, EvaluationResult } from './evaluator.ts'
import type { Declaration } from './facts.ts'
import type { ProjectHost } from './host.ts'
import type { IdentityInfo } from './identity.ts'
import type { SourceLibrary } from './libraries.ts'
import type { Location, Span } from './location.ts'
import type { ManifestResult, PackageManifest } from './manifest.ts'
import type { FileOwner, PackageInfo } from './packages.ts'
import type { ParseError } from './parse.ts'
import type { ModuleResolution, ResolutionMode } from './resolver.ts'
import type { ImportRouteResult } from './routes.ts'
import type { SourceFile } from './source-file.ts'
import type { EntityName, Meaning, ScopeRef, SymbolResolution } from './symbols.ts'
import type { HeritageClause, ResolveTypeOptions, TypeParameterInfo, TypeScope } from './type-resolver.ts'
import type { TypeInfo } from './types.ts'

import { ErrorCode } from '@znight/core'

import { DiagnosticBag } from './diagnostics.ts'
import { Evaluator } from './evaluator.ts'
import { FileCache } from './file-cache.ts'
import { IdentityResolver } from './identity.ts'
import { discoverLibraries } from './libraries.ts'
import { readManifest } from './manifest.ts'
import { PackageRegistry } from './packages.ts'
import { dirName, isRelativeSpecifier, isResolutionConfigPath, realPath, relativePath, resolvePath } from './paths.ts'
import { ModuleResolver } from './resolver.ts'
import { RouteResolver } from './routes.ts'
import { scanDirectory } from './scanner.ts'
import { SymbolResolver } from './symbols.ts'
import { TypeResolver } from './type-resolver.ts'

/** Paths changed since the previous {@link Project.refresh} (absolute or relative to the root). */
export interface ProjectChanges {
  /** Modified files: re-read (re-parsed only if their content hash changed). */
  readonly changed?: Iterable<string>
  /** Created files: the scan globs are re-evaluated and the resolution caches cleared. */
  readonly added?: Iterable<string>
  /** Deleted files: the scan globs are re-evaluated and the resolution caches cleared. */
  readonly removed?: Iterable<string>
}

/** Statistics of a {@link Project.refresh}. */
export interface RefreshResult {
  /** Number of scanned files (application + source libraries). */
  readonly files: number
  /** Files parsed during this refresh (new or changed content). */
  readonly parsed: number
  /** Files re-read whose parse was reused (unchanged content hash). */
  readonly reused: number
  /** The include/exclude globs were re-evaluated. */
  readonly rescanned: boolean
  /** The module resolution and package.json caches were cleared. */
  readonly resolutionCacheCleared: boolean
  readonly durationMs: number
}

/** A file given by path (absolute, or relative to the root), as a parsed file, or as a scope. */
export type ScopeInput = string | SourceFile | ScopeRef

/** Result of {@link Project.resolveIdentifier}. */
export interface ResolvedIdentifier {
  readonly symbol: SymbolResolution
  /** Canonical identity, when the symbol has one. */
  readonly identity: IdentityInfo | undefined
}

/** Per-compile services, rebuilt by every refresh. */
interface Services {
  readonly symbols: SymbolResolver
  readonly identities: IdentityResolver
  readonly types: TypeResolver
  readonly evaluator: Evaluator
  readonly routes: RouteResolver
}

/**
 * Project model of an application: scanned files, parse cache, module resolution, packages and
 * manifests, plus the resolution services of the current compile.
 *
 * ```ts
 * const project = new Project(normalizeOptions({ root, conditions: ['@znight/source'] }))
 * project.refresh()
 * for (const file of project.files()) {
 *   for (const [name, [declaration]] of file.facts.declarations) { ... }
 * }
 * const { identity } = project.resolveIdentifier(file, 'UserService')
 * ```
 */
export class Project implements ProjectHost {
  readonly options: ResolvedOptions
  /** Real path of the project root. */
  readonly root: string
  readonly resolver: ModuleResolver
  readonly packages: PackageRegistry
  readonly #files = new FileCache()
  readonly #scanDiagnostics = new DiagnosticBag()
  readonly #diagnostics = new DiagnosticBag()
  readonly #manifests = new Map<string, ManifestResult>()
  /** Files read through {@link getFile} since the last refresh (the inputs of the current compile). */
  readonly #loaded = new Set<string>()
  /** Relative imports that did not resolve since the last refresh: target paths without extension. */
  #missing = new Set<string>()
  /** {@link #missing} of the previous refresh (watchers may ask while a compile runs). */
  #previousMissing: ReadonlySet<string> = new Set()
  #scanned: readonly string[] = []
  #scannedSet: ReadonlySet<string> = new Set()
  #libraries: readonly SourceLibrary[] = []
  #initialized = false
  #services: Services

  constructor(options: ResolvedOptions) {
    this.options = options
    this.root = options.root
    this.resolver = new ModuleResolver({
      tsconfig: options.tsconfig,
      scanConditions: options.scanConditions,
      runtimeConditions: options.runtimeConditions,
      aliases: options.aliases,
    })
    this.packages = new PackageRegistry(options.root)
    this.#services = this.#createServices()
  }

  /**
   * Brings the project up to date. Without `changes` (or on the first call) everything is
   * re-scanned and every cached file re-read (unchanged contents keep their parse). With `changes`
   * only the given files are re-read; created/deleted files and config files (package.json,
   * tsconfig, lockfiles) re-run the scan and clear the resolution caches.
   *
   * Per-compile services (symbols, identities, types, evaluation, routes) are always rebuilt.
   */
  refresh(changes?: ProjectChanges): RefreshResult {
    const start = performance.now()
    this.#files.resetStats()
    let rescan = false
    let clearResolution = false
    if (!this.#initialized || changes === undefined) {
      rescan = true
      clearResolution = this.#initialized
      this.#files.invalidateAll()
    } else {
      for (const path of changes.changed ?? []) {
        const resolved = this.#normalizePath(path)
        if (isResolutionConfigPath(resolved)) {
          rescan = true
          clearResolution = true
        }
        this.#files.invalidate(resolved)
      }
      for (const path of changes.added ?? []) {
        rescan = true
        clearResolution = true
        this.#files.invalidate(this.#normalizePath(path))
      }
      for (const path of changes.removed ?? []) {
        rescan = true
        clearResolution = true
        const resolved = resolvePath(path, this.root)
        this.#files.delete(resolved)
        this.#files.delete(this.#normalizePath(path))
      }
    }
    if (clearResolution) {
      this.resolver.clearCache()
      this.packages.clear()
      this.#manifests.clear()
    }
    if (rescan) {
      this.#scan()
    }
    this.#initialized = true
    for (const path of this.#scanned) {
      this.#files.get(path)
    }
    this.#diagnostics.clear()
    this.#loaded.clear()
    this.#previousMissing = this.#missing
    this.#missing = new Set()
    this.#services = this.#createServices()
    return {
      files: this.#scanned.length,
      parsed: this.#files.stats.parsed,
      reused: this.#files.stats.reused,
      rescanned: rescan,
      resolutionCacheCleared: clearResolution,
      durationMs: performance.now() - start,
    }
  }

  // ---------------------------------------------------------------- files

  /** Scanned files (application + source libraries), sorted by path. */
  files(): SourceFile[] {
    const files: SourceFile[] = []
    for (const path of this.#scanned) {
      const file = this.#files.get(path)
      if (file) {
        files.push(file)
      }
    }
    return files
  }

  /** Paths of the scanned files, sorted. */
  scannedFiles(): readonly string[] {
    return this.#scanned
  }

  /** `true` when the file is part of the scan (application or source library). */
  isScanned(path: string): boolean {
    return this.#scannedSet.has(path) || this.#scannedSet.has(this.#normalizePath(path))
  }

  /**
   * Syntax errors of the scanned files. A file with a syntax error has an empty program: the
   * compile pipeline should report these first (its declarations are missing from the analysis).
   */
  syntaxErrors(): { readonly file: SourceFile; readonly error: ParseError; readonly location: Location }[] {
    return this.files().flatMap(file =>
      file.parseErrors.map(error => ({ file, error, location: file.location({ start: error.start, end: error.end }) })),
    )
  }

  /** Provider libraries scanned from source. */
  libraries(): readonly SourceLibrary[] {
    return this.#libraries
  }

  /**
   * Parsed file at `path` (absolute or relative to the root), loading files outside the scan on
   * demand (package declarations...). `undefined` when missing or not parseable.
   */
  getFile(path: string): SourceFile | undefined {
    const key = this.#files.has(path) ? path : this.#normalizePath(path)
    const file = this.#files.get(key)
    if (file) {
      this.#loaded.add(key)
    }
    return file
  }

  /**
   * `true` when creating `path` can fix a relative import that did not resolve in the current or the
   * previous compile (`../shared/names.js` → `shared/names.ts`, `./util` → `util/index.ts`):
   * watchers must recompile, even outside the `include` globs.
   */
  isMissingImport(path: string): boolean {
    const target = withoutExtension(resolvePath(path, this.root))
    const candidates = target.endsWith('/index') ? [target, target.slice(0, -'/index'.length)] : [target]
    return candidates.some(candidate => this.#missing.has(candidate) || this.#previousMissing.has(candidate))
  }

  /**
   * Files read since the last {@link refresh}, scanned or not (constants imported from outside the
   * `include` globs, `.d.ts` and `.js` modules, package declarations...): with the scanned files,
   * the inputs of the current compile. Sorted.
   */
  loadedFiles(): string[] {
    return [...this.#loaded].sort()
  }

  // ----------------------------------------------------------- resolution

  /**
   * Resolves a module specifier imported by `fromFile`. With `span` (the specifier literal), casing
   * mismatches in scanned files are reported as ZNIGHT010 warnings.
   */
  resolveModule(fromFile: string, specifier: string, span?: Span, mode: ResolutionMode = 'scan'): ModuleResolution {
    const resolution = this.resolver.resolve(fromFile, specifier, mode)
    if (resolution.kind === 'not-found' && isRelativeSpecifier(specifier)) {
      this.#missing.add(withoutExtension(resolvePath(specifier, dirName(fromFile))))
    }
    if (span && resolution.kind === 'file' && resolution.casingMismatch && this.#scannedSet.has(fromFile)) {
      const file = this.#files.get(fromFile)
      if (file) {
        const actual = relativePath(this.root, resolution.path)
        this.#diagnostics.add({
          code: ErrorCode.UnresolvableType,
          severity: 'warning',
          message: `Import '${specifier}' does not match the casing of the file on disk (${actual})`,
          location: file.location(span),
          hints: [`Use the exact casing of '${actual}': the import fails on case-sensitive file systems (Linux)`],
        })
      }
    }
    return resolution
  }

  /** Resolves `specifier` from a directory without tsconfig lookup (package self-references). */
  resolveFromDirectory(directory: string, specifier: string, mode: ResolutionMode = 'scan'): ModuleResolution {
    return this.resolver.resolveFromDirectory(directory, specifier, mode)
  }

  /**
   * Resolves a name used in a file (`'UserService'`, `'pg.Pool'`, an identifier, a member
   * expression or a qualified type name) to its declaration and canonical identity.
   */
  resolveIdentifier(scope: ScopeInput, name: EntityName, meaning: Meaning = 'any'): ResolvedIdentifier {
    const symbol = this.#services.symbols.resolveEntity(this.#scope(scope), name, meaning)
    return { symbol, identity: this.#services.identities.identityOf(symbol) }
  }

  /** Resolves an export of a module (following re-exports). */
  resolveExport(file: string | SourceFile, exportName: string, meaning: Meaning = 'any'): SymbolResolution {
    return this.#services.symbols.resolveExport(this.#scope(file).file.path, exportName, meaning)
  }

  /** Every export name of a module (including names re-exported by `export *`), sorted. */
  exportNames(file: string | SourceFile): readonly string[] {
    return this.#services.symbols.exportNames(this.#scope(file).file.path)
  }

  /** Canonical identity of a symbol or declaration. */
  identityOf(target: SymbolResolution | Declaration): IdentityInfo | undefined {
    const identities = this.#services.identities
    return 'localName' in target ? identities.identityOfDeclaration(target) : identities.identityOf(target)
  }

  /**
   * Finds the entity named by a canonical identity (`src/a.ts#Foo`, `@acme/lib#tokens.Holder`,
   * `node:events#EventEmitter`, `globalThis#Date`).
   */
  lookupIdentity(identity: string): SymbolResolution {
    return this.#services.identities.lookup(identity)
  }

  // ---------------------------------------------------------------- types

  /** Converts a type annotation to a {@link TypeInfo} (missing annotation → opaque). */
  resolveType(
    scope: ScopeInput,
    node: TSType | TSTypeAnnotation | null | undefined,
    types?: TypeScope,
    options?: ResolveTypeOptions,
  ): TypeInfo {
    return this.#services.types.resolveType(this.#scope(scope), node, types, options)
  }

  /** Type parameters of a class, interface or type alias. */
  typeParametersOf(declaration: Declaration): TypeParameterInfo[] {
    return this.#services.types.typeParametersOf(declaration)
  }

  /** Scope binding a declaration's own type parameters (unbound), for {@link resolveType}. */
  typeScopeOf(declaration: Declaration): TypeScope {
    return this.#services.types.typeScopeOf(declaration)
  }

  /** Binds type parameters to arguments, filling defaults (see `substituteType`). */
  bindTypeArguments(declaration: Declaration, typeArgs: readonly TypeInfo[]): Map<string, TypeInfo> {
    return this.#services.types.bindTypeArguments(declaration, typeArgs)
  }

  /** `extends`/`implements` clauses of a class or interface, with type arguments. */
  heritageOf(declaration: Declaration): HeritageClause[] {
    return this.#services.types.heritageOf(declaration)
  }

  // ----------------------------------------------------------- evaluation

  /** Statically evaluates an expression (§4.6). */
  evaluate(scope: ScopeInput, expression: Expression, options?: EvaluateOptions): EvaluationResult {
    return this.#services.evaluator.evaluate(this.#scope(scope), expression, options)
  }

  // --------------------------------------------------------------- routes

  /**
   * Import route of a symbol, declaration or identity from `fromFile` (default: `outFile`).
   */
  importRoute(target: SymbolResolution | Declaration | string, fromFile?: string): ImportRouteResult {
    const resolved = typeof target === 'string' ? this.lookupIdentity(target) : target
    return this.#services.routes.routeOf(
      resolved,
      fromFile === undefined ? undefined : resolvePath(fromFile, this.root),
    )
  }

  // ------------------------------------------------------------- packages

  /** The root package (nearest named package.json of the root). */
  get rootPackage(): PackageInfo | undefined {
    return this.packages.rootPackage
  }

  /** Nearest named package of a file. */
  packageOf(path: string): PackageInfo | undefined {
    return this.packages.packageOf(this.#normalizePath(path))
  }

  /** Whether a file belongs to the application or to another package. */
  ownerOf(path: string): FileOwner {
    return this.packages.ownerOf(this.#normalizePath(path))
  }

  /** Validated `package.json#znight` manifest of a package (cached). Diagnostics are added to {@link diagnostics}. */
  manifestOf(info: PackageInfo): PackageManifest | undefined {
    return this.#manifest(info).manifest
  }

  // ---------------------------------------------------------- diagnostics

  /**
   * Diagnostics of the project layer, sorted: scan problems (manifests, libraries) and problems
   * found while resolving (casing mismatches). Resolution diagnostics are reset by `refresh()`.
   */
  diagnostics(): Diagnostic[] {
    const bag = new DiagnosticBag()
    bag.addAll(this.#scanDiagnostics.toArray())
    bag.addAll(this.#diagnostics.toArray())
    return bag.toArray()
  }

  // -------------------------------------------------------------- services

  /** Symbol resolution service of the current compile. */
  get symbols(): SymbolResolver {
    return this.#services.symbols
  }

  /** Identity service of the current compile. */
  get identities(): IdentityResolver {
    return this.#services.identities
  }

  /** Type service of the current compile. */
  get types(): TypeResolver {
    return this.#services.types
  }

  /** Static evaluator of the current compile. */
  get evaluator(): Evaluator {
    return this.#services.evaluator
  }

  /** Import route service of the current compile. */
  get routes(): RouteResolver {
    return this.#services.routes
  }

  // -------------------------------------------------------------- private

  #createServices(): Services {
    const symbols = new SymbolResolver(this)
    const identities = new IdentityResolver(this, symbols)
    return {
      symbols,
      identities,
      types: new TypeResolver(this, symbols, identities),
      evaluator: new Evaluator(this, symbols, identities),
      routes: new RouteResolver(this, symbols, identities),
    }
  }

  #scan(): void {
    this.#scanDiagnostics.clear()
    const files = new Set(scanDirectory(this.root, this.options))
    const discovery = discoverLibraries({
      options: this.options,
      packages: this.packages,
      resolver: this.resolver,
      manifestOf: info => this.#manifest(info),
    })
    for (const library of discovery.libraries) {
      for (const file of library.files) {
        files.add(file)
      }
    }
    this.#scanDiagnostics.addAll(discovery.diagnostics)
    for (const result of this.#manifests.values()) {
      this.#scanDiagnostics.addAll(result.diagnostics)
    }
    this.#libraries = discovery.libraries
    this.#scanned = [...files].sort()
    this.#scannedSet = new Set(this.#scanned)
  }

  #manifest(info: PackageInfo): ManifestResult {
    let result = this.#manifests.get(info.dir)
    if (!result) {
      result = readManifest(info)
      this.#manifests.set(info.dir, result)
      this.#scanDiagnostics.addAll(result.diagnostics)
    }
    return result
  }

  #scope(input: ScopeInput): ScopeRef {
    if (typeof input === 'string') {
      const file = this.getFile(input)
      if (!file) {
        throw new Error(`[znight] cannot read or parse ${input}`)
      }
      return { file }
    }
    return 'file' in input && typeof input.file === 'object' ? input : { file: input as SourceFile }
  }

  #normalizePath(path: string): string {
    const resolved = resolvePath(path, this.root)
    return realPath(resolved) ?? resolved
  }
}

/** `path` without its JavaScript/TypeScript extension (`.d.ts` included). */
function withoutExtension(path: string): string {
  return path.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, '')
}
