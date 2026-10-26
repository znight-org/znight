import { contentHash, LineIndex, languageOf, SourceFile } from '../../src/project/index.ts'
import { describe, expect, test as it } from 'bun:test'

function parse(text: string, path = '/virtual/file.ts'): SourceFile {
  const file = SourceFile.parse(path, text)
  if (!file) {
    throw new Error('not parseable')
  }
  return file
}

describe('LineIndex', () => {
  it('maps offsets to 1-based lines and columns', () => {
    const lines = new LineIndex('ab\ncd\n')
    expect(lines.positionAt(0)).toEqual({ line: 1, column: 1 })
    expect(lines.positionAt(1)).toEqual({ line: 1, column: 2 })
    expect(lines.positionAt(2)).toEqual({ line: 1, column: 3 })
    expect(lines.positionAt(3)).toEqual({ line: 2, column: 1 })
    expect(lines.positionAt(6)).toEqual({ line: 3, column: 1 })
    expect(lines.lineCount).toBe(3)
    expect(lines.lineStart(2)).toBe(3)
  })

  it('supports \\r\\n and lone \\r line terminators', () => {
    const lines = new LineIndex('a\r\nb\rc')
    expect(lines.positionAt(3)).toEqual({ line: 2, column: 1 })
    expect(lines.positionAt(5)).toEqual({ line: 3, column: 1 })
    expect(lines.lineCount).toBe(3)
  })

  it('clamps out-of-range offsets', () => {
    const lines = new LineIndex('abc')
    expect(lines.positionAt(-5)).toEqual({ line: 1, column: 1 })
    expect(lines.positionAt(99)).toEqual({ line: 1, column: 4 })
    expect(new LineIndex('').positionAt(0)).toEqual({ line: 1, column: 1 })
  })
})

describe('SourceFile', () => {
  it('oxc offsets are UTF-16 code units: slicing the text gives the node source', () => {
    const text = "// héllo 😀 wörld\nconst é = '日本'\nexport class Ünicode {}\n"
    const file = parse(text)
    const declaration = file.facts.declarations.get('Ünicode')?.[0]
    expect(declaration).toBeDefined()
    expect(file.textOf(declaration?.span ?? { start: 0, end: 0 })).toBe('Ünicode')
    // The emoji is 2 UTF-16 code units: a UTF-8 offset would point 9 bytes further.
    expect(declaration?.span.start).toBe(text.indexOf('Ünicode'))
  })

  it('computes locations with UTF-16 columns (tsc / LSP convention)', () => {
    const file = parse("const a = '😀'; export class B {}\n")
    const span = file.facts.declarations.get('B')?.[0]?.span ?? { start: 0, end: 0 }
    expect(file.location(span)).toEqual({
      file: '/virtual/file.ts',
      line: 1,
      column: 30,
      endLine: 1,
      endColumn: 31,
      start: 29,
      end: 30,
    })
  })

  it('keeps a leading BOM in offsets', () => {
    const file = parse('﻿export const a = 1')
    const span = file.facts.declarations.get('a')?.[0]?.span
    expect(span).toEqual({ start: 14, end: 15 })
    expect(file.location(span ?? { start: 0, end: 0 }).column).toBe(15)
  })

  it('stores the content hash and the language', () => {
    const file = parse('export {}', '/virtual/types.d.mts')
    expect(file.hash).toBe(contentHash('export {}'))
    expect(file.language).toBe('dts')
    expect(file.isDeclarationFile).toBe(true)
  })

  it('reports syntax errors with their offsets (the program is then empty)', () => {
    const file = parse('export class Ok {}\nconst = ;\n')
    expect(file.parseErrors).toEqual([{ message: 'Unexpected token', start: 25, end: 26, help: undefined }])
    expect(file.location(file.parseErrors[0] ?? { start: 0, end: 0 })).toMatchObject({ line: 2, column: 7 })
    // oxc 0.155 does not recover: no partial facts.
    expect(file.program.body).toEqual([])
    expect(file.facts.declarations.size).toBe(0)
  })

  it('parses decorators, JSX and CommonJS', () => {
    expect(parse('@Injectable() export class A { constructor(@Inject("x") a: string) {} }').parseErrors).toEqual([])
    expect(parse('export const x = <div>{1}</div>', '/virtual/a.tsx').parseErrors).toEqual([])
    const cjs = parse("module.exports = { a: require('a') }", '/virtual/a.cjs')
    expect(cjs.parseErrors).toEqual([])
    expect(cjs.facts.hasModuleSyntax).toBe(false)
  })

  it('returns undefined for unparseable extensions', () => {
    expect(SourceFile.parse('/virtual/data.json', '{}')).toBeUndefined()
  })
})

describe('languageOf', () => {
  it.each([
    ['a.ts', 'ts'],
    ['a.mts', 'ts'],
    ['a.cts', 'ts'],
    ['a.tsx', 'tsx'],
    ['a.d.ts', 'dts'],
    ['a.d.mts', 'dts'],
    ['a.d.cts', 'dts'],
    ['styles.d.css.ts', 'dts'],
    ['a.js', 'js'],
    ['a.mjs', 'js'],
    ['a.cjs', 'js'],
    ['a.jsx', 'jsx'],
    ['a.json', undefined],
    ['README', undefined],
  ])('%s → %s', (file, language) => {
    expect(languageOf(`/x/${file}`)).toBe(language as never)
  })
})

describe('contentHash', () => {
  it('is a stable SHA-1 of the UTF-8 text', () => {
    expect(contentHash('héllo')).toBe('35b5ea45c5e41f78b46a937cc74d41dfea920890')
    expect(contentHash('a')).not.toBe(contentHash('b'))
  })
})
