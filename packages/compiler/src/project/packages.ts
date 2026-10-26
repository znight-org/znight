/**
 * Package lookup: owner package of a file, root package, public entries and dependencies.
 *
 * The **owner** of a file is the nearest `package.json` *with a `name`* above its real path
 * (nameless `package.json` files such as `dist/esm/package.json` → `{ "type": "module" }` are
 * skipped). A file is an **application** file when it has no owner or when its owner is the root
 * package (the nearest named `package.json` of the project root); otherwise it belongs to a
 * **package** and gets package identities (§4.1).
 */

import fs from 'node:fs'

import { compareStrings } from './compare.ts'
import { dirName, publicPackageName, realPath } from './paths.ts'

/** A parsed `package.json`. */
export interface PackageInfo {
  /** `name` field (`undefined` for nameless package.json files). */
  readonly name: string | undefined
  /**
   * Name used in identities and import routes: `name`, except for DefinitelyTyped packages which
   * map to the package they type (`@types/pg` → `pg`).
   */
  readonly publicName: string | undefined
  readonly version: string | undefined
  /** Real path of the package directory. */
  readonly dir: string
  readonly packageJsonPath: string
  /** Raw text of package.json (used to locate diagnostics). */
  readonly text: string
  readonly json: Readonly<Record<string, unknown>>
}

/** A public entry of a package (`exports` subpath, or the root entry). */
export interface PackageEntry {
  /** `'.'` or `'./sub'`. */
  readonly subpath: string
  /** Bare specifier importing this entry: `@acme/lib`, `@acme/lib/sub`. */
  readonly specifier: string
}

/** Owner of a file. */
export type FileOwner =
  | { readonly kind: 'application'; readonly package: PackageInfo | undefined }
  | { readonly kind: 'package'; readonly package: PackageInfo }

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/** Cached `package.json` lookups. Clear it when any package.json changes. */
export class PackageRegistry {
  /** Real path of the project root. */
  readonly root: string
  readonly #byDir = new Map<string, PackageInfo | null>()
  readonly #ownerByDir = new Map<string, PackageInfo | null>()
  #rootPackage: PackageInfo | null | undefined

  constructor(root: string) {
    this.root = root
  }

  /** The nearest named package.json of the project root (`undefined` when there is none). */
  get rootPackage(): PackageInfo | undefined {
    if (this.#rootPackage === undefined) {
      this.#rootPackage = this.#nearestNamed(this.root) ?? null
    }
    return this.#rootPackage ?? undefined
  }

  /** The package.json located exactly in `dir` (real path), if any. */
  read(dir: string): PackageInfo | undefined {
    const cached = this.#byDir.get(dir)
    if (cached !== undefined) {
      return cached ?? undefined
    }
    const packageJsonPath = `${dir === '/' ? '' : dir}/package.json`
    let info: PackageInfo | null = null
    try {
      const text = fs.readFileSync(packageJsonPath, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const json = parsed as Record<string, unknown>
        const name = typeof json.name === 'string' && json.name !== '' ? json.name : undefined
        info = {
          name,
          publicName: name === undefined ? undefined : publicPackageName(name),
          version: typeof json.version === 'string' ? json.version : undefined,
          dir,
          packageJsonPath,
          text,
          json,
        }
      }
    } catch {
      info = null
    }
    this.#byDir.set(dir, info)
    return info ?? undefined
  }

  /** Nearest named package of a file (real path). */
  packageOf(file: string): PackageInfo | undefined {
    return this.#nearestNamed(dirName(file))
  }

  /** Nearest named package of a directory (real path), the directory itself included. */
  packageOfDirectory(dir: string): PackageInfo | undefined {
    return this.#nearestNamed(dir)
  }

  /** Whether a file is an application file or belongs to another package. */
  ownerOf(file: string): FileOwner {
    const owner = this.packageOf(file)
    const root = this.rootPackage
    if (owner === undefined || (root !== undefined && owner.dir === root.dir)) {
      return { kind: 'application', package: owner }
    }
    return { kind: 'package', package: owner }
  }

  /**
   * Public entries of a package: the root entry and every `exports` subpath (patterns with `*`
   * and `./package.json` are not enumerable and are skipped). Root first, then subpaths sorted.
   */
  entries(info: PackageInfo): PackageEntry[] {
    const name = info.publicName
    if (name === undefined) {
      return []
    }
    const exportsField = info.json.exports
    if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) {
      return [{ subpath: '.', specifier: name }]
    }
    const keys = Object.keys(exportsField)
    if (!keys.some(key => key.startsWith('.'))) {
      // Conditions object: only the root entry.
      return [{ subpath: '.', specifier: name }]
    }
    const record = exportsField as Record<string, unknown>
    const subpaths = keys
      .filter(key => key.startsWith('.') && !key.includes('*') && key !== './package.json' && record[key] !== null)
      .sort((a, b) => Number(b === '.') - Number(a === '.') || compareStrings(a, b))
    return subpaths.map(subpath => ({ subpath, specifier: subpath === '.' ? name : `${name}${subpath.slice(1)}` }))
  }

  /** Names listed in `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`, sorted. */
  dependencyNames(info: PackageInfo): string[] {
    const names = new Set<string>()
    for (const field of DEPENDENCY_FIELDS) {
      const value = info.json[field]
      if (typeof value === 'object' && value !== null) {
        for (const name of Object.keys(value)) {
          names.add(name)
        }
      }
    }
    return [...names].sort()
  }

  /**
   * Directory lookup of an installed package (`node_modules/<name>` walking up from `fromDir`),
   * independent of its `exports` map. Returns the package at its real path.
   */
  findInstalled(name: string, fromDir: string): PackageInfo | undefined {
    let dir = fromDir
    for (;;) {
      const candidate = realPath(`${dir === '/' ? '' : dir}/node_modules/${name}`)
      if (candidate !== undefined) {
        const info = this.read(candidate)
        if (info !== undefined) {
          return info
        }
      }
      const parent = dirName(dir)
      if (parent === dir) {
        return undefined
      }
      dir = parent
    }
  }

  /** Forgets every cached package.json (call when a package.json changes). */
  clear(): void {
    this.#byDir.clear()
    this.#ownerByDir.clear()
    this.#rootPackage = undefined
  }

  #nearestNamed(startDir: string): PackageInfo | undefined {
    const visited: string[] = []
    let dir = startDir
    let found: PackageInfo | null = null
    for (;;) {
      const cached = this.#ownerByDir.get(dir)
      if (cached !== undefined) {
        found = cached
        break
      }
      visited.push(dir)
      const info = this.read(dir)
      if (info?.name !== undefined) {
        found = info
        break
      }
      const parent = dirName(dir)
      if (parent === dir) {
        break
      }
      dir = parent
    }
    for (const visitedDir of visited) {
      this.#ownerByDir.set(visitedDir, found)
    }
    return found ?? undefined
  }
}
