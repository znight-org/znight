import type { ResolvedOptions } from '../options.ts'
import type { Span } from './location.ts'
import type { PackageRegistry } from './packages.ts'
import type { ModuleResolution, ResolutionMode } from './resolver.ts'
import type { SourceFile } from './source-file.ts'

/**
 * Services the resolution modules (symbols, identities, types, evaluation, routes) need from the
 * project. Implemented by {@link Project}; tests may provide their own.
 */
export interface ProjectHost {
  readonly options: ResolvedOptions
  readonly packages: PackageRegistry
  /** Parsed file at an absolute real path (scanned or loaded on demand), `undefined` if unparseable. */
  getFile(path: string): SourceFile | undefined
  /**
   * Resolves `specifier` imported by `fromFile`. When `span` (the specifier literal) is given and
   * the importer is an analysed file, problems such as casing mismatches are reported.
   */
  resolveModule(fromFile: string, specifier: string, span?: Span, mode?: ResolutionMode): ModuleResolution
  /** Resolves `specifier` from a directory without tsconfig lookup (package self-references). */
  resolveFromDirectory(directory: string, specifier: string, mode?: ResolutionMode): ModuleResolution
}
