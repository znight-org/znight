import type { ConfigLoader, ConfigLoaderContext } from './types.ts'

import { ConfigLoaderError, invalidConfig } from '../errors.ts'
import { nestUnder } from '../source.ts'
import { importOptionalPeer, isRecord, readOptionalFile, resolveFile } from './shared.ts'

/** Options of {@link json} and {@link yaml}. */
export interface FileLoaderOptions {
  /** Skip the file when it does not exist. Default: `false` (a missing file is an error). */
  readonly optional?: boolean
  /**
   * Key path under which the file content is mounted: with `key: 'database'`, `{ "host": "x" }` is
   * read as `database.host`. Default: the root (the file must contain an object).
   */
  readonly key?: string
}

/**
 * Where and why a file does not parse. Parser messages quote the file content, which may hold
 * secrets: a problem only carries an offset and a reason that never contains file content.
 */
interface SyntaxProblem {
  /** Offset of the problem in the text, when known. */
  readonly offset?: number
  /** What is wrong, without any file content. */
  readonly reason?: string
}

type ParseResult =
  | { readonly ok: true; readonly content: unknown }
  | { readonly ok: false; readonly problem: SyntaxProblem }

type Parse = (text: string, path: string) => ParseResult | Promise<ParseResult>

/** `line L, column C` (both 1-based) of `offset` in `text`. */
function linePosition(text: string, offset: number): string {
  let line = 1
  let lineStart = 0
  for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) {
    line++
    lineStart = index + 1
  }
  return `line ${line}, column ${offset - lineStart + 1}`
}

/** `at line L, column C: reason` for a {@link SyntaxProblem}, without any file content. */
function describeProblem(text: string, problem: SyntaxProblem): string {
  const where = problem.offset === undefined ? '' : ` at ${linePosition(text, problem.offset)}`
  return problem.reason === undefined ? where : `${where}: ${problem.reason}`
}

function fileLoader(
  name: string,
  format: string,
  path: string,
  options: FileLoaderOptions,
  parse: Parse,
): ConfigLoader {
  if (typeof path !== 'string' || path === '') {
    throw invalidConfig(`${name}(): the file path must be a non-empty string`)
  }
  return {
    name,
    async load(context: ConfigLoaderContext) {
      const file = resolveFile(context, path)
      const text = await readOptionalFile(name, file, path)
      if (text === undefined) {
        if (options.optional === true) return undefined
        throw new ConfigLoaderError(name, `file not found: ${file}`, {
          hints: [`Create the file or pass { optional: true } to ${name}()`],
        })
      }
      const result = await parse(text, path)
      if (!result.ok) {
        // no `cause`: the parser error quotes the file content and is printed with the error
        throw new ConfigLoaderError(name, `invalid ${format} in ${path}${describeProblem(text, result.problem)}`, {
          hints: [`Fix the ${format} syntax of ${path} (the parser message is not shown: it quotes the file content)`],
        })
      }
      const content = result.content
      if (content === undefined || content === null) return { origin: path, values: {} }
      if (options.key === undefined && !isRecord(content)) {
        throw new ConfigLoaderError(name, `${path} must contain an object at the root (or pass { key } to mount it)`)
      }
      return { origin: path, values: nestUnder(content, options.key) }
    },
  }
}

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const JSON_ESCAPES = '"\\/bfnrt'
const HEX4 = /^[\da-fA-F]{4}$/

/**
 * Locates the first syntax error of a JSON text that `JSON.parse` rejected. Runtimes word (and
 * locate) `JSON.parse` errors differently and quote the input: this gives a stable description
 * that never contains the input. `{}` when no problem is found (e.g. a nesting limit was hit).
 */
