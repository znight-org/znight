/**
 * Unit tests of the code generation primitives: string quoting, identifiers, the pretty printer,
 * the literal emitter and the import name pool.
 */
import type { Doc } from '../../src/codegen/doc.ts'

import { parseSync } from 'oxc-parser'

import { group, hardline, indent, line, list, render, softline } from '../../src/codegen/doc.ts'
import { NamePool } from '../../src/codegen/imports.ts'
import { literalDoc, numberLiteral } from '../../src/codegen/literal.ts'
import { isBindableName, isIdentifierName, quote, toIdentifier } from '../../src/codegen/syntax.ts'
import { describe, expect, test as it } from 'bun:test'

const evaluate = (code: string): unknown => new Function(`return (${code})`)()

describe('quote', () => {
  it('produces single-quoted literals that evaluate back to the input', () => {
    const samples = [
      '',
      "it's",
      'back\\slash',
      'line\nfeed\r\n',
      'tab\tvertical\vform\fbell\b',
      'nul\0x',
      '  ',
      'emoji 😀 é',
      'lone \ud800 surrogate \udc00',
      '\x7f\x1b',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder, not a template
      '${template}',
    ]
    for (const sample of samples) {
      const quoted = quote(sample)
      expect(quoted.startsWith("'")).toBe(true)
      expect(evaluate(quoted)).toBe(sample)
      expect(quoted).not.toContain('\n')
      expect(quoted).not.toContain(' ')
    }
    expect(quote("a'b")).toBe("'a\\'b'")
    expect(quote('😀')).toBe("'😀'")
  })
})

describe('identifiers', () => {
  it('validates identifier names and bindable local names', () => {
    expect(isIdentifierName('default')).toBe(true)
    expect(isIdentifierName('Ünïcødé')).toBe(true)
    expect(isIdentifierName('a-b')).toBe(false)
    expect(isBindableName('UserService')).toBe(true)
    expect(isBindableName('default')).toBe(false)
    expect(isBindableName('Date')).toBe(false)
    expect(isBindableName('string')).toBe(false)
    expect(isBindableName('await')).toBe(false)
  })

  it('derives identifiers from arbitrary strings', () => {
    expect(toIdentifier('legacy-ns')).toBe('legacyNs')
    expect(toIdentifier('1st')).toBe('_1st')
    expect(toIdentifier('@scope/pkg')).toBe('scopePkg')
    expect(toIdentifier('')).toBe('_')
  })
})

describe('pretty printer', () => {
  const items = (count: number, size: number): Doc[] =>
    Array.from({ length: count }, (_, index) => `'${String(index).padStart(size, 'x')}'`)

  it('keeps groups flat when they fit and breaks them otherwise, with trailing commas', () => {
    expect(render(list('[', ']', items(3, 2))).text).toBe("['x0', 'x1', 'x2']")
    expect(render(list('{', '}', ['a: 1'], { spaced: true })).text).toBe('{ a: 1 }')
    expect(render(list('[', ']', [])).text).toBe('[]')
    const broken = render(list('[', ']', items(3, 50))).text
    expect(broken).toBe(`[\n  '${'x'.repeat(49)}0',\n  '${'x'.repeat(49)}1',\n  '${'x'.repeat(49)}2',\n]`)
    expect(render(list('[', ']', ['a'], { break: true })).text).toBe('[\n  a,\n]')
  })

  it('accounts for the text following a group on the same line', () => {
    const doc = ['x: ', list('[', ']', items(2, 50)), ',', 'y'.repeat(20)]
    expect(render(doc, 120).text.includes('\n')).toBe(true)
    expect(render(doc, 200).text.includes('\n')).toBe(false)
  })

  it('breaks groups containing hard lines or multi-line strings and trims trailing spaces', () => {
    expect(render(group(['a', line, 'b', hardline, 'c'])).text).toBe('a\nb\nc')
    expect(render(group(['a', indent([softline, 'b\nc'])])).text).toBe('a\n  b\nc')
    expect(render(['a ', hardline, 'b']).text).toBe('a\nb')
  })
})

