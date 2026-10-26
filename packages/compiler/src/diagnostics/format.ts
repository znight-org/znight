/**
 * `formatDiagnostics()` (§6.2): rustc-style rendering of compiler diagnostics with code frames.
 *
 * ```
 * ✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService
 *   --> src/notification/notification.service.ts:12:29
 *    |
 * 12 |     private readonly email: EmailService,
 *    |                             ^^^^^^^^^^^^
 *    = hint: Add @Injectable() to EmailService (src/email/email.service.ts:3)
 *
 * Build failed with 1 error
 * ```
 */
import type { Diagnostic } from '../project/index.ts'

import fs from 'node:fs'
import pc from 'picocolors'

import { relativePath, resolvePath } from '../project/index.ts'

/** Color functions (picocolors). */
type Colors = ReturnType<typeof pc.createColors>

/** Options of {@link formatDiagnostics}. */
export interface FormatDiagnosticsOptions {
  /**
   * ANSI colors. Default: when the output supports them (picocolors detection). Always disabled
   * when the `NO_COLOR` environment variable is set.
   */
  readonly color?: boolean
  /** Paths are printed relative to this directory. Default `process.cwd()`. */
  readonly cwd?: string
  /** Source text of a file, for code frames. Default: read from disk (`undefined` → no frame). */
  readonly readFile?: (file: string) => string | undefined
  /** Append the summary line (`Build failed with 2 errors`). Default `true`. */
  readonly summary?: boolean
}

/** A location as found in diagnostics (end and offsets are optional for foreign diagnostics). */
interface FrameLocation {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly endLine?: number
  readonly endColumn?: number
}

const TAB = '    '
const MAX_FRAME_LINES = 4

/** Renders diagnostics with code frames and a summary line. Returns `''` for no diagnostics. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[], options: FormatDiagnosticsOptions = {}): string {
  if (diagnostics.length === 0) {
    return ''
  }
  const colors = pc.createColors(colorEnabled(options.color))
  const cwd = resolvePath(options.cwd ?? process.cwd())
  const sources = new Map<string, readonly string[] | undefined>()
  const read = options.readFile ?? readFromDisk
  const linesOf = (file: string): readonly string[] | undefined => {
    if (!sources.has(file)) {
      const text = read(file)
      sources.set(file, text === undefined ? undefined : text.split(/\r\n|\r|\n/))
    }
    return sources.get(file)
  }
  const blocks = diagnostics.map(diagnostic => formatOne(diagnostic, colors, cwd, linesOf))
  if (options.summary !== false) {
    blocks.push(summaryLine(diagnostics, colors))
  }
  return blocks.join('\n\n')
}

/** `Build failed with 2 errors and 1 warning` / `Build succeeded with 1 warning`. */
function summaryLine(diagnostics: readonly Diagnostic[], colors: Colors): string {
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
  const warnings = diagnostics.length - errors
  const count = (value: number, noun: string): string => `${value} ${noun}${value === 1 ? '' : 's'}`
  if (errors > 0) {
    const text = `Build failed with ${count(errors, 'error')}${warnings > 0 ? ` and ${count(warnings, 'warning')}` : ''}`
    return colors.bold(colors.red(text))
  }
  return colors.bold(colors.yellow(`Build succeeded with ${count(warnings, 'warning')}`))
}

function colorEnabled(option: boolean | undefined): boolean {
  const noColor = process.env.NO_COLOR
  if (noColor !== undefined && noColor !== '') {
    return false
  }
  return option ?? pc.isColorSupported
}

