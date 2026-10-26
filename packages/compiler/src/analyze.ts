/**
 * Analysis entry point: class analysis (core + extensions) → compiled provider libraries (§6.4) →
 * binding (§4.7) → validation (§4.8) → {@link ApplicationGraph}, consumed by the code generator.
 *
 * ```ts
 * const project = new Project(normalizeOptions(options))
 * project.refresh()
 * const { graph, diagnostics } = await analyze(project)
 * ```
 *
 * The project must be refreshed by the caller (`project.refresh()` / incremental refreshes).
 * Diagnostics include the project layer's (manifests, casing) but not syntax errors, which callers
 * report first (`project.syntaxErrors()`).
 */

import type { ClassInfo, CompilerExtension } from './extensions/api.ts'
import type { AnalysisState } from './extensions/contexts.ts'
import type { ExtensionLoadResult, LoadedExtension } from './extensions/loader.ts'
import type { ApplicationGraph, Reachability } from './graph/types.ts'
import type { Diagnostic, Project, SourceFile } from './project/index.ts'

import { ErrorCode } from '@znight/core'

import { ClassAnalyzer } from './analysis/class-analyzer.ts'
import { DecoratorCatalog, DecoratorReader } from './analysis/decorators.ts'
import { ManifestIndex } from './analysis/manifests.ts'
import { ProviderBuilder } from './analysis/providers.ts'
import { ProviderRegistry } from './analysis/registry.ts'
import { Binder } from './binding/binder.ts'
import { NearMissAnalyzer } from './binding/near-miss.ts'
import { ExtensionAnalyzeContext, ExtensionValidateContext, ownedDecorators } from './extensions/contexts.ts'
import { loadExtensions } from './extensions/loader.ts'
import { buildGraph } from './graph/build.ts'
import { mergeCompiledLibraries } from './library/merge.ts'
import { compareStrings } from './project/compare.ts'
import { DiagnosticBag } from './project/index.ts'
import { checkCycles } from './validation/cycles.ts'
import { checkGeneratedModuleImports } from './validation/generated-module.ts'
import { checkLifecycle } from './validation/lifecycle.ts'
import { checkScopes } from './validation/scopes.ts'
import { computeReachability, reportUnused } from './validation/unused.ts'

/** Options of {@link analyze}. */
export interface AnalyzeOptions {
  /**
   * Extensions loaded beforehand with {@link loadExtensions} (e.g. cached by a watcher between
   * compiles). Default: loaded by `analyze()`.
   */
  readonly extensions?: ExtensionLoadResult
}

/** Statistics of an analysis. */
export interface AnalysisStats {
  /** Scanned files. */
  readonly files: number
  /** Analysed (decorated) classes. */
  readonly classes: number
  readonly providers: number
  readonly durationMs: number
}

/** Result of {@link analyze}. */
export interface AnalysisResult {
  readonly graph: ApplicationGraph
  /** Same as `graph.diagnostics`. */
  readonly diagnostics: readonly Diagnostic[]
  /** Decorated classes, sorted by identity. */
  readonly classes: readonly ClassInfo[]
  readonly extensions: readonly LoadedExtension[]
  readonly stats: AnalysisStats
}

/** Internal hooks (tests). */
export interface AnalysisInternals {
  /** Reorders the scanned files before class discovery (determinism tests). */
  readonly fileOrder?: (files: readonly SourceFile[]) => readonly SourceFile[]
}

/** Loads the compiler extensions (unless given) and analyses the project. */
export async function analyze(project: Project, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const extensions = options.extensions ?? (await loadExtensions(project))
  return analyzeProject(project, extensions)
}

