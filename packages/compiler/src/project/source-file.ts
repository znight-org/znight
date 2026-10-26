import type { Comment, Program } from 'oxc-parser'
import type { FileFacts } from './facts.ts'
import type { Location, Position, Span } from './location.ts'
import type { ParseError, SourceLanguage } from './parse.ts'

import { collectFileFacts } from './facts.ts'
import { contentHash } from './hash.ts'
import { LineIndex } from './location.ts'
import { languageOf, parseSource } from './parse.ts'

/**
 * A parsed file with its syntactic facts. Immutable: a new instance is created when the content
 * changes. Instances are shared between compiles as long as the content hash is unchanged, so the
 * AST nodes (and `WeakMap`s keyed by them) stay valid across incremental compiles.
 */
export class SourceFile {
  /** Absolute POSIX real path. */
  readonly path: string
  readonly text: string
  /** {@link contentHash} of {@link text}. */
  readonly hash: string
  readonly language: SourceLanguage
  /** `.d.ts`, `.d.mts`, `.d.cts`... */
  readonly isDeclarationFile: boolean
  readonly program: Program
  readonly comments: readonly Comment[]
  /** Syntax errors. When there are some, the program is empty (oxc does not recover). */
  readonly parseErrors: readonly ParseError[]
  readonly facts: FileFacts
  #lines: LineIndex | undefined

  private constructor(
    path: string,
    text: string,
    hash: string,
    language: SourceLanguage,
    program: Program,
    comments: readonly Comment[],
    errors: readonly ParseError[],
  ) {
    this.path = path
    this.text = text
    this.hash = hash
    this.language = language
    this.isDeclarationFile = language === 'dts'
    this.program = program
    this.comments = comments
    this.parseErrors = errors
    this.facts = collectFileFacts(path, program.body, language === 'dts')
  }

  /**
   * Parses `text` as the content of `path`. Returns `undefined` when the extension is not
   * parseable (`.json`, `.node`...).
   *
   * @param hash precomputed {@link contentHash} of `text`, when already known
   */
  static parse(path: string, text: string, hash?: string): SourceFile | undefined {
    const language = languageOf(path)
    if (language === undefined) {
      return undefined
    }
    const parsed = parseSource(path, text, language)
    return new SourceFile(
      path,
      text,
      hash ?? contentHash(text),
      language,
      parsed.program,
      parsed.comments,
      parsed.errors,
    )
  }

  /** 1-based line/column of a UTF-16 offset. */
  position(offset: number): Position {
    this.#lines ??= new LineIndex(this.text)
    return this.#lines.positionAt(offset)
  }

  /** Location of a node or span in this file. */
  location(span: Span): Location {
    const start = this.position(span.start)
    const end = this.position(span.end)
    return {
      file: this.path,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      start: span.start,
      end: span.end,
    }
  }

  /** Source text of a node or span. */
  textOf(span: Span): string {
    return this.text.slice(span.start, span.end)
  }
}