describe('literal emitter', () => {
  const print = (value: unknown): string => render(literalDoc(value, () => 'REF')).text

  it('prints every supported value so that it evaluates back to an equal value', () => {
    const value = {
      undef: undefined,
      nil: null,
      yes: true,
      no: false,
      int: 42,
      negative: -1.5,
      exponent: 1e21,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      ninf: Number.NEGATIVE_INFINITY,
      zero: -0,
      big: -10n,
      text: "it's",
      date: new Date(1_700_000_000_000),
      invalidDate: new Date(Number.NaN),
      regexp: /^\/a\n(?<name>b)$/giu,
      empty: /(?:)/,
      nested: { array: [1, [2, [3]]], 'key with spaces': { deep: 'yes' } },
      // biome-ignore lint/suspicious/noSparseArray: holes are printed as undefined
      sparse: [1, , 3],
    }
    const code = print(value)
    expect(parseSync('x.ts', `const x = ${code}`).errors).toEqual([])
    const back = evaluate(code) as typeof value
    // Bun compares the raw pattern of `new RegExp('')` ('') with the literal's ('(?:)'): compare `source`.
    const { invalidDate: _invalid, empty: emptyBack, ...comparable } = back
    const { invalidDate: _expected, empty, ...expected } = value
    expect(comparable).toEqual({ ...expected, sparse: [1, undefined, 3] })
    expect(emptyBack.source).toBe(empty.source)
    expect(Object.is(back.zero, -0)).toBe(true)
    expect(back.regexp.source).toBe(value.regexp.source)
    expect(back.regexp.flags).toBe(value.regexp.flags)
    expect(Number.isNaN(back.invalidDate.getTime())).toBe(true)
    expect(code).toContain("['key with spaces']: ")
    expect(numberLiteral(-0)).toBe('-0')
  })

  it('emits own __proto__ keys as computed keys (never prototype mutations)', () => {
    const value = JSON.parse('{"__proto__": {"polluted": true}}') as object
    const back = evaluate(print(value)) as object
    expect(Object.keys(back)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype)
  })

  it('rejects functions, symbols, cycles and non-plain objects', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => print(() => 1)).toThrow('functions cannot be emitted')
    expect(() => print(Symbol('x'))).toThrow('symbols cannot be emitted')
    expect(() => print(cyclic)).toThrow('cyclic')
    expect(() => print(new Map())).toThrow('an instance of Map')
    expect(() => print({ [Symbol('k')]: 1 })).toThrow('symbol keys')
    expect(print([cyclic.self === cyclic ? 1 : 0, [1], [1]])).toBe('[1, [1], [1]]')
  })
})

describe('name pool', () => {
  it('assigns names by identity order, avoiding reserved names, globals and collisions', () => {
    const pool = new NamePool()
    pool.reserve('d')
    const b = pool.import({
      specifier: './b.js',
      exportName: 'UserService',
      typeOnly: false,
      sortKey: 'src/b.ts#UserService',
      hint: 'UserService',
    })
    const a = pool.import({
      specifier: './a.js',
      exportName: 'UserService',
      typeOnly: false,
      sortKey: 'src/a.ts#UserService',
      hint: 'UserService',
    })
    const date = pool.import({
      specifier: './g.js',
      exportName: 'Date',
      typeOnly: false,
      sortKey: 'src/g.ts#Date',
      hint: 'Date',
    })
    const short = pool.import({
      specifier: './s.js',
      exportName: 'd',
      typeOnly: true,
      sortKey: 'src/s.ts#d',
      hint: 'd',
    })
    const fallback = pool.import({
      specifier: 'legacy-ns',
      exportName: 'default',
      typeOnly: false,
      sortKey: 'legacy-ns#default',
      hint: 'legacyNs',
    })
    const weird = pool.import({
      specifier: './w.js',
      exportName: 'a-b',
      typeOnly: false,
      sortKey: 'src/w.ts#a-b',
      hint: 'a-b',
    })
    const constant = pool.constant('UserService', 'root')
    pool.finalize()
    const text = (doc: Doc) => render(doc).text
    expect([a, b, date, short, fallback, weird, constant].map(text)).toEqual([
      'UserService',
      'UserService$1',
      'Date$1',
      'd$1',
      'legacyNs',
      'aB',
      'UserService$2',
    ])
    expect(pool.statements()).toEqual([
      "import legacyNs from 'legacy-ns'",
      "import { UserService } from './a.js'",
      "import { UserService as UserService$1 } from './b.js'",
      "import { Date as Date$1 } from './g.js'",
      "import type { d as d$1 } from './s.js'",
      "import { 'a-b' as aB } from './w.js'",
    ])
  })

  it('merges type and value imports of the same binding into a value import', () => {
    const pool = new NamePool()
    pool.import({ specifier: '@x/y', exportName: 'Thing', typeOnly: true, sortKey: '@x/y#Thing', hint: 'Thing' })
    pool.import({ specifier: '@x/y', exportName: 'Thing', typeOnly: false, sortKey: '@x/y#Thing', hint: 'Thing' })
    pool.import({ specifier: '@x/y', exportName: 'Type', typeOnly: true, sortKey: '@x/y#Type', hint: 'Type' })
    pool.import({
      specifier: '@znight/core',
      exportName: 'ZnightMetadata',
      typeOnly: true,
      sortKey: '@znight/core#ZnightMetadata',
      hint: 'ZnightMetadata',
    })
    expect(pool.statements()).toEqual([
      "import type { ZnightMetadata } from '@znight/core'",
      "import type { Type } from '@x/y'",
      "import { Thing } from '@x/y'",
    ])
  })
})
