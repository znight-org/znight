import type { ErrorCode } from '@znight/core'
import type { Location } from './location.ts'

import { compareStrings } from './compare.ts'

/** Severity of a compiler diagnostic. */
export type DiagnosticSeverity = 'error' | 'warning'

/** Secondary location attached to a diagnostic (e.g. "declared here"). */
export interface RelatedInformation {
  readonly message: string
  readonly location: Location
}

/**
 * A build-time problem (§6.2). Every compiler phase reports this shape; `formatDiagnostics` prints
 * it with a code frame. `location.file` is an absolute POSIX path.
 */
export interface Diagnostic {
  readonly code: ErrorCode
  readonly severity: DiagnosticSeverity
  readonly message: string
  readonly location?: Location
  readonly hints?: readonly string[]
  readonly related?: readonly RelatedInformation[]
}

/** Deterministic ordering: file, offset, code, message. Diagnostics without location come first. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const fileA = a.location?.file ?? ''
  const fileB = b.location?.file ?? ''
  if (fileA !== fileB) {
    return fileA < fileB ? -1 : 1
  }
  const offset = (a.location?.start ?? -1) - (b.location?.start ?? -1)
  if (offset !== 0) {
    return offset
  }
  if (a.code !== b.code) {
    return a.code < b.code ? -1 : 1
  }
  return compareStrings(a.message, b.message)
}

/** Stable key used to de-duplicate diagnostics reported several times. */
export function diagnosticKey(diagnostic: Diagnostic): string {
  const location = diagnostic.location
  return `${diagnostic.code}\0${location?.file ?? ''}\0${location?.start ?? ''}\0${diagnostic.message}`
}

/** Collects diagnostics, ignoring exact duplicates. */
export class DiagnosticBag {
  readonly #items = new Map<string, Diagnostic>()

  add(diagnostic: Diagnostic): void {
    const key = diagnosticKey(diagnostic)
    if (!this.#items.has(key)) {
      this.#items.set(key, diagnostic)
    }
  }

  addAll(diagnostics: Iterable<Diagnostic>): void {
    for (const diagnostic of diagnostics) {
      this.add(diagnostic)
    }
  }

  clear(): void {
    this.#items.clear()
  }

  get size(): number {
    return this.#items.size
  }

  /** Diagnostics sorted with {@link compareDiagnostics}. */
  toArray(): Diagnostic[] {
    return [...this.#items.values()].sort(compareDiagnostics)
  }
}
