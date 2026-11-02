/**
 * Which dependency changes of a pull request reach the users of a published package, and the
 * changeset that announces them. Pure functions, used by `dependabot-changeset.ts` and covered by
 * `tests/dependabot-changeset.test.ts`.
 *
 * Users install what a published package declares in `dependencies`, `peerDependencies` and
 * `optionalDependencies`: a change of one of those versions is a change for them. The lockfile, the
 * `devDependencies`, the examples and the docs site are not, and neither is a bump that stays inside
 * a version range (the range does not change). A dependency that is added or removed is not an
 * update (Dependabot only changes versions): it is left to the author of the change.
 */
import type { Manifest } from './workspace.ts'

/** The manifest fields that users install. */
export const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

/** One of {@link RUNTIME_FIELDS}. */
export type RuntimeField = (typeof RUNTIME_FIELDS)[number]

type Versions = Readonly<Record<string, string>>

interface CatalogHolder {
  readonly catalog?: Versions
  readonly catalogs?: Readonly<Record<string, Versions>>
}

/**
 * The part of the root `package.json` that holds the version catalogs: Bun reads them at the top
 * level or under `workspaces` (where `workspaces` is an object instead of an array of globs).
 */
export interface RootManifest extends CatalogHolder {
  readonly workspaces?: CatalogHolder | readonly string[]
}

/** The version catalogs of a repository: `catalog:` is the default one, `catalog:<name>` a named one. */
export interface Catalogs {
  readonly default: Versions
  readonly named: Readonly<Record<string, Versions>>
}

/** Reads the catalogs of a root `package.json`. */
export function readCatalogs(root: RootManifest): Catalogs {
  const nested: CatalogHolder = Array.isArray(root.workspaces) ? {} : ((root.workspaces as CatalogHolder) ?? {})
  return {
    default: { ...nested.catalog, ...root.catalog },
    named: { ...nested.catalogs, ...root.catalogs },
  }
}

/** The version a specifier stands for: a `catalog:` specifier is looked up, anything else is itself. */
export function resolveVersion(name: string, specifier: string, catalogs: Catalogs): string {
  if (!specifier.startsWith('catalog:')) return specifier
  const catalog = specifier === 'catalog:' ? catalogs.default : catalogs.named[specifier.slice('catalog:'.length)]
  return catalog?.[name] ?? specifier
}

/** A dependency whose version changed. */
export interface DependencyChange {
  readonly name: string
  readonly field: RuntimeField
  readonly from: string
  readonly to: string
}

/** The runtime dependencies of a package whose version changed between two manifests, by name. */
export function dependencyChanges(
  base: Manifest,
  head: Manifest,
  baseCatalogs: Catalogs,
  headCatalogs: Catalogs,
): DependencyChange[] {
  const changes: DependencyChange[] = []
  for (const field of RUNTIME_FIELDS) {
    const before = base[field] ?? {}
    for (const [name, specifier] of Object.entries(head[field] ?? {})) {
      const previous = before[name]
      if (previous === undefined) continue
      const from = resolveVersion(name, previous, baseCatalogs)
      const to = resolveVersion(name, specifier, headCatalogs)
      if (from !== to) changes.push({ name, field, from, to })
    }
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name) || a.field.localeCompare(b.field))
}

/** A published package and the runtime dependencies of it that changed. */
export interface PackageChanges {
  readonly name: string
  readonly changes: readonly DependencyChange[]
}

/** The file of the changeset of a pull request, in `.changeset/`. */
export function changesetFile(pullRequest: number): string {
  return `dependabot-${pullRequest}.md`
}

function describeChange({ name, field, from, to }: DependencyChange): string {
  if (field === 'dependencies') return `${name} from ${from} to ${to}`
  return `the ${name} ${field === 'peerDependencies' ? 'peer' : 'optional'} dependency from ${from} to ${to}`
}

/**
 * The changeset of a pull request that updates runtime dependencies: a patch bump of every package
 * concerned (the whole lockstep group is released with it), and one line for the changelog.
 */
export function renderChangeset(packages: readonly PackageChanges[]): string {
  const names = packages.map(({ name }) => name).sort()
  const unique = new Map<string, DependencyChange>()
  for (const change of packages.flatMap(({ changes }) => changes)) {
    unique.set(`${change.name}|${change.field}|${change.from}|${change.to}`, change)
  }
  const summary = [...unique.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.field.localeCompare(b.field))
    .map(describeChange)
    .join(', ')
  return `---\n${names.map(name => `"${name}": patch\n`).join('')}---\n\nUpdate ${summary}.\n`
}