function readFromDisk(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function formatOne(
  diagnostic: Diagnostic,
  colors: Colors,
  cwd: string,
  linesOf: (file: string) => readonly string[] | undefined,
): string {
  const error = diagnostic.severity === 'error'
  const accent = error ? colors.red : colors.yellow
  const icon = error ? '✗' : '⚠'
  const out: string[] = [
    `${accent(colors.bold(`${icon} ${diagnostic.code}`))}${colors.bold(`: ${diagnostic.message}`)}`,
  ]

  const location = diagnostic.location as FrameLocation | undefined
  const related = (diagnostic.related ?? []).map(entry => ({
    message: entry.message,
    location: entry.location as FrameLocation,
  }))
  const lineNumbers = [location, ...related.map(entry => entry.location)]
    .filter((entry): entry is FrameLocation => entry !== undefined)
    .map(entry => Math.max(entry.line, entry.endLine ?? entry.line))
  const width = Math.max(1, ...lineNumbers.map(value => String(value).length))
  const pad = ' '.repeat(width)
  const bar = colors.blue(colors.bold('|'))

  if (location) {
    out.push(`${pad}${colors.blue(colors.bold('-->'))} ${display(cwd, location)}`)
    const frame = codeFrame(location, linesOf(location.file), width, '^', accent, colors, undefined)
    out.push(...frame)
  }
  for (const entry of related) {
    const lines = linesOf(entry.location.file)
    if (lines === undefined) {
      out.push(`${pad} ${colors.bold('= note:')} ${entry.message} (${display(cwd, entry.location)})`)
      continue
    }
    out.push(`${pad} ${bar}`)
    out.push(`${pad}${colors.blue(colors.bold(':::'))} ${display(cwd, entry.location)}`)
    out.push(...codeFrame(entry.location, lines, width, '-', colors.blue, colors, entry.message))
  }
  for (const hint of diagnostic.hints ?? []) {
    out.push(`${pad} ${colors.cyan(colors.bold('= hint:'))} ${hint}`)
  }
  return out.join('\n')
}

/** `src/a.ts:12:5`, relative to `cwd`. */
function display(cwd: string, location: FrameLocation): string {
  const file =
    location.file.startsWith('/') || /^[A-Za-z]:\//.test(location.file)
      ? relativePath(cwd, location.file)
      : location.file
  return `${file}:${location.line}:${location.column}`
}

/** Code frame lines (`   |`, `12 | code`, `   |   ^^^^`). */
function codeFrame(
  location: FrameLocation,
  lines: readonly string[] | undefined,
  width: number,
  marker: string,
  accent: (text: string) => string,
  colors: Colors,
  label: string | undefined,
): string[] {
  if (lines === undefined || location.line < 1 || location.line > lines.length) {
    return label === undefined ? [] : [`${' '.repeat(width)} ${colors.bold('= note:')} ${label}`]
  }
  const bar = colors.blue(colors.bold('|'))
  const pad = ' '.repeat(width)
  const first = location.line
  const last = Math.min(Math.max(location.endLine ?? first, first), lines.length)
  let shown: (number | undefined)[] = []
  for (let line = first; line <= last; line++) {
    shown.push(line)
  }
  if (shown.length > MAX_FRAME_LINES) {
    shown = [first, first + 1, undefined, last]
  }
  const out = [`${pad} ${bar}`]
  shown.forEach((line, index) => {
    if (line === undefined) {
      out.push(`${colors.blue(colors.bold('...'))}`)
      return
    }
    const raw = lines[line - 1] ?? ''
    const text = expandTabs(raw).trimEnd()
    out.push(`${colors.blue(colors.bold(String(line).padStart(width)))} ${bar}${text === '' ? '' : ` ${text}`}`)
    const startColumn = line === first ? location.column : firstNonSpace(raw)
    const endColumn =
      line === last && location.endColumn !== undefined && (location.endLine ?? first) === line
        ? location.endColumn
        : raw.length + 1
    const start = displayWidth(raw.slice(0, Math.max(startColumn - 1, 0)))
    const length = Math.max(1, displayWidth(raw.slice(Math.max(startColumn - 1, 0), Math.max(endColumn - 1, 0))))
    const isLast = index === shown.length - 1
    const suffix = isLast && label !== undefined ? ` ${label}` : ''
    out.push(`${pad} ${bar} ${' '.repeat(start)}${accent(colors.bold(marker.repeat(length) + suffix))}`)
  })
  return out
}

function expandTabs(text: string): string {
  return text.replaceAll('\t', TAB)
}

function displayWidth(text: string): number {
  return expandTabs(text).length
}

function firstNonSpace(text: string): number {
  const match = /\S/.exec(text)
  return match ? match.index + 1 : 1
}
