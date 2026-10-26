/**
 * A small Wadler-style pretty printer (the algorithm used by Prettier): code is first built as a
 * tree of {@link Doc}s, then rendered with a maximum line width. A group is printed on one line when
 * it fits, otherwise its lines break.
 *
 * The generated module is formatted with it so that it reads like hand-written code (2 spaces,
 * trailing commas, 120 columns), deterministically.
 */

/** A pretty-printing document. */
export type Doc = string | readonly Doc[] | DocGroup | DocIndent | DocLine | DocIfBreak | DocLazy | DocMark

/** Contents printed flat when they fit on the line, broken otherwise (or always when `break`). */
export interface DocGroup {
  readonly kind: 'group'
  readonly contents: Doc
  readonly break: boolean
}

/** Contents whose broken lines are indented one more level. */
export interface DocIndent {
  readonly kind: 'indent'
  readonly contents: Doc
}

/** A line break: `' '` (`line`) or `''` (`softline`) when flat; `hardline` always breaks. */
export interface DocLine {
  readonly kind: 'line'
  readonly soft: boolean
  readonly hard: boolean
}

/** `broken` when the enclosing group breaks, `flat` otherwise (trailing commas). */
export interface DocIfBreak {
  readonly kind: 'ifBreak'
  readonly broken: Doc
  readonly flat: Doc
}

/** Text known only at render time (import names, assigned after the whole module is built). */
export interface DocLazy {
  readonly kind: 'lazy'
  readonly text: () => string
}

/** Records the output offset where it is rendered (used to map syntax errors back to sections). */
export interface DocMark {
  readonly kind: 'mark'
  readonly id: string
  readonly edge: 'start' | 'end'
}

/** A space when flat, a newline when broken. */
export const line: DocLine = Object.freeze({ kind: 'line', soft: false, hard: false })
/** Nothing when flat, a newline when broken. */
export const softline: DocLine = Object.freeze({ kind: 'line', soft: true, hard: false })
/** Always a newline (breaks every enclosing group). */
export const hardline: DocLine = Object.freeze({ kind: 'line', soft: false, hard: true })

/** A group. */
export function group(contents: Doc, options: { readonly break?: boolean } = {}): DocGroup {
  return { kind: 'group', contents, break: options.break === true }
}

/** An indented block. */
export function indent(contents: Doc): DocIndent {
  return { kind: 'indent', contents }
}

/** Conditional contents. */
export function ifBreak(broken: Doc, flat: Doc = ''): DocIfBreak {
  return { kind: 'ifBreak', broken, flat }
}

/** Text resolved at render time. */
export function lazy(text: () => string): DocLazy {
  return { kind: 'lazy', text }
}

/** Wraps `contents` with start/end marks named `id`. */
export function marked(id: string, contents: Doc): Doc {
  return [{ kind: 'mark', id, edge: 'start' }, contents, { kind: 'mark', id, edge: 'end' }]
}

/** `items` separated by `separator`. */
export function join(separator: Doc, items: readonly Doc[]): Doc[] {
  const result: Doc[] = []
  items.forEach((item, index) => {
    if (index > 0) {
      result.push(separator)
    }
    result.push(item)
  })
  return result
}

/**
 * A bracketed, comma-separated list: `[a, b]` when it fits, otherwise one item per line with a
 * trailing comma. `spaced` adds inner spaces when flat (`{ a: 1 }`).
 */
export function list(
  open: string,
  close: string,
  items: readonly Doc[],
  options: { readonly spaced?: boolean; readonly break?: boolean } = {},
): Doc {
  if (items.length === 0) {
    return `${open}${close}`
  }
  const separator = options.spaced ? line : softline
  return group(
    [open, indent([separator, join([',', line], items), ifBreak(',')]), separator, close],
    options.break ? { break: true } : {},
  )
}

/** Output of {@link render}. */
export interface Rendered {
  readonly text: string
  /** Output ranges of the {@link marked} docs, by id. */
  readonly marks: ReadonlyMap<string, { readonly start: number; readonly end: number }>
}

type Mode = 'flat' | 'break'

interface Command {
  readonly indent: number
  readonly mode: Mode
  readonly doc: Doc
}

