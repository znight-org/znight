import type { Comment, Program } from 'oxc-parser'
import type { Span } from './location.ts'

import { parseSync } from 'oxc-parser'

import { isDeclarationPath } from './paths.ts'

/** Language a file is parsed as, derived from its extension. */
export type SourceLanguage = 'ts' | 'tsx' | 'dts' | 'js' | 'jsx'

/**
 * A syntax error reported by oxc. oxc 0.155 does not recover from syntax errors: the program of a
 * file with errors is empty (no declarations), so errors must be reported before analysis results.
 */
export interface ParseError {
  readonly message: string
  readonly start: number
  readonly end: number
  readonly help: string | undefined
}

/** Raw output of {@link parseSource}. */
export interface ParsedSource {
  readonly language: SourceLanguage
  readonly program: Program
  readonly comments: readonly Comment[]
  readonly errors: readonly ParseError[]
}

/** Language of a path, or `undefined` when the extension is not parseable. */
export function languageOf(file: string): SourceLanguage | undefined {
  if (isDeclarationPath(file)) {
    return 'dts'
  }
  const dot = file.lastIndexOf('.')
  switch (dot === -1 ? '' : file.slice(dot)) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts'
    case '.tsx':
      return 'tsx'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js'
    case '.jsx':
      return 'jsx'
    default:
      return undefined
  }
}

/**
 * Parses a file with oxc. TypeScript files are parsed as ES modules; `.cjs`/`.cts` as CommonJS and
 * other JavaScript files as "unambiguous" (CommonJS packages are common in `node_modules`).
 * Parenthesized expressions/types are not preserved: `(a)` is represented by `a`.
 */
export function parseSource(file: string, text: string, language: SourceLanguage): ParsedSource {
  const extension = file.slice(file.lastIndexOf('.'))
  let sourceType: 'module' | 'commonjs' | 'unambiguous' = 'module'
  if (extension === '.cjs' || extension === '.cts') {
    sourceType = 'commonjs'
  } else if (language === 'js' || language === 'jsx') {
    sourceType = 'unambiguous'
  }
  const result = parseSync(file, text, { lang: language, sourceType, astType: 'ts', preserveParens: false })
  const errors: ParseError[] = result.errors
    .filter(error => error.severity === 'Error')
    .map(error => {
      const label = error.labels[0]
      return {
        message: error.message,
        start: label?.start ?? 0,
        end: label?.end ?? 0,
        help: error.helpMessage ?? undefined,
      }
    })
  return { language, program: result.program, comments: result.comments, errors }
}

/** Span helper for nodes that are known to exist. */
export function spanOf(node: Span): Span {
  return { start: node.start, end: node.end }
}
