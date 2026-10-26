/**
 * Decorator stripping (§6.3 `stripDecorators`), shared by the Vite plugin and the Bun preload.
 *
 * The ranges come from the last analysis of the file (`CompileResult.decorators`) and are applied
 * only when the content still has the analysed hash: stripping never re-decides what a decorator is.
 *
 * - {@link stripDecorators} removes the ranges with magic-string (high-resolution source map), for
 *   bundles;
 * - {@link blankDecorators} replaces them with spaces (line breaks kept), so every position of the
 *   file is unchanged and no source map is needed (Bun loads the file in place).
 *
 * The first decorator of a class member is replaced by `;` (an empty class element) so that a
 * preceding field without semicolon cannot absorb the member once the decorator is gone.
 */
import type { SourceMap } from 'magic-string'
import type { DecoratorRanges } from './decorator-ranges.ts'

import MagicString from 'magic-string'

import { contentHash } from './project/hash.ts'

/** Result of {@link stripDecorators}. */
export interface StripResult {
  readonly code: string
  readonly map: SourceMap
}

/**
 * The decorator ranges of `entry` when they apply to `code` (same content hash and at least one
 * range), else `undefined`.
 */
export function applicableRanges(code: string, entry: DecoratorRanges | undefined): DecoratorRanges | undefined {
  if (entry === undefined || entry.ranges.length === 0) {
    return undefined
  }
  return contentHash(code) === entry.hash ? entry : undefined
}

/** Removes the decorator ranges from `code`. `file` names the source in the source map. */
export function stripDecorators(code: string, entry: DecoratorRanges, file: string): StripResult {
  const s = new MagicString(code)
  const members = new Set(entry.memberStarts)
  for (const { start, end } of entry.ranges) {
    if (members.has(start)) {
      s.overwrite(start, end, ';')
    } else {
      s.remove(start, end)
    }
  }
  return { code: s.toString(), map: s.generateMap({ hires: true, source: file, includeContent: true }) }
}

/** Every UTF-16 code unit but line terminators (`\r`, `\n`, U+2028, U+2029). */
const LINE_CONTENT = /[^\r\n\u2028\u2029]/g

/** Replaces the decorator ranges of `code` with spaces, keeping every line break and offset. */
export function blankDecorators(code: string, entry: DecoratorRanges): string {
  const members = new Set(entry.memberStarts)
  const parts: string[] = []
  let cursor = 0
  for (const { start, end } of entry.ranges) {
    parts.push(code.slice(cursor, start))
    const blanked = code.slice(start, end).replace(LINE_CONTENT, ' ')
    parts.push(members.has(start) ? ';'.concat(blanked.slice(1)) : blanked)
    cursor = end
  }
  parts.push(code.slice(cursor))
  return parts.join('')
}