/** Synchronous analysis with already loaded extensions. */
export function analyzeProject(
  project: Project,
  extensions: ExtensionLoadResult,
  internals: AnalysisInternals = {},
): AnalysisResult {
  const start = performance.now()
  const bag = new DiagnosticBag()
  const report = (diagnostic: Diagnostic): void => bag.add(diagnostic)
  bag.addAll(extensions.diagnostics)

  const loaded = extensions.extensions.map(entry => entry.extension)
  const manifests = new ManifestIndex(project)
  const catalog = new DecoratorCatalog(manifests, loaded, report)
  const reader = new DecoratorReader(project, catalog, report)
  const analyzer = new ClassAnalyzer(project, reader)

  // 1. classes
  const files = internals.fileOrder ? internals.fileOrder(project.files()) : project.files()
  const discovered: ClassInfo[] = []
  for (const file of files) {
    for (const declarations of file.facts.declarations.values()) {
      for (const declaration of declarations) {
        if (declaration.kind !== 'class' || declaration.ambient) {
          continue
        }
        const info = analyzer.infoOf(declaration)
        if (info.decorated) {
          discovered.push(info)
        }
      }
    }
  }
  const classes = discovered.sort((a, b) => compareStrings(a.identity, b.identity))
  const classMap = new Map(classes.map(info => [info.identity, info]))

  // 2. core analysis
  const registry = new ProviderRegistry()
  const builder = new ProviderBuilder(project, analyzer, catalog, manifests, registry, report)
  for (const info of classes) {
    builder.analyzeCore(info)
  }

  // 3. extensions
  const state: AnalysisState = {
    project,
    analyzer,
    builder,
    classes: classMap,
    report,
    edges: [],
    bindings: [],
    stored: new Map(),
    nextBindingId: 1,
  }
  for (const extension of loaded) {
    const analyzeClass = extension.analyzeClass
    if (!analyzeClass) {
      continue
    }
    const context = new ExtensionAnalyzeContext(extension.name, state)
    for (const info of classes) {
      if (ownedDecorators(info, extension.name).length === 0) {
        continue
      }
      try {
        analyzeClass.call(extension, info, context)
      } catch (error) {
        report(extensionFailure(extension, `analysing ${info.displayName}`, error, info.location))
      }
    }
  }

  // 3b. compiled provider libraries (§6.4): merged before binding, validated with the application
  mergeCompiledLibraries({
    project,
    analyzer,
    registry,
    state,
    extensions: new Set(loaded.map(extension => extension.name)),
    report,
  })

  // 4. class references (auto-registration), ineffective decorators
  builder.resolveClassRefs()
  builder.checkIneffective(classes)

  // 5. binding
  const binder = new Binder(project, registry, manifests, new NearMissAnalyzer(project, analyzer, registry), report)
  const bound = buildGraph({
    project,
    registry,
    manifests,
    binder,
    extensionEdges: state.edges,
    extensionBindings: state.bindings,
  })

  // 6. validation
  checkCycles(bound.providers, bound.edges, report)
  checkScopes(bound.providers, bound.externals, bound.edges, report)
  checkLifecycle(project, bound.providers, report)
  let reachability: Reachability | undefined
  if (project.options.reportUnused || project.options.prune) {
    reachability = computeReachability(project, bound.providers, bound.edges, bound.aliases)
    if (project.options.reportUnused) {
      reportUnused(bound.providers, reachability, report)
    }
  }
  const providerFiles = new Set(
    registry
      .all()
      .map(draft => draft.cls.file)
      .filter(file => project.isScanned(file)),
  )
  checkGeneratedModuleImports(project, providerFiles, report)

  const extensionData = loaded.map(extension => ({
    name: extension.name,
    stored: state.stored.get(extension.name) ?? [],
  }))
  const graphOf = (diagnostics: readonly Diagnostic[]): ApplicationGraph => ({
    providers: bound.providers,
    externals: bound.externals,
    aliases: bound.aliases,
    resolutionOrder: bound.resolutionOrder,
    edges: bound.edges,
    extensions: extensionData,
    bindings: bound.bindings,
    bindingRequests: bound.bindingRequests,
    reachability,
    diagnostics,
  })

  // 7. extension validation
  for (const extension of loaded) {
    if (!extension.validate) {
      continue
    }
    const context = new ExtensionValidateContext(extension.name, state, graphOf(bag.toArray()))
    try {
      extension.validate(context)
    } catch (error) {
      report(extensionFailure(extension, 'validating', error, undefined))
    }
  }

  bag.addAll(project.diagnostics())
  const diagnostics = bag.toArray()
  const graph = graphOf(diagnostics)
  return {
    graph,
    diagnostics,
    classes,
    extensions: extensions.extensions,
    stats: {
      files: files.length,
      classes: classes.length,
      providers: bound.providers.length,
      durationMs: performance.now() - start,
    },
  }
}

function extensionFailure(
  extension: CompilerExtension,
  activity: string,
  error: unknown,
  location: Diagnostic['location'],
): Diagnostic {
  const message = error instanceof Error ? error.message : String(error)
  return {
    code: ErrorCode.VersionMismatch,
    severity: 'error',
    message: `Compiler extension '${extension.name}' failed while ${activity}: ${message}`,
    ...(location ? { location } : {}),
    hints: ['This is a bug in the compiler extension (or an incompatible version of it)'],
  }
}
