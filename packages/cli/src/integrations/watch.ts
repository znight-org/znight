/**
 * File watching for `znight generate --watch` (`fs.watch`, recursive on macOS, Windows and Linux with
 * Node.js >= 20 / Bun). It covers what the Vite plugin and the Bun preload watch: the `include`
 * directories of the project and of its source libraries (recursively), the project root
 * (`package.json`, `tsconfig.json`, lockfiles) and the directories of the files the last compile
 * depends on (`watchFiles`: library manifests, compiled libraries...), refreshed after every compile.
 * Which events matter is the compiler's call (`includeRoots()`, `isRelevantChange()`); this module
 * only turns `fs.watch` events, which carry no kind and report a moved directory without its files,
 * into compiler changes.
 *
 * Paths handed to the compiler are absolute, real (symbolic links resolved) and POSIX-style, like the
 * paths of the compiler itself (`watchFiles`, `includeRoots()`).
 */
import type { ChangeKind, CompilerChanges } from './compiler.ts'

import { existsSync, type FSWatcher, realpathSync, statSync, watch } from 'node:fs'
import { join, posix, resolve } from 'node:path'

/** A directory to watch. */
export interface WatchTarget {
  readonly path: string
  readonly recursive: boolean
}

/** A running watcher. */
export interface FileWatcher {
  close(): void
}

/**
 * Starts watching `targets`; `onChange` receives the absolute path of every changed file or
 * directory (created, modified, deleted or renamed), except in ignored directories
 * ({@link isIgnoredPath}).
 */
export type WatchFactory = (targets: readonly WatchTarget[], onChange: (file: string) => void) => FileWatcher

const IGNORED_SEGMENTS = new Set(['node_modules', 'dist', 'coverage'])

/** Native separators to forward slashes (the compiler's path style, also on Windows). */
export function toPosixPath(path: string): string {
  return path.includes('\\') ? path.replaceAll('\\', '/') : path
}

/**
 * The absolute, POSIX-style real path of `path` (symbolic links resolved and the on-disk casing:
 * `/var` → `/private/var` on macOS), also when its last segments do not exist (anymore): the real
 * path of the deepest existing parent, then the rest. Makes watcher paths comparable with the
 * compiler's.
 */
export function realPath(path: string): string {
  const absolute = resolve(path)
  try {
    return toPosixPath(realpathSync.native(absolute))
  } catch {
    const parent = resolve(absolute, '..')
    if (parent === absolute) return toPosixPath(absolute)
    return `${realPath(parent).replace(/\/$/, '')}/${posix.basename(toPosixPath(absolute))}`
  }
}

/**
 * Whether a path relative to a watched directory is never relevant: inside `node_modules`, `dist`,
 * `coverage` or a dot directory (`.git`, `.znight`...).
 */
export function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(segment => IGNORED_SEGMENTS.has(segment) || segment.startsWith('.'))
}

/** `true` when `file` is `directory` or inside it (absolute POSIX paths). */
export function isWithin(directory: string, file: string): boolean {
  return file === directory || file.startsWith(directory.endsWith('/') ? directory : `${directory}/`)
}

/** Drops the directories nested in another one; sorted, de-duplicated. */
function outermost(directories: Iterable<string>): string[] {
  const sorted = [...new Set(directories)].sort()
  return sorted.filter(directory => !sorted.some(other => other !== directory && isWithin(other, directory)))
}

/**
 * Directories to watch: the include `roots` (`includeRoots()` of the compiler) recursively; the
 * project `root` and the directories of `files` (the `watchFiles` of the last compile) that are
 * outside them, non-recursively.
 */
export function watchTargets(root: string, roots: readonly string[], files: Iterable<string> = []): WatchTarget[] {
  const recursive = outermost(roots.map(toPosixPath))
  const covered = (directory: string): boolean => recursive.some(base => isWithin(base, directory))
  const flat = new Set<string>()
  const directories = [toPosixPath(resolve(root))]
  for (const file of files) directories.push(posix.dirname(toPosixPath(resolve(file))))
  for (const directory of directories) if (!covered(directory)) flat.add(directory)
  return [
    ...recursive.map(path => ({ path, recursive: true })),
    ...[...flat].sort().map(path => ({ path, recursive: false })),
  ]
}

type PathKind = 'file' | 'directory' | 'missing'

