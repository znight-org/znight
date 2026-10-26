/**
 * Decorator stripping (§6.3): the ranges recorded by the analysis (`result.decorators`), applied
 * only to the same content (hash), removed with a high-resolution source map (Vite) or blanked in
 * place (Bun), with `;` left for the first decorator of a class member (ASI safety).
 */
import type { DecoratorRanges } from '../src/decorator-ranges.ts'

import fs from 'node:fs'
import { SourceMap } from 'node:module'
import { parseSync } from 'oxc-parser'

import { compile } from '../src/compiler.ts'
import { contentHash } from '../src/project/hash.ts'
import { applicableRanges, blankDecorators, stripDecorators } from '../src/strip.ts'
import { tempApp } from './analysis/helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const SOURCE = `import { Factory, Inject, Injectable, Optional, Provides } from '@znight/core'

const Custom = () => (..._args: unknown[]) => {}

@Injectable()
export class Service {
  readonly items = ['a']
  @Custom() kept(): void {}
  constructor(@Inject('name') readonly name: string, @Optional() readonly other?: Service) {}
}

@Factory()
export class Settings {
  readonly base = 'x'
  @Provides({ name: 'name' })
  ['computed'](): string {
    return this.base
  }
  @Provides({ name: 'twice' }) @Custom()
  *generator(): Generator<string> {
    yield this.base
  }
  @Custom() @Provides({ name: 'inner' })
  inner(): string {
    return 'inner'
  }
}
`

async function analysed(source: string = SOURCE): Promise<{ readonly code: string; readonly entry: DecoratorRanges }> {
  const app = tempApp({ 'src/a.ts': source })
  try {
    const result = await compile({ root: app.root })
    const entry = result.decorators.get(`${app.root}/src/a.ts`)
    if (entry === undefined) {
      throw new Error('no decorator ranges')
    }
    return { code: fs.readFileSync(`${app.root}/src/a.ts`, 'utf8'), entry }
  } finally {
    app.cleanup()
  }
}

function parses(code: string): void {
  const parsed = parseSync('a.ts', code, { lang: 'ts', sourceType: 'module' })
  expect(parsed.errors.map(error => error.message)).toEqual([])
}

describe('decorator ranges', () => {
  it('records the Znight decorators only, and the members they begin', async () => {
    const { code, entry } = await analysed()
    expect(entry.ranges.map(range => code.slice(range.start, range.end))).toEqual([
      '@Injectable()',
      "@Inject('name')",
      '@Optional()',
      '@Factory()',
      "@Provides({ name: 'name' })",
      "@Provides({ name: 'twice' })",
      "@Provides({ name: 'inner' })",
    ])
    // `@Custom() @Provides(...)` does not begin with a Znight decorator: no `;` there
    expect(entry.memberStarts.map(start => code.slice(start, code.indexOf(')', start) + 1))).toEqual([
      "@Provides({ name: 'name' })",
      "@Provides({ name: 'twice' })",
    ])
    expect(entry.hash).toBe(contentHash(code))
  })
})

describe('stripDecorators()', () => {
  it('removes exactly the ranges and keeps the code valid (no ASI hazard)', async () => {
    const { code, entry } = await analysed()
    const stripped = stripDecorators(code, entry, '/app/src/a.ts')
    expect(stripped.code).not.toContain('@Injectable')
    expect(stripped.code).not.toContain('@Inject(')
    expect(stripped.code).not.toContain('@Provides')
    expect(stripped.code).toContain('@Custom() kept(): void {}')
    expect(stripped.code).toContain("readonly base = 'x'\n  ;\n  ['computed']()")
    expect(stripped.code).toContain('; @Custom()\n  *generator()')
    expect(stripped.code).toContain('@Custom() \n  inner()')
    expect(stripped.code).toContain('constructor( readonly name: string,  readonly other?: Service)')
    parses(stripped.code)
  })

  it('produces a high-resolution source map pointing to the original positions', async () => {
    const { code, entry } = await analysed()
    const stripped = stripDecorators(code, entry, '/app/src/a.ts')
    const map = new SourceMap(JSON.parse(stripped.map.toString()))
    const lines = stripped.code.split('\n')
    const originalLines = code.split('\n')
    for (const needle of ['export class Service', 'readonly name: string', "return 'inner'", '*generator()']) {
      const line = lines.findIndex(text => text.includes(needle))
      const column = (lines[line] ?? '').indexOf(needle)
      const entryAt = map.findEntry(line, column) as { originalLine?: number; originalColumn?: number }
      const originalLine = originalLines.findIndex(text => text.includes(needle))
      expect([entryAt.originalLine, entryAt.originalColumn]).toEqual([
        originalLine,
        (originalLines[originalLine] ?? '').indexOf(needle),
      ])
    }
    expect(stripped.map.sources).toEqual(['/app/src/a.ts'])
    expect(stripped.map.sourcesContent).toEqual([code])
  })
})

describe('blankDecorators()', () => {
  it('replaces the ranges with spaces: same length, same lines, valid code', async () => {
    const { code, entry } = await analysed()
    const blanked = blankDecorators(code, entry)
    expect(blanked.length).toBe(code.length)
    expect(blanked.split('\n').length).toBe(code.split('\n').length)
    expect(blanked).not.toContain('@Injectable')
    expect(blanked).not.toContain('@Provides')
    expect(blanked).toContain('@Custom() kept(): void {}')
    for (const { start, end } of entry.ranges) {
      const replaced = blanked.slice(start, end)
      expect(replaced).toMatch(entry.memberStarts.includes(start) ? /^; *$/ : /^ +$/)
    }
    parses(blanked)
  })

  it('keeps line breaks inside multi-line decorators', () => {
    const code = "@Injectable({\n  name: 'x',\r\n})\nclass A {}\n"
    const end = code.indexOf('\nclass')
    const entry: DecoratorRanges = { hash: contentHash(code), ranges: [{ start: 0, end }], memberStarts: [] }
    expect(blankDecorators(code, entry)).toBe(`${' '.repeat(13)}\n${' '.repeat(12)}\r\n  \nclass A {}\n`)
  })
})

describe('applicableRanges()', () => {
  it('applies only to the analysed content', async () => {
    const { code, entry } = await analysed()
    expect(applicableRanges(code, entry)).toBe(entry)
    expect(applicableRanges(`${code}\n`, entry)).toBeUndefined()
    expect(applicableRanges(code, undefined)).toBeUndefined()
    expect(applicableRanges(code, { ...entry, ranges: [] })).toBeUndefined()
  })
})
