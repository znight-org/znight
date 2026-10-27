/**
 * JSDoc comments (`/** ... *\/`) attached to declarations, exposed to compiler extensions as
 * {@link DocComment} (`ClassInfo.doc`, `MethodInfo.doc`, `PropertyInfo.doc`, `ParameterInfo.doc`,
 * shapes).
 *
 * The comment of a node is the nearest JSDoc block comment before it, separated from it only by
 * whitespace, other comments, decorators and modifiers (`export`, `default`, `declare`, `const`...):
 * the rule of TypeScript. Parsing is purely syntactic and memoized per file content.
 */
import type { Comment } from 'oxc-parser'
import type { DocComment, DocTag } from '../extensions/api.ts'
import type { SourceFile, Span } from '../project/index.ts'

/** Modifiers that may separate a JSDoc comment from the node it documents. */
const MODIFIERS = /(?<![\w$])(?:export|default|declare|const|let|var|abstract)\s*$/

const NO_DOC = null

/** JSDoc per file and node start (`null`: none). */
const memo = new WeakMap<SourceFile, Map<number, DocComment | null>>()

/**
 * The JSDoc comment documenting the node starting at `start` (pass the start of its first
 * decorator when it has some), or `undefined`.
 */
export function docAt(file: SourceFile, start: number): DocComment | undefined {
  let byStart = memo.get(file)
  if (!byStart) {
    byStart = new Map()
    memo.set(file, byStart)
  }
  let doc = byStart.get(start)
  if (doc === undefined) {
    const comment = leadingDocComment(file, start)
    doc = comment ? parseDocComment(file, comment) : NO_DOC
    byStart.set(start, doc)
  }
  return doc ?? undefined
}

/** Start of a node including its decorators (decorators may start before the node itself). */
export function startWithDecorators(node: Span, decorators: readonly Span[] | null | undefined): number {
  let start = node.start
  for (const decorator of decorators ?? []) {
    start = Math.min(start, decorator.start)
  }
  return start
}

function leadingDocComment(file: SourceFile, start: number): Comment | undefined {
  const comments = file.comments
  if (comments.length === 0) {
    return undefined
  }
  let position = skipModifiers(file.text, start)
  // last comment ending at or before `position`
  let low = 0
  let high = comments.length - 1
  let index = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if ((comments[middle] as Comment).end <= position) {
      index = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  while (index >= 0) {
    const comment = comments[index] as Comment
    if (file.text.slice(comment.end, position).trim() !== '') {
      return undefined
    }
    if (comment.type === 'Block' && comment.value.startsWith('*') && !comment.value.startsWith('**')) {
      return comment
    }
    position = comment.start
    index--
  }
  return undefined
}

function skipModifiers(text: string, start: number): number {
  let position = start
  for (;;) {
    const before = text.slice(Math.max(0, position - 64), position)
    const match = MODIFIERS.exec(before)
    if (!match) {
      return position
    }
    position -= match[0].length
  }
}

/** One line of the comment content, with its offset in the file. */
interface Line {
  readonly text: string
  readonly start: number
}

/** Parses a JSDoc block comment (`comment.value` starts with the second `*` of `/**`). */
export function parseDocComment(file: SourceFile, comment: Comment): DocComment {
  const content = comment.value.slice(1)
  const contentStart = comment.start + 3
  const lines: Line[] = []
  let offset = 0
  for (const raw of content.split(/\r\n|\r|\n/)) {
    const prefix = lines.length === 0 ? /^\s*/.exec(raw) : /^\s*\*? ?/.exec(raw)
    const skip = prefix?.[0].length ?? 0
    lines.push({ text: raw.slice(skip).trimEnd(), start: contentStart + offset + skip })
    offset += raw.length + lineBreakLength(content, offset + raw.length)
  }
  const body: string[] = []
  const tags: { name: string; lines: Line[]; start: number }[] = []
  let fenced = false
  for (const line of lines) {
    const tag = fenced ? null : /^@([A-Za-z][\w-]*)/.exec(line.text)
    if (tag) {
      const rest = line.text.slice(tag[0].length)
      const trimmed = rest.trimStart()
      tags.push({
        name: tag[1] as string,
        lines: [{ text: trimmed, start: line.start + tag[0].length + rest.length - trimmed.length }],
        start: line.start,
      })
    } else {
      const current = tags.at(-1)
      if (current) {
        current.lines.push(line)
      } else {
        body.push(line.text)
      }
    }
    if ((line.text.match(/```/g)?.length ?? 0) % 2 === 1) {
      fenced = !fenced
    }
  }
  const text = trimBlankLines(body).join('\n')
  // summary: the first paragraph (a sentence wrapped over several lines is joined)
  const paragraph = /\n[ \t]*\n/.exec(text)
  const first = (paragraph ? text.slice(0, paragraph.index) : text).trim()
  const rest = paragraph ? text.slice(paragraph.index).trim() : ''
  const docTags: DocTag[] = tags.map(tag => {
    const kept = trimBlankLines(tag.lines.map(line => line.text))
    const last = lastContentLine(tag.lines)
    return {
      name: tag.name,
      text: kept.join('\n').trim(),
      location: file.location({ start: tag.start, end: last.start + last.text.length }),
    }
  })
  return {
    text,
    summary: first === '' ? undefined : first.replace(/\s*\n\s*/g, ' '),
    description: rest === '' ? undefined : rest,
    tags: docTags,
    location: file.location(comment),
  }
}

function lineBreakLength(text: string, index: number): number {
  if (text.charCodeAt(index) === 13 /* \r */) {
    return text.charCodeAt(index + 1) === 10 ? 2 : 1
  }
  return text.charCodeAt(index) === 10 ? 1 : 0
}

function trimBlankLines(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] as string).trim() === '') {
    start++
  }
  while (end > start && (lines[end - 1] as string).trim() === '') {
    end--
  }
  return lines.slice(start, end)
}

function lastContentLine(lines: readonly Line[]): Line {
  for (let index = lines.length - 1; index > 0; index--) {
    const line = lines[index] as Line
    if (line.text.trim() !== '') {
      return line
    }
  }
  return lines[0] as Line
}
