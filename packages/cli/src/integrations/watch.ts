/**
 * File watching for `znight generate --watch` (`fs.watch`, recursive on macOS, Windows and Linux with
 * Node.js >= 20 / Bun). Only the source directories and the root (non-recursively, for
 * `package.json` / `tsconfig.json`) are watched, never `node_modules`.
 */
import { existsSync, type FSWatcher, watch } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** A directory to watch. */
export interface WatchTarget {
  readonly path: string
  readonly recursive: boolean
}

/** A running watcher. */
export interface FileWatcher {
  close(): void
}

/** Starts watching `targets`; `onChange` receives absolute paths of relevant changed files. */
export type WatchFactory = (targets: readonly WatchTarget[], onChange: (file: string) => void) => FileWatcher

const WATCHED_EXTENSIONS = /\.(?:[cm]?tsx?|json)$/
const IGNORED_SEGMENTS = new Set(['node_modules', 'dist', 'coverage'])

/** Whether a changed file (relative to its watched directory) can affect the compilation. */
export function isRelevantChange(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/)
  if (segments.some(segment => IGNORED_SEGMENTS.has(segment) || segment.startsWith('.'))) return false
  return WATCHED_EXTENSIONS.test(relativePath)
}

/** The default {@link WatchFactory}, based on `fs.watch`. */
export const watchFiles: WatchFactory = (targets, onChange) => {
  const watchers: FSWatcher[] = []
  for (const target of targets) {
    if (!existsSync(target.path)) continue
    const watcher = watch(target.path, { recursive: target.recursive }, (_event, filename) => {
      if (filename === null) return
      const name = filename.toString()
      if (isRelevantChange(name)) onChange(join(target.path, name))
    })
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

/** The static directory prefix of a glob: `src/**\/*.ts` → `src`, `**\/*.ts` → `.`. */
export function globBase(glob: string): string {
  const segments = glob.split('/')
  const base: string[] = []
  for (const segment of segments) {
    if (/[*?{}[\]!()]/.test(segment)) break
    base.push(segment)
  }
  // a glob without magic is a file: watch its directory
  if (base.length === segments.length) base.pop()
  return base.length === 0 ? '.' : base.join('/')
}

/** Directories to watch for the given `include` globs: their bases (recursively) and the root. */
export function watchTargets(root: string, include: readonly string[]): WatchTarget[] {
  const bases = [...new Set(include.map(glob => resolve(root, globBase(glob))))].sort()
  // drop bases nested in another base
  const recursive = bases.filter(base => !bases.some(other => other !== base && base.startsWith(other + sep)))
  const targets: WatchTarget[] = recursive.map(path => ({ path, recursive: true }))
  if (!recursive.includes(resolve(root))) targets.push({ path: resolve(root), recursive: false })
  return targets
}
