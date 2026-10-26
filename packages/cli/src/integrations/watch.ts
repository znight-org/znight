/**
 * File watching for `znight generate --watch` (`fs.watch`, recursive on macOS, Windows and Linux with
 * Node.js >= 20 / Bun). It covers what the Vite plugin and the Bun preload watch: the `include`
 * directories of the project and of its source libraries (recursively), the project root
 * (`package.json`, `tsconfig.json`, lockfiles) and the directories of the files the last compile
 * depends on (`watchFiles`: library manifests, compiled libraries...), refreshed after every compile.
 *
 * Paths handed to the compiler are absolute, real (symbolic links resolved) and POSIX-style, like the
 * paths of the compiler itself (`watchFiles`, `includeRoots()`).
 */
import type { CompilerChanges } from './compiler.ts'

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

/** Extensions of the files the compiler parses (`isParseablePath()` of the compiler). */
const PARSEABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

/** Files changing module resolution (`isResolutionConfigPath()` of the compiler). */
const RESOLUTION_CONFIG_FILE =
  /^(?:package\.json|tsconfig.*\.json|jsconfig.*\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/

const GLOB_MAGIC = /[*?[\]{}()]/

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

/**
 * The static directory prefix of a glob (`globBase()` of the compiler): `src/**\/*.ts` → `src`,
 * `**\/*.ts` → `.`, `src/main.ts` → `src`.
 */
export function globBase(glob: string): string {
  const segments = glob.replace(/^!/, '').replaceAll('\\', '/').split('/')
  const base: string[] = []
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) return base.join('/') || '.'
    base.push(segment)
  }
  // a glob without magic is a file: its directory
  base.pop()
  return base.join('/') || '.'
}

/** Drops the directories nested in another one; sorted, de-duplicated. */
function outermost(directories: Iterable<string>): string[] {
  const sorted = [...new Set(directories)].sort()
  return sorted.filter(directory => !sorted.some(other => other !== directory && isWithin(other, directory)))
}

/**
 * Directories where a created or deleted file may change the scan (`includeRoots()` of the
 * compiler): the bases of the `include` globs in each of `bases` (the project root, then the
 * directories of the source libraries). Absolute, POSIX-style, sorted, nested ones dropped.
 */
export function includeRoots(bases: readonly string[], include: readonly string[]): string[] {
  return outermost(bases.flatMap(base => include.map(glob => toPosixPath(resolve(base, globBase(glob))))))
}

/**
 * Directories to watch: the include `roots` recursively; the project `root` and the directories of
 * `files` (the `watchFiles` of the last compile) that are outside them, non-recursively.
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

/** What {@link isRelevantChange} knows about the last compile. */
export interface WatchState {
  /** Files the last compile depends on (`watchFiles`): absolute, real, POSIX-style. */
  readonly known: ReadonlySet<string>
  /** Directories where a created or deleted source changes the scan ({@link includeRoots}). */
  readonly roots: readonly string[]
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
 * Whether a file system event on `file` (absolute, real, POSIX-style) can change the compile result,
 * like `isRelevantChange()` of the compiler: a file the last compile depends on, a resolution config
 * file (package.json, tsconfig, lockfile), a source under an include root — and, as `fs.watch`
 * reports a moved directory as one event on the directory alone, a directory created under an
 * include root or a deleted one that contained compiled files.
 */
export function isRelevantChange(file: string, state: WatchState): boolean {
  if (state.known.has(file)) return true
  if (file.split('/').includes('node_modules')) return false
  if (RESOLUTION_CONFIG_FILE.test(posix.basename(file))) return true
  const inRoots = state.roots.some(root => isWithin(root, file))
  if (inRoots && PARSEABLE_EXTENSIONS.has(posix.extname(file))) return true
  switch (kindOf(file)) {
    case 'directory':
      return inRoots
    case 'missing':
      return knownWithin(state.known, file).length > 0
    default:
      return false
  }
}

/**
 * Classifies relevant paths ({@link isRelevantChange}) for the incremental compiler, given the files
 * of the last compile: a deleted path is removed with the known files it contained (a directory moved
 * away), an existing directory is added (the compiler re-runs the scan) and the known files it
 * contains are re-read (or removed when gone), an existing file is changed when known, added
 * otherwise.
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
