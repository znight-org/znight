import fs from 'node:fs'

import { contentHash } from './hash.ts'
import { isParseablePath } from './paths.ts'
import { SourceFile } from './source-file.ts'

interface CacheEntry {
  /** `undefined` when the file does not exist or cannot be parsed. */
  readonly file: SourceFile | undefined
  /** Set by {@link FileCache.invalidate}: the next access re-reads the file. */
  stale: boolean
}

/** Parse statistics, reset by {@link FileCache.resetStats}. */
export interface FileCacheStats {
  /** Files parsed (new file or content hash changed). */
  parsed: number
  /** Files re-read whose content hash was unchanged (the previous parse was reused). */
  reused: number
}

/**
 * Parse cache keyed by path and content hash. A file is read once and re-read only after
 * {@link FileCache.invalidate}; it is re-parsed only when its content hash changed.
 */
export class FileCache {
  readonly #entries = new Map<string, CacheEntry>()
  readonly stats: FileCacheStats = { parsed: 0, reused: 0 }

  /** Cached parse of `path` (absolute POSIX real path), loading it on first access. */
  get(path: string): SourceFile | undefined {
    const entry = this.#entries.get(path)
    if (entry && !entry.stale) {
      return entry.file
    }
    return this.#load(path, entry)
  }

  /** `true` when the file is in the cache (whatever its state). */
  has(path: string): boolean {
    return this.#entries.has(path)
  }

  /** Paths currently cached. */
  paths(): IterableIterator<string> {
    return this.#entries.keys()
  }

  /** Forces the next {@link get} to re-read the file (its parse is reused if the hash is unchanged). */
  invalidate(path: string): void {
    const entry = this.#entries.get(path)
    if (entry) {
      entry.stale = true
    }
  }

  /**
   * Invalidates every cached file. Files are re-read lazily; unchanged contents (same hash) keep
   * their parse, so this only costs a read + hash per file actually used afterwards.
   */
  invalidateAll(): void {
    for (const entry of this.#entries.values()) {
      entry.stale = true
    }
  }

  delete(path: string): void {
    this.#entries.delete(path)
  }

  clear(): void {
    this.#entries.clear()
  }

  resetStats(): void {
    this.stats.parsed = 0
    this.stats.reused = 0
  }

  #load(path: string, previous: CacheEntry | undefined): SourceFile | undefined {
    let text: string | undefined
    if (isParseablePath(path)) {
      try {
        text = fs.readFileSync(path, 'utf8')
      } catch {
        text = undefined
      }
    }
    if (text === undefined) {
      this.#entries.set(path, { file: undefined, stale: false })
      return undefined
    }
    const hash = contentHash(text)
    let file: SourceFile | undefined
    if (previous?.file && previous.file.hash === hash) {
      file = previous.file
      this.stats.reused++
    } else {
      file = SourceFile.parse(path, text, hash)
      this.stats.parsed++
    }
    this.#entries.set(path, { file, stale: false })
    return file
  }
}
