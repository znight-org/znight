/**
 * The publishable packages of the repository: every `packages/*` workspace that is not private.
 * Examples (`examples/**`) and the docs site are private and never published.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseChangesetFile } from '@changesets/parse'

/** Repository root. */
export const ROOT: string = resolve(import.meta.dir, '../..')

/**
 * GitHub repository the packages are published from: npm provenance checks `repository.url` against
 * it. Not read from `GITHUB_REPOSITORY`, so that CI on forks checks the same thing.
 */
export const REPOSITORY = 'znight-org/znight'

export type DependencyField = 'dependencies' | 'peerDependencies' | 'optionalDependencies' | 'devDependencies'

export const DEPENDENCY_FIELDS: readonly DependencyField[] = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
]

/** The `package.json` fields the release scripts read. */
export interface Manifest {
  readonly name: string
  readonly version: string
  readonly private?: boolean
  readonly license?: string
  readonly repository?: string | { readonly type?: string; readonly url?: string; readonly directory?: string }
  readonly publishConfig?: { readonly access?: string; readonly tag?: string }
  readonly exports?: unknown
  readonly main?: string
  readonly module?: string
  readonly types?: string
  readonly bin?: string | Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

export interface WorkspacePackage {
  readonly name: string
  readonly version: string
  /** Absolute path of the package directory. */
  readonly dir: string
  readonly manifest: Manifest
}

/** Reads and parses a `package.json`. */
export function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest
}

/** The publishable packages (`packages/*` not marked private), dependencies first. */
export function publishablePackages(root: string = ROOT): WorkspacePackage[] {
  const packagesDir = join(root, 'packages')
  const found: WorkspacePackage[] = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    const dir = join(packagesDir, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue
    const manifest = readManifest(manifestPath)
    if (manifest.private === true) continue
    found.push({ name: manifest.name, version: manifest.version, dir, manifest })
  }
  return sortByDependencies(found)
}

/**
 * Orders packages so that each one comes after the workspace packages it depends on (dependencies,
 * peer and optional dependencies; dev dependencies are not needed at install time). Ties are broken
 * by name, so the order is stable.
 */
export function sortByDependencies(packages: readonly WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const sorted: WorkspacePackage[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (pkg: WorkspacePackage, path: readonly string[]): void => {
    const current = state.get(pkg.name)
    if (current === 'done') return
    if (current === 'visiting')
      throw new Error(`Dependency cycle between packages: ${[...path, pkg.name].join(' -> ')}`)
    state.set(pkg.name, 'visiting')
    for (const name of internalDependencies(pkg.manifest, byName).sort()) {
      const dependency = byName.get(name)
      if (dependency !== undefined) visit(dependency, [...path, pkg.name])
    }
    state.set(pkg.name, 'done')
    sorted.push(pkg)
  }
  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg, [])
  return sorted
}

function internalDependencies(manifest: Manifest, packages: ReadonlyMap<string, WorkspacePackage>): string[] {
  const names = new Set<string>()
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (packages.has(name) && name !== manifest.name) names.add(name)
    }
  }
  return [...names]
}

/**
 * The version shared by every publishable package. Packages are released in lockstep (Changesets
 * `fixed` group): different versions mean the repository is in an unexpected state.
 */
export function lockstepVersion(packages: readonly WorkspacePackage[]): string {
  const versions = new Set(packages.map(pkg => pkg.version))
  const [version] = versions
  if (versions.size !== 1 || version === undefined) {
    const list = packages.map(pkg => `  ${pkg.name}@${pkg.version}`).join('\n')
    throw new Error(`Publishable packages must share one version (Changesets "fixed" group), found:\n${list}`)
  }
  return version
}

/** A package bumped by a changeset. */
export interface ChangesetRelease {
  readonly name: string
  readonly type: string
}

/**
 * The releases of a changeset, read with Changesets' own parser (`@changesets/parse`, as
 * `changeset version` reads it). Throws, naming `file`, when the changeset cannot be read (front
 * matter, YAML, version type) or bumps a package that is not published: such a changeset fails the
 * pull request that adds it instead of the version job of the release workflow on `main`. An empty
 * changeset (`changeset add --empty`) has no releases.
 */
export function changesetReleases(
  file: string,
  contents: string,
  published: ReadonlySet<string>,
): readonly ChangesetRelease[] {
  let releases: readonly ChangesetRelease[]
  try {
    releases = parseChangesetFile(contents).releases
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  for (const { name } of releases) {
    if (!published.has(name)) {
      throw new Error(`${file}: "${name}" is not a published package (${[...published].sort().join(', ')})`)
    }
  }
  return releases
}

/**
 * The pending changesets that release something (`.changeset/*.md` except the README), checked by
 * {@link changesetReleases}. An empty changeset opens no version pull request (changesets/action
 * skips it) and is deleted by the next `changeset version`, so it must not block a release.
 */
export function pendingChangesets(root: string = ROOT): string[] {
  const dir = join(root, '.changeset')
  if (!existsSync(dir)) return []
  const published = new Set(publishablePackages(root).map(pkg => pkg.name))
  return readdirSync(dir)
    .filter(file => file.endsWith('.md') && file.toLowerCase() !== 'readme.md')
    .sort()
    .filter(
      file => changesetReleases(`.changeset/${file}`, readFileSync(join(dir, file), 'utf8'), published).length > 0,
    )
    .map(file => `.changeset/${file}`)
}

/** The npm dist-tag for a version: `next` for prereleases (`1.0.0-beta.1`), `latest` otherwise. */
export function distTagFor(version: string): string {
  return version.includes('-') ? 'next' : 'latest'
}
