import { globSync } from 'tinyglobby'

import { isParseablePath, realPath, toPosixPath } from './paths.ts'

/** Inputs of {@link scanDirectory}. */
export interface ScanOptions {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  /** Absolute path of the generated module, never scanned. */
  readonly outFile: string
}

/** Globs always excluded from scans. Dot-files and dot-directories are excluded too (`dot: false`). */
export const ALWAYS_EXCLUDED: readonly string[] = ['**/node_modules/**']

/**
 * Lists the files of `dir` matching `include` and not `exclude` (globs relative to `dir`).
 * `node_modules`, dot-directories (`.znight`, `.git`...) and `outFile` are always excluded.
 * Returns absolute real paths with the on-disk casing, de-duplicated and sorted.
 */
export function scanDirectory(dir: string, options: ScanOptions): string[] {
  const matches = globSync([...options.include], {
    cwd: dir,
    ignore: [...options.exclude, ...ALWAYS_EXCLUDED],
    absolute: true,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: true,
    expandDirectories: false,
  })
  const outFile = realPath(options.outFile) ?? options.outFile
  const files = new Set<string>()
  for (const match of matches) {
    const file = realPath(match) ?? toPosixPath(match)
    if (file !== outFile && file !== options.outFile && isParseablePath(file)) {
      files.add(file)
    }
  }
  return [...files].sort()
}
