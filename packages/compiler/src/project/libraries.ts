/**
 * Provider libraries analysed from source (§6.4): packages listed in the `libraries` option, and
 * dependencies of the root package whose manifest declares `"library": "source"`. A library is
 * scanned only when one of its public entries resolves to TypeScript sources with the scan
 * conditions (e.g. `@znight/source`); its providers then get package identities and routes.
 */

import type { ResolvedOptions } from '../options.ts'
import type { Diagnostic } from './diagnostics.ts'
import type { ManifestResult } from './manifest.ts'
import type { PackageInfo, PackageRegistry } from './packages.ts'
import type { ModuleResolver } from './resolver.ts'

import { ErrorCode } from '@znight/core'

import { compareStrings } from './compare.ts'
import { isTypeScriptSourcePath } from './paths.ts'
import { scanDirectory } from './scanner.ts'

/** A provider library scanned from source. */
export interface SourceLibrary {
  /** Public package name. */
  readonly name: string
  readonly package: PackageInfo
  /** Why it is a library. */
  readonly origin: 'option' | 'manifest'
  /** TypeScript files the public entries resolve to. */
  readonly entries: readonly string[]
  /** Every scanned file of the library (entries + `include` globs relative to the package). */
  readonly files: readonly string[]
}

/** Inputs of {@link discoverLibraries}. */
export interface LibraryDiscoveryInput {
  readonly options: ResolvedOptions
  readonly packages: PackageRegistry
  readonly resolver: ModuleResolver
  readonly manifestOf: (info: PackageInfo) => ManifestResult
}

/** Result of {@link discoverLibraries}. */
export interface LibraryDiscovery {
  readonly libraries: readonly SourceLibrary[]
  readonly diagnostics: readonly Diagnostic[]
}

/** Finds the provider libraries to scan from source and lists their files. */
export function discoverLibraries(input: LibraryDiscoveryInput): LibraryDiscovery {
  const { options, packages, resolver } = input
  const diagnostics: Diagnostic[] = []
  const candidates = new Map<string, 'option' | 'manifest'>()
  for (const name of options.libraries) {
    candidates.set(name, 'option')
  }
  const root = packages.rootPackage
  if (root) {
    for (const dependency of packages.dependencyNames(root)) {
      const info = packages.findInstalled(dependency, options.root)
      if (info && !candidates.has(dependency) && input.manifestOf(info).manifest?.library === 'source') {
        candidates.set(dependency, 'manifest')
      }
    }
  }

  const libraries: SourceLibrary[] = []
  for (const [name, origin] of [...candidates].sort(([a], [b]) => compareStrings(a, b))) {
    const resolution = resolver.resolveFromDirectory(options.root, name, 'scan')
    const info =
      resolution.kind === 'file' ? packages.packageOf(resolution.path) : packages.findInstalled(name, options.root)
    if (!info || info.name === undefined || (root !== undefined && info.dir === root.dir)) {
      if (origin === 'option') {
        diagnostics.push({
          code: ErrorCode.UnresolvableType,
          severity: 'warning',
          message: `Provider library '${name}' cannot be resolved from ${options.root}`,
          hints: [`Install '${name}' or remove it from the "libraries" option`],
        })
      }
      continue
    }
    const entries = new Set<string>()
    for (const entry of packages.entries(info)) {
      const specifier = entry.subpath === '.' ? info.name : `${info.name}${entry.subpath.slice(1)}`
      const entryResolution = resolver.resolveFromDirectory(info.dir, specifier, 'scan')
      if (entryResolution.kind === 'file' && isTypeScriptSourcePath(entryResolution.path)) {
        entries.add(entryResolution.path)
      }
    }
    if (entries.size === 0) {
      if (origin === 'option') {
        diagnostics.push({
          code: ErrorCode.UnresolvableType,
          severity: 'warning',
          message: `Provider library '${name}' does not resolve to TypeScript sources with the scan conditions (${options.scanConditions.join(', ')}); it is not analysed from source`,
          hints: [
            'Add the condition exposing its sources to the "conditions" option (e.g. \'@znight/source\')',
            'Or publish compiled provider metadata (library mode, "znight.providers" in its package.json)',
          ],
        })
      }
      continue
    }
    const files = new Set(scanDirectory(info.dir, options))
    for (const entry of entries) {
      files.add(entry)
    }
    libraries.push({
      name: info.publicName ?? name,
      package: info,
      origin,
      entries: [...entries].sort(),
      files: [...files].sort(),
    })
  }
  return { libraries, diagnostics }
}