/** Renders a document with a maximum line width. */
export function render(doc: Doc, width = 120): Rendered {
  const hard = new Map<Doc, boolean>()
  const out = new Output()
  let column = 0
  const starts = new Map<string, number>()
  const marks = new Map<string, { start: number; end: number }>()
  const stack: Command[] = [{ indent: 0, mode: 'break', doc }]
  while (stack.length > 0) {
    const { indent: level, mode, doc: current } = stack.pop() as Command
    if (typeof current === 'string') {
      out.write(current)
      const newline = current.lastIndexOf('\n')
      column = newline === -1 ? column + current.length : current.length - newline - 1
      continue
    }
    if (isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push({ indent: level, mode, doc: current[index] as Doc })
      }
      continue
    }
    switch (current.kind) {
      case 'indent':
        stack.push({ indent: level + 2, mode, doc: current.contents })
        break
      case 'group': {
        let groupMode: Mode = 'flat'
        if (mode === 'break' && (current.break || containsHardBreak(current.contents, hard))) {
          groupMode = 'break'
        } else if (mode === 'break') {
          const next: Command = { indent: level, mode: 'flat', doc: current.contents }
          groupMode = fits(next, stack, width - column, hard) ? 'flat' : 'break'
        }
        stack.push({ indent: level, mode: groupMode, doc: current.contents })
        break
      }
      case 'line':
        if (mode === 'flat' && !current.hard) {
          if (!current.soft) {
            out.write(' ')
            column++
          }
        } else {
          out.newline(level)
          column = level
        }
        break
      case 'ifBreak':
        stack.push({ indent: level, mode, doc: mode === 'break' ? current.broken : current.flat })
        break
      case 'lazy': {
        const text = current.text()
        out.write(text)
        column += text.length
        break
      }
      case 'mark':
        if (current.edge === 'start') {
          starts.set(current.id, out.length)
        } else {
          marks.set(current.id, { start: starts.get(current.id) ?? out.length, end: out.length })
        }
        break
    }
  }
  return { text: out.text(), marks }
}

/**
 * Output buffer: chunks (no quadratic string flattening) with the trailing spaces of a line removed
 * when the line breaks.
 */
class Output {
  readonly #chunks: string[] = []
  #length = 0

  get length(): number {
    return this.#length
  }

  write(text: string): void {
    if (text !== '') {
      this.#chunks.push(text)
      this.#length += text.length
    }
  }

  /** Ends the line (trailing spaces trimmed) and indents the next one. */
  newline(indentation: number): void {
    const chunks = this.#chunks
    while (chunks.length > 0) {
      const last = chunks[chunks.length - 1] as string
      const trimmed = trimTrailingSpaces(last)
      this.#length -= last.length - trimmed.length
      if (trimmed !== '') {
        chunks[chunks.length - 1] = trimmed
        break
      }
      chunks.pop()
    }
    this.write(`\n${' '.repeat(indentation)}`)
  }

  text(): string {
    return this.#chunks.join('')
  }
}

function isArray(doc: Doc): doc is readonly Doc[] {
  return Array.isArray(doc)
}

function trimTrailingSpaces(text: string): string {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 32) {
    end--
  }
  return end === text.length ? text : text.slice(0, end)
}

/** `true` when the document contains a hard line (or a multi-line string): its group must break. */
function containsHardBreak(doc: Doc, cache: Map<Doc, boolean>): boolean {
  if (typeof doc === 'string') {
    return doc.includes('\n')
  }
  const cached = cache.get(doc)
  if (cached !== undefined) {
    return cached
  }
  let result = false
  if (isArray(doc)) {
    result = doc.some(item => containsHardBreak(item, cache))
  } else {
    switch (doc.kind) {
      case 'group':
      case 'indent':
        result = containsHardBreak(doc.contents, cache)
        break
      case 'line':
        result = doc.hard
        break
      case 'ifBreak':
        result = containsHardBreak(doc.flat, cache)
        break
      default:
        result = false
    }
  }
  cache.set(doc, result)
  return result
}

/**
 * Whether `next` printed flat, followed by the rest of the line (the pending commands up to their
 * first line break), fits in `remaining` columns.
 */
function fits(next: Command, rest: readonly Command[], remaining: number, cache: Map<Doc, boolean>): boolean {
  let width = remaining
  const commands: Command[] = [next]
  let restIndex = rest.length - 1
  while (width >= 0) {
    let command = commands.pop()
    if (command === undefined) {
      if (restIndex < 0) {
        return true
      }
      command = rest[restIndex] as Command
      restIndex--
    }
    const { mode, doc } = command
    if (typeof doc === 'string') {
      if (doc.includes('\n')) {
        return false
      }
      width -= doc.length
      continue
    }
    if (isArray(doc)) {
      for (let index = doc.length - 1; index >= 0; index--) {
        commands.push({ indent: command.indent, mode, doc: doc[index] as Doc })
      }
      continue
    }
    switch (doc.kind) {
      case 'indent':
        commands.push({ indent: command.indent, mode, doc: doc.contents })
        break
      case 'group': {
        if (doc.break && mode === 'flat') {
          return false
        }
        const groupMode: Mode = doc.break || containsHardBreak(doc.contents, cache) ? 'break' : mode
        commands.push({ indent: command.indent, mode: groupMode, doc: doc.contents })
        break
      }
      case 'line':
        if (mode === 'break' || doc.hard) {
          return true
        }
        if (!doc.soft) {
          width--
        }
        break
      case 'ifBreak':
        commands.push({ indent: command.indent, mode, doc: mode === 'break' ? doc.broken : doc.flat })
        break
      case 'lazy':
        width -= doc.text().length
        break
      case 'mark':
        break
    }
  }
  return false
}
