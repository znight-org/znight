/**
 * formatDiagnostics(): rustc-style code frames, hints, related locations, summary line, colors.
 */
import type { Diagnostic, Location } from '../../src/project/index.ts'

import { formatDiagnostics } from '../../src/diagnostics/format.ts'
import { LineIndex } from '../../src/project/index.ts'
import { afterEach, describe, expect, test as it } from 'bun:test'

const FILE = '/repo/src/notification/notification.service.ts'
const SOURCE = [
  "import { Injectable } from '@znight/core'",
  '',
  '@Injectable()',
  'export class NotificationService {',
  '  constructor(',
  '    private readonly email: EmailService,',
  '\tprivate readonly sms: SmsService,',
  '  ) {}',
  '}',
  '',
  '// line 11',
].join('\n')
const FILES: Record<string, string> = { [FILE]: SOURCE, '/repo/src/email.ts': 'export class EmailService {}\n' }

/** Location of the `occurrence`-th match of `text` in a file. */
function locate(file: string, text: string, length = text.length): Location {
  const source = FILES[file] as string
  const start = source.indexOf(text)
  const lines = new LineIndex(source)
  const from = lines.positionAt(start)
  const to = lines.positionAt(start + length)
  return {
    file,
    line: from.line,
    column: from.column,
    endLine: to.line,
    endColumn: to.column,
    start,
    end: start + length,
  }
}

const format = (diagnostics: readonly Diagnostic[], options = {}) =>
  formatDiagnostics(diagnostics, { color: false, cwd: '/repo', readFile: file => FILES[file], ...options })

const missing: Diagnostic = {
  code: 'ZNIGHT001',
  severity: 'error',
  message: "Missing provider for 'EmailService' required by NotificationService",
  location: locate(FILE, 'EmailService'),
  hints: ['Add @Injectable() to EmailService (src/email.ts:1)'],
}

describe('formatDiagnostics', () => {
  const noColor = process.env.NO_COLOR
  afterEach(() => {
    if (noColor === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = noColor
    }
  })

  it('prints a code frame with carets under the exact range and hints', () => {
    expect(format([missing])).toBe(
      [
        "✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService",
        ' --> src/notification/notification.service.ts:6:29',
        '  |',
        '6 |     private readonly email: EmailService,',
        '  |                             ^^^^^^^^^^^^',
        '  = hint: Add @Injectable() to EmailService (src/email.ts:1)',
        '',
        'Build failed with 1 error',
      ].join('\n'),
    )
  })

  it('aligns carets after tabs, widens the gutter and shows related locations', () => {
    const diagnostic: Diagnostic = {
      code: 'ZNIGHT004',
      severity: 'error',
      message: 'Duplicate providers',
      location: locate(FILE, 'SmsService'),
      related: [
        { message: 'candidate EmailService', location: locate('/repo/src/email.ts', 'EmailService') },
        { message: 'declared here', location: locate(FILE, '// line 11') },
        { message: 'in a file that cannot be read', location: { ...locate(FILE, 'sms'), file: '/repo/gone.ts' } },
      ],
    }
    expect(format([diagnostic], { summary: false })).toBe(
      [
        '✗ ZNIGHT004: Duplicate providers',
        '  --> src/notification/notification.service.ts:7:24',
        '   |',
        ' 7 |     private readonly sms: SmsService,',
        '   |                           ^^^^^^^^^^',
        '   |',
        '  ::: src/email.ts:1:14',
        '   |',
        ' 1 | export class EmailService {}',
        '   |              ------------ candidate EmailService',
        '   |',
        '  ::: src/notification/notification.service.ts:11:1',
        '   |',
        '11 | // line 11',
        '   | ---------- declared here',
        '   = note: in a file that cannot be read (gone.ts:7:19)',
      ].join('\n'),
    )
  })

  it('underlines multi-line ranges line by line, eliding long ones', () => {
    const range = (from: string, to: string): Location => {
      const start = SOURCE.indexOf(from)
      const end = SOURCE.indexOf(to) + to.length
      const lines = new LineIndex(SOURCE)
      const first = lines.positionAt(start)
      const last = lines.positionAt(end)
      return {
        file: FILE,
        line: first.line,
        column: first.column,
        endLine: last.line,
        endColumn: last.column,
        start,
        end,
      }
    }
    const short = format(
      [{ code: 'ZNIGHT010', severity: 'error', message: 'Bad', location: range('constructor(', ') {}') }],
      {
        summary: false,
      },
    )
    expect(short).toBe(
      [
        '✗ ZNIGHT010: Bad',
        ' --> src/notification/notification.service.ts:5:3',
        '  |',
        '5 |   constructor(',
        '  |   ^^^^^^^^^^^^',
        '6 |     private readonly email: EmailService,',
        '  |     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
        '7 |     private readonly sms: SmsService,',
        '  |     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
        '8 |   ) {}',
        '  |   ^^^^',
      ].join('\n'),
    )
    const long = format(
      [{ code: 'ZNIGHT010', severity: 'error', message: 'Bad', location: range('@Injectable()', '\n}') }],
      {
        summary: false,
      },
    )
    expect(long).toBe(
      [
        '✗ ZNIGHT010: Bad',
        ' --> src/notification/notification.service.ts:3:1',
        '  |',
        '3 | @Injectable()',
        '  | ^^^^^^^^^^^^^',
        '4 | export class NotificationService {',
        '  | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
        '...',
        '9 | }',
        '  | ^',
      ].join('\n'),
    )
  })

  it('prints warnings, diagnostics without location and the summary', () => {
    const warning: Diagnostic = { code: 'ZNIGHT019', severity: 'warning', message: 'Unused is never used' }
    const extension: Diagnostic = {
      code: 'ZNIGHT018',
      severity: 'error',
      message: "Compiler extension 'http' failed",
      hints: ['Update @znight/http'],
    }
    expect(format([warning])).toBe('⚠ ZNIGHT019: Unused is never used\n\nBuild succeeded with 1 warning')
    expect(format([extension, missing, warning]).split('\n\n')).toEqual([
      "✗ ZNIGHT018: Compiler extension 'http' failed\n  = hint: Update @znight/http",
      expect.stringContaining('✗ ZNIGHT001'),
      '⚠ ZNIGHT019: Unused is never used',
      'Build failed with 2 errors and 1 warning',
    ])
    expect(format([warning, warning])).toEndWith('Build succeeded with 2 warnings')
    expect(format([])).toBe('')
  })

  it('reads files from disk by default and degrades without a frame when it cannot', () => {
    const diagnostic: Diagnostic = {
      ...missing,
      location: { ...(missing.location as Location), file: '/does/not/exist.ts' },
    }
    const text = formatDiagnostics([diagnostic], { color: false, cwd: '/does' })
    expect(text).toContain(' --> not/exist.ts:6:29')
    expect(text).not.toContain('|')
  })

  it('colors the output unless disabled or NO_COLOR is set', () => {
    delete process.env.NO_COLOR
    expect(format([missing], { color: true })).toContain('\u001b[')
    expect(format([missing], { color: false })).not.toContain('\u001b[')
    process.env.NO_COLOR = '1'
    expect(format([missing], { color: true })).not.toContain('\u001b[')
  })
})
