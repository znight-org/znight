/**
 * Source positions.
 *
 * oxc-parser (JS API, 0.155) reports `start`/`end` as **UTF-16 code unit offsets** into the source
 * string (the same unit as `String.prototype.slice`), including a leading BOM. Lines and columns are
 * 1-based; columns count UTF-16 code units like `tsc` and the Language Server Protocol do (an emoji
 * outside the BMP counts as 2 columns). Line terminators are `\n`, `\r\n` and `\r`.
 */

/** Half-open `[start, end)` range of UTF-16 offsets, as found on every oxc AST node. */
export interface Span {
  readonly start: number
  readonly end: number
}

/** 1-based line and column. */
export interface Position {
  readonly line: number
  readonly column: number
}

/**
 * A located range in a file. Compatible with `Diagnostic.location` (`{ file, line, column }`) and
 * carries the end position and raw offsets for code frames.
 */
export interface Location {
  /** Absolute POSIX path of the file. */
  readonly file: string
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly endColumn: number
  /** UTF-16 offset of the first character. */
  readonly start: number
  /** UTF-16 offset after the last character. */
  readonly end: number
}

/** Maps UTF-16 offsets to 1-based line/column positions (binary search over line starts). */
export class LineIndex {
  readonly #lineStarts: number[]
  readonly #length: number

  constructor(text: string) {
    const starts = [0]
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code === 10 /* \n */) {
        starts.push(index + 1)
      } else if (code === 13 /* \r */) {
        if (text.charCodeAt(index + 1) === 10) {
          index++
        }
        starts.push(index + 1)
      }
    }
    this.#lineStarts = starts
    this.#length = text.length
  }

  /** Number of lines (a trailing newline opens an empty last line). */
  get lineCount(): number {
    return this.#lineStarts.length
  }

  /** Offset of the first character of a 1-based line. */
  lineStart(line: number): number {
    return this.#lineStarts[Math.min(Math.max(line, 1), this.#lineStarts.length) - 1] ?? 0
  }

  /** 1-based position of a UTF-16 offset (clamped to the text). */
  positionAt(offset: number): Position {
    const target = Math.min(Math.max(offset, 0), this.#length)
    const starts = this.#lineStarts
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if ((starts[middle] ?? 0) <= target) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    return { line: low + 1, column: target - (starts[low] ?? 0) + 1 }
  }
}
