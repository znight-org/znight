/**
 * The publishable packages of the repository: every `packages/*` workspace that is not private.
 * Examples (`examples/**`) and the docs site are private and never published.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

/**
 * Whether a changeset releases something: its front matter lists at least one package. An empty
 * changeset (`changeset add --empty`) opens no version pull request (changesets/action skips it)
 * and is deleted by the next `changeset version`, so it must not block a release.
 */
export function releasesSomething(contents: string): boolean {
  // the delimiters of @changesets/parse; a file without front matter is kept (`changeset` rejects it)
  const match = /^\s*---([\s\S]*?)\r?\n\s*---/.exec(contents)
  if (match === null) return true
  return (match[1] ?? '').split(/\r?\n/).some(line => line.trim() !== '' && !line.trim().startsWith('#'))
}

/** The pending changesets that release something (`.changeset/*.md` except the README and empty ones). */
export function pendingChangesets(root: string = ROOT): string[] {
  const dir = join(root, '.changeset')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(file => file.endsWith('.md') && file.toLowerCase() !== 'readme.md')
    .filter(file => releasesSomething(readFileSync(join(dir, file), 'utf8')))
    .sort()
    .map(file => `.changeset/${file}`)
}

/** The npm dist-tag for a version: `next` for prereleases (`1.0.0-beta.1`), `latest` otherwise. */
export function distTagFor(version: string): string {
  return version.includes('-') ? 'next' : 'latest'
}
