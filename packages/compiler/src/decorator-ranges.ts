/**
 * Ranges of the Znight decorators of each analysed file (§6.3 `stripDecorators`): the Vite plugin
 * and the Bun preload remove exactly these ranges from the bundle (never re-deciding), provided the
 * file content still has the analysed hash.
 */
import type { ClassInfo, DecoratorInfo } from './extensions/api.ts'
import type { Project, Span } from './project/index.ts'

import { compareStrings } from './project/compare.ts'

/** Znight decorators of one file. */
export interface DecoratorRanges {
  /** Content hash of the analysed file (`SourceFile.hash`): strip only when it still matches. */
  readonly hash: string
  /** `[start, end)` UTF-16 offsets of each decorator (`@` included), sorted, non-overlapping. */
  readonly ranges: readonly Span[]
}

/** Decorators owned by the core, an extension or a manifest, by absolute file path (scanned files only). */
export function collectDecoratorRanges(
  project: Project,
  classes: readonly ClassInfo[],
): ReadonlyMap<string, DecoratorRanges> {
  const byFile = new Map<string, Span[]>()
  const add = (decorator: DecoratorInfo): void => {
    if (decorator.owner === undefined || !project.isScanned(decorator.location.file)) {
      return
    }
    const list = byFile.get(decorator.location.file)
    const span = { start: decorator.location.start, end: decorator.location.end }
    if (list) {
      list.push(span)
    } else {
      byFile.set(decorator.location.file, [span])
    }
  }
  for (const cls of classes) {
    cls.decorators.forEach(add)
    if (cls.ctor.declaredBy === cls.identity) {
      for (const param of cls.ctor.params) {
        param.decorators.forEach(add)
      }
    }
    for (const method of cls.methods) {
      method.decorators.forEach(add)
      for (const param of method.params) {
        param.decorators.forEach(add)
      }
    }
    for (const property of cls.properties) {
      property.decorators.forEach(add)
    }
  }
  const result = new Map<string, DecoratorRanges>()
  for (const file of [...byFile.keys()].sort(compareStrings)) {
    const source = project.getFile(file)
    if (!source) {
      continue
    }
    const unique = new Map<string, Span>()
    for (const span of byFile.get(file) ?? []) {
      unique.set(`${span.start}:${span.end}`, span)
    }
    result.set(file, {
      hash: source.hash,
      ranges: [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end),
    })
  }
  return result
}