function kindOf(path: string): PathKind {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

/** The known files inside `directory`. */
function knownWithin(known: ReadonlySet<string>, directory: string): string[] {
  const prefix = directory.endsWith('/') ? directory : `${directory}/`
  return [...known].filter(file => file.startsWith(prefix))
}

/**
 * The kind of an `fs.watch` event on `file` (absolute, real, POSIX-style), which `fs.watch` does not
 * tell, from the disk and the files of the last compile (`known`): `removed` when it is gone,
 * `changed` for a known file, `added` otherwise (a new file, a directory created or moved there).
 */
export function changeKind(file: string, known: ReadonlySet<string>): ChangeKind {
  switch (kindOf(file)) {
    case 'missing':
      return 'removed'
    case 'directory':
      return 'added'
    default:
      return known.has(file) ? 'changed' : 'added'
  }
}

/**
 * Classifies relevant paths (`isRelevantChange()` of the compiler) for the incremental compiler,
 * given the files of the last compile: a deleted path is removed with the known files it contained
 * (a directory moved away), an existing directory is added (the compiler re-runs the scan) and the
 * known files it contains are re-read (or removed when gone), an existing file is changed when
 * known, added otherwise.
 */
export function classifyChanges(files: Iterable<string>, known: ReadonlySet<string>): CompilerChanges {
  const changed = new Set<string>()
  const added = new Set<string>()
  const removed = new Set<string>()
  for (const file of files) {
    switch (kindOf(file)) {
      case 'missing':
        removed.add(file)
        for (const inner of knownWithin(known, file)) removed.add(inner)
        break
      case 'directory':
        added.add(file)
        for (const inner of knownWithin(known, file)) (existsSync(inner) ? changed : removed).add(inner)
        break
      default:
        if (known.has(file)) changed.add(file)
        else added.add(file)
    }
  }
  return {
    changed: [...changed].filter(file => !removed.has(file)),
    added: [...added].filter(file => !removed.has(file)),
    removed: [...removed],
  }
}

/** The default {@link WatchFactory}, based on `fs.watch`. */
export const watchFiles: WatchFactory = (targets, onChange) => {
  const watchers: FSWatcher[] = []
  for (const target of targets) {
    if (!existsSync(target.path)) continue
    let watcher: FSWatcher
    try {
      watcher = watch(target.path, { recursive: target.recursive }, (_event, filename) => {
        // no file name (rare, Linux): something changed in the directory itself
        if (filename === null) {
          onChange(target.path)
          return
        }
        const name = filename.toString()
        if (!isIgnoredPath(name)) onChange(join(target.path, name))
      })
    } catch {
      // removed meanwhile (or not watchable): the next compile refreshes the targets
      continue
    }
    watcher.on('error', () => {
      // a watched directory was removed: keep the other watchers running
    })
    watchers.push(watcher)
  }
  return {
    close: () => {
      for (const watcher of watchers) watcher.close()
    },
  }
}

const targetKey = (target: WatchTarget): string => `${target.recursive ? 'r' : 'f'}:${target.path}`

/**
 * The watchers of a set of targets that changes after every compile: one watcher per target (started
 * with a {@link WatchFactory}), so that unchanged targets keep their watcher.
 */
export class TargetWatchers {
  readonly #factory: WatchFactory
  readonly #onChange: (file: string) => void
  readonly #watchers = new Map<string, { readonly watcher: FileWatcher; readonly existed: boolean }>()

  constructor(factory: WatchFactory, onChange: (file: string) => void) {
    this.#factory = factory
    this.#onChange = onChange
  }

  /** The watched targets. */
  get targets(): WatchTarget[] {
    return [...this.#watchers.keys()].map(key => ({ path: key.slice(2), recursive: key.startsWith('r') }))
  }

  /**
   * Watches exactly `targets`: stops the watchers of the targets that are gone, starts the new ones,
   * and restarts those whose directory was missing when they started, or was itself created, moved or
   * deleted since (`touched`: the paths of the last changes).
   */
  update(targets: readonly WatchTarget[], touched: ReadonlySet<string> = new Set()): void {
    const wanted = new Map(targets.map(target => [targetKey(target), target]))
    for (const [key, entry] of this.#watchers) {
      if (wanted.has(key)) continue
      entry.watcher.close()
      this.#watchers.delete(key)
    }
    for (const [key, target] of wanted) {
      const entry = this.#watchers.get(key)
      const exists = existsSync(target.path)
      if (entry !== undefined) {
        if (!exists || (entry.existed && !touched.has(target.path))) continue
        entry.watcher.close()
      }
      this.#watchers.set(key, { watcher: this.#factory([target], this.#onChange), existed: exists })
    }
  }

  close(): void {
    for (const entry of this.#watchers.values()) entry.watcher.close()
    this.#watchers.clear()
  }
}