function jsonSyntaxProblem(text: string): SyntaxProblem {
  let at = 0
  const containers: ('{' | '[')[] = []
  const end = (): SyntaxProblem => ({ offset: text.length, reason: 'unexpected end of input' })
  const skipWhitespace = (): void => {
    while (at < text.length && ' \t\n\r'.includes(text.charAt(at))) at++
  }
  const string = (): SyntaxProblem | undefined => {
    const start = at++
    while (at < text.length) {
      const code = text.charCodeAt(at)
      if (code === 0x22) {
        at++
        return undefined
      }
      if (code < 0x20) return { offset: at, reason: 'control character in a string' }
      if (code === 0x5c) {
        const escaped = text.charAt(at + 1)
        if (escaped === 'u' && HEX4.test(text.slice(at + 2, at + 6))) at += 6
        else if (escaped !== '' && escaped !== 'u' && JSON_ESCAPES.includes(escaped)) at += 2
        else return { offset: at, reason: 'invalid escape sequence' }
      } else {
        at++
      }
    }
    return { offset: start, reason: 'unterminated string' }
  }
  const propertyName = (): SyntaxProblem | undefined => {
    skipWhitespace()
    if (at >= text.length) return end()
    if (text.charAt(at) !== '"') return { offset: at, reason: 'expected a double-quoted property name' }
    const problem = string()
    if (problem !== undefined) return problem
    skipWhitespace()
    if (at >= text.length) return end()
    if (text.charAt(at) !== ':') return { offset: at, reason: "expected ':' after a property name" }
    at++
    return undefined
  }
  const scalar = (): SyntaxProblem | undefined => {
    const char = text.charAt(at)
    if (char === '"') return string()
    if (char === '-' || (char >= '0' && char <= '9')) {
      JSON_NUMBER.lastIndex = at
      if (!JSON_NUMBER.test(text)) return { offset: at, reason: 'invalid number' }
      at = JSON_NUMBER.lastIndex
      return undefined
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, at)) {
        at += literal.length
        return undefined
      }
    }
    return { offset: at, reason: 'unexpected character' }
  }

  for (;;) {
    // a value
    skipWhitespace()
    if (at >= text.length) return end()
    const char = text.charAt(at)
    if (char === '{' || char === '[') {
      at++
      skipWhitespace()
      if (text.charAt(at) === (char === '{' ? '}' : ']')) {
        at++
      } else {
        containers.push(char)
        const problem = char === '{' ? propertyName() : undefined
        if (problem !== undefined) return problem
        continue
      }
    } else {
      const problem = scalar()
      if (problem !== undefined) return problem
    }
    // what follows a value: closing brackets, then a separator or the end of the text
    for (;;) {
      skipWhitespace()
      const container = containers.at(-1)
      if (container === undefined) {
        return at < text.length ? { offset: at, reason: 'unexpected content after the JSON value' } : {}
      }
      if (at >= text.length) return end()
      const closing = container === '{' ? '}' : ']'
      const next = text.charAt(at)
      if (next === closing) {
        at++
        containers.pop()
        continue
      }
      if (next !== ',') return { offset: at, reason: `expected ',' or '${closing}'` }
      at++
      if (container === '{') {
        const problem = propertyName()
        if (problem !== undefined) return problem
      }
      break
    }
  }
}

function parseJson(text: string): ParseResult {
  try {
    return { ok: true, content: JSON.parse(text) as unknown }
  } catch {
    // never the JSON.parse message: it quotes the input
    return { ok: false, problem: jsonSyntaxProblem(text) }
  }
}

/**
 * Loads a JSON file. Nested objects are read with key paths (`{ "database": { "host": "x" } }` →
 * `database.host`) and top-level names can match environment names (`{ "DB_HOST": "x" }`).
 *
 * Syntax errors report the line and column, never the parser message (it quotes the file content,
 * which may hold secrets).
 *
 * ```ts
 * ConfigPlugin.configure({ loaders: [json('config/app.json'), dotenv(), env()] })
 * ```
 */
export function json(path: string, options: FileLoaderOptions = {}): ConfigLoader {
  return fileLoader('json', 'JSON', path, options, parseJson)
}

/** An error or a warning of the `yaml` package (`YAMLParseError`, `YAMLWarning`). */
interface YamlIssue {
  readonly code?: unknown
  readonly pos?: unknown
}

interface YamlDocument {
  readonly errors: readonly YamlIssue[]
  readonly warnings: readonly YamlIssue[]
  toJS(): unknown
}

interface YamlModule {
  parseDocument(text: string, options: { readonly prettyErrors: boolean }): YamlDocument | null
}

/** Position and code of a `yaml` issue: its message quotes the file content, never use it. */
function yamlProblem(issue: YamlIssue): SyntaxProblem {
  const offset = Array.isArray(issue.pos) && typeof issue.pos[0] === 'number' ? issue.pos[0] : undefined
  const reason = typeof issue.code === 'string' && /^[A-Z][A-Z\d_]*$/.test(issue.code) ? issue.code : undefined
  return { ...(offset === undefined ? {} : { offset }), ...(reason === undefined ? {} : { reason }) }
}

/**
 * Loads a YAML file, like {@link json}. Requires the optional peer dependency `yaml` (`bun add yaml`),
 * imported only when the loader runs.
 *
 * Syntax errors report the line, column and `yaml` error code, never the parser message (it quotes
 * the file content). YAML warnings are emitted the same way (`process.emitWarning`, type `YAMLWarning`).
 */
export function yaml(path: string, options: FileLoaderOptions = {}): ConfigLoader {
  return fileLoader('yaml', 'YAML', path, options, async (text, label) => {
    const module = await importOptionalPeer<YamlModule>('yaml', 'yaml')
    let document: YamlDocument | null
    try {
      // prettyErrors: false, no code frame (a copy of the offending line) in the issues
      document = module.parseDocument(text, { prettyErrors: false })
    } catch {
      return { ok: false, problem: {} }
    }
    if (document === null) return { ok: true, content: null }
    for (const warning of document.warnings) {
      process.emitWarning(`${label}${describeProblem(text, yamlProblem(warning))}`, { type: 'YAMLWarning' })
    }
    const error = document.errors[0]
    if (error !== undefined) return { ok: false, problem: yamlProblem(error) }
    try {
      return { ok: true, content: document.toJS() }
    } catch {
      return { ok: false, problem: {} }
    }
  })
}
