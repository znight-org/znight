/**
 * Watch helpers shared by the Vite plugin, the Bun preload and `znight generate --watch` (§6.3):
 * which paths to watch, how a file event becomes a compiler change, and the set of changes
 * accumulated between two compiles. `includeRoots()` and `isRelevantChange()` are public (the CLI
 * watches with them).
 */
import type { ZnightCompiler } from './compiler.ts'
import type { ProjectChanges } from './project/index.ts'

import fs from 'node:fs'
import path from 'node:path'

import { isParseablePath, isResolutionConfigPath, isWithin, realPath, resolvePath } from './project/paths.ts'

/** Kind of a file system event, as the compiler sees it. */
export type ChangeKind = 'changed' | 'added' | 'removed'

const GLOB_MAGIC = /[*?[\]{}()]/

/**
 * Static base directory of a glob, relative to the directory the glob is applied in:
 * `src/**\/*.ts` → `src`, `**\/*.ts` → `.`, `lib/main.ts` → `lib`.
 */
export function globBase(glob: string): string {
  const segments = glob.replace(/^!/, '').replaceAll('\\', '/').split('/')
  const base: string[] = []
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) {
      return base.join('/') || '.'
    }
    base.push(segment)
  }
  base.pop()
  return base.join('/') || '.'
}

/**
 * Directories where a created or deleted file may change the scan: the bases of the `include`
 * globs, in the project root and in every source library. Sorted, absolute, de-duplicated (a
 * directory inside another one is dropped).
 */
export function includeRoots(compiler: ZnightCompiler): string[] {
  const { include, root } = compiler.options
  const bases = [root, ...compiler.project.libraries().map(library => library.package.dir)]
  const roots = new Set<string>()
  for (const base of bases) {
    for (const glob of include) {
      roots.add(resolvePath(globBase(glob), base))
    }
  }
  const sorted = [...roots].sort()
  return sorted.filter(dir => !sorted.some(other => other !== dir && isWithin(other, dir)))
}

/**
 * `true` when `file` is the generated module, also when it is reached through a symbolic link
 * (`/var` → `/private/var` on macOS): watchers must ignore it.
 */
export function isOutFile(compiler: ZnightCompiler, file: string): boolean {
  if (compiler.isOutFile(file)) {
    return true
  }
  const resolved = resolvePath(file)
  const directory = realPath(path.dirname(resolved))
  return directory !== undefined && `${directory}/${path.basename(resolved)}` === compiler.options.outFile
}

/**
 * Whether a file system event can change the compile result: a change of a file the last result
 * depends on (`watched`: its `watchFiles`) or of a resolution config file (package.json, tsconfig,
 * lockfile), a source created or deleted under an include root (`roots`: {@link includeRoots}), a
 * file created where a relative import of the last compile did not resolve. The generated module
 * and `node_modules` (except the watched files) are ignored.
 *
 * Watchers that report a moved or deleted directory as one event on the directory alone (`fs.watch`)
 * also get: a directory created under an include root (`added`), and a removed path that contained
 * watched files (`removed`).
 */
export function isRelevantChange(
  compiler: ZnightCompiler,
  kind: ChangeKind,
  file: string,
  watched: ReadonlySet<string>,
  roots: readonly string[],
): boolean {
  const resolved = resolvePath(file)
  if (isOutFile(compiler, resolved)) {
    return false
  }
  const real = kind === 'removed' ? resolved : (realPath(resolved) ?? resolved)
  if (watched.has(real) || watched.has(resolved)) {
    return true
  }
  if (real.includes('/node_modules/')) {
    return false
  }
  if (isResolutionConfigPath(real)) {
    return true
  }
  const inRoots = roots.some(dir => isWithin(dir, real) || isWithin(dir, resolved))
  if (isParseablePath(real)) {
    if (kind === 'added' && compiler.project.isMissingImport(real)) {
      return true
    }
    return kind !== 'changed' && inRoots
  }
  if (kind === 'removed') {
    return containsWatched(watched, resolved)
  }
  return kind === 'added' && inRoots && isDirectory(real)
}

/** `true` when a watched file is inside `directory`. */
function containsWatched(watched: ReadonlySet<string>, directory: string): boolean {
  const prefix = directory.endsWith('/') ? directory : `${directory}/`
  for (const file of watched) {
    if (file.startsWith(prefix)) {
      return true
    }
  }
  return false
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

/** Changes accumulated between two compiles. */
export class PendingChanges {
  readonly #changed = new Set<string>()
  readonly #added = new Set<string>()
  readonly #removed = new Set<string>()

  /** Number of recorded paths. */
  get size(): number {
    return this.#changed.size + this.#added.size + this.#removed.size
  }

  add(kind: ChangeKind, file: string): void {
    const resolved = resolvePath(file)
    if (kind === 'changed') {
      this.#changed.add(resolved)
    } else if (kind === 'added') {
      this.#removed.delete(resolved)
      this.#added.add(resolved)
    } else {
      this.#added.delete(resolved)
      this.#changed.delete(resolved)
      this.#removed.add(resolved)
    }
  }

  /** The recorded changes (`undefined` when there is none), then forgets them. */
  take(): ProjectChanges | undefined {
    if (this.size === 0) {
      return undefined
    }
    const changes = { changed: [...this.#changed], added: [...this.#added], removed: [...this.#removed] }
    this.clear()
    return changes
  }

  clear(): void {
    this.#changed.clear()
    this.#added.clear()
    this.#removed.clear()
  }
}
