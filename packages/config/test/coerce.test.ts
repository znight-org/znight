import type { ConfigFieldType } from '../src/index.ts'

import { coerceConfigValue, SECRET_MASK } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

function value(raw: unknown, type: ConfigFieldType): unknown {
  const result = coerceConfigValue(raw, type)
  if (!result.ok) throw new Error(`unexpected failure: ${result.message}`)
  return result.value
}

function failure(raw: unknown, type: ConfigFieldType, secret = false): string {
  const result = coerceConfigValue(raw, type, { secret })
  if (result.ok) throw new Error(`unexpected success: ${String(result.value)}`)
  return result.message
}

describe('string', () => {
  it.each([
    ['hello', 'hello'],
    ['  padded  ', '  padded  '],
    ['', ''],
    [42, '42'],
    [true, 'true'],
    [10n, '10'],
    [new URL('https://example.com/a'), 'https://example.com/a'],
  ])('%p → %p', (raw, expected) => {
    expect(value(raw, 'string')).toBe(expected)
  })

  it('rejects objects and arrays', () => {
    expect(failure({ a: 1 }, 'string')).toBe('expected a string but got an object')
    expect(failure(['a'], 'string')).toBe('expected a string but got an array')
  })
})

describe('number (strict)', () => {
  it.each([
    ['42', 42],
    [' 42 ', 42],
    ['-1.5', -1.5],
    ['+3', 3],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['2.5E-2', 0.025],
    ['0', 0],
    [7, 7],
    [-0.25, -0.25],
  ])('%p → %p', (raw, expected) => {
    expect(value(raw, 'number')).toBe(expected)
  })

  it.each(['12px', 'abc', '0x10', '0b1', '1_000', 'Infinity', 'NaN', '1,5', '--1', '.', '1e', '1e999'])(
    'rejects %p',
    raw => {
      expect(failure(raw, 'number')).toBe(`expected a number but got ${JSON.stringify(raw)}`)
    },
  )

  it('rejects non finite numbers and other types', () => {
    expect(failure(Number.NaN, 'number')).toBe('expected a finite number but got NaN')
    expect(failure(Number.POSITIVE_INFINITY, 'number')).toBe('expected a finite number but got Infinity')
    expect(failure(true, 'number')).toBe('expected a number but got true')
    expect(failure([1], 'number')).toBe('expected a number but got an array')
  })
})

describe('boolean', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    [' yes ', true],
    ['On', true],
    ['1', true],
    ['false', false],
    ['False', false],
    ['no', false],
    ['OFF', false],
    ['0', false],
    [true, true],
    [false, false],
    [1, true],
    [0, false],
  ])('%p → %p', (raw, expected) => {
    expect(value(raw, 'boolean')).toBe(expected)
  })

  it.each(['maybe', 'y', 'n', '2', 'truthy', 2])('rejects %p', raw => {
    expect(failure(raw, 'boolean')).toStartWith('expected a boolean (true/false, 1/0, yes/no, on/off) but got')
  })
})

describe('string[]', () => {
  it('splits comma-separated strings, trims items and drops empty ones', () => {
    expect(value('a, b ,c', 'string[]')).toEqual(['a', 'b', 'c'])
    expect(value('a,,b,', 'string[]')).toEqual(['a', 'b'])
    expect(value('single', 'string[]')).toEqual(['single'])
    expect(value(',', 'string[]')).toEqual([])
  })

  it('accepts arrays from structured sources (primitives converted)', () => {
    const raw = ['x', 1, true]
    const result = value(raw, 'string[]')
    expect(result).toEqual(['x', '1', 'true'])
    expect(result).not.toBe(raw)
  })

  it('reports the faulty item', () => {
    expect(failure(['a', { b: 1 }], 'string[]')).toBe('item 1: expected a string but got an object')
    expect(failure({ a: 1 }, 'string[]')).toBe('expected a comma-separated list or an array but got an object')
    expect(failure(5, 'string[]')).toBe('expected a comma-separated list or an array but got 5')
  })
})

describe('number[]', () => {
  it('parses every item strictly', () => {
    expect(value('1, 2.5,-3', 'number[]')).toEqual([1, 2.5, -3])
    expect(value([1, '2'], 'number[]')).toEqual([1, 2])
    expect(failure('1,two,3', 'number[]')).toBe('item 1: expected a number but got "two"')
    expect(failure([1, null], 'number[]')).toBe('item 1: expected a number but got null')
  })
})

describe('url', () => {
  it('produces URL instances from absolute URLs', () => {
    const url = value(' postgres://user@db:5432/app ', 'url')
    expect(url).toBeInstanceOf(URL)
    expect((url as URL).href).toBe('postgres://user@db:5432/app')
  })

  it('copies URL instances (no shared mutable state)', () => {
    const original = new URL('https://example.com')
    const copy = value(original, 'url') as URL
    expect(copy).toBeInstanceOf(URL)
    expect(copy).not.toBe(original)
    expect(copy.href).toBe(original.href)
  })

  it.each(['/relative', 'not a url', '', 'http://'])('rejects %p', raw => {
    expect(failure(raw, 'url')).toBe(`expected an absolute URL but got ${JSON.stringify(raw)}`)
  })

  it('detects a forgotten scheme', () => {
    expect(failure('localhost:5432', 'url')).toBe(
      'expected an absolute URL but got "localhost:5432" (missing scheme, e.g. "http://localhost:5432")',
    )
    expect(failure('db.internal:5432/app', 'url', true)).toBe(
      `expected an absolute URL but got ${SECRET_MASK} (missing scheme, e.g. "http://host:port")`,
    )
    expect(value('mailto:ops@example.com', 'url')).toBeInstanceOf(URL)
    expect(value('file:///etc/app.conf', 'url')).toBeInstanceOf(URL)
  })

  it('rejects other types', () => {
    expect(failure(42, 'url')).toBe('expected an absolute URL but got 42')
  })
})

describe('json', () => {
  it('parses strings', () => {
    expect(value('{"a":[1,2]}', 'json')).toEqual({ a: [1, 2] })
    expect(value('"text"', 'json')).toBe('text')
    expect(value('3', 'json')).toBe(3)
    expect(value('null', 'json')).toBeNull()
  })

  it('keeps structured values, copied', () => {
    const raw = { nested: { list: [1] } }
    const result = value(raw, 'json') as typeof raw
    expect(result).toEqual(raw)
    expect(result).not.toBe(raw)
    expect(result.nested).not.toBe(raw.nested)
    expect(value(12, 'json')).toBe(12)
    expect(value(false, 'json')).toBe(false)
  })

  it('keeps values structuredClone cannot copy', () => {
    const raw = { fn: () => 1 }
    expect(value(raw, 'json')).toBe(raw)
  })

  it('reports parse errors with the parser message', () => {
    const message = failure('{oops', 'json')
    expect(message).toStartWith('expected valid JSON but got "{oops" (')
  })
})

describe('enum', () => {
  it('accepts allowed values', () => {
    expect(coerceConfigValue('prod', 'string', { enum: ['dev', 'prod'] })).toEqual({ ok: true, value: 'prod' })
    expect(coerceConfigValue('2', 'number', { enum: [1, 2] })).toEqual({ ok: true, value: 2 })
    expect(coerceConfigValue('yes', 'boolean', { enum: [true] })).toEqual({ ok: true, value: true })
  })

  it('rejects other values after coercion', () => {
    expect(coerceConfigValue('test', 'string', { enum: ['dev', 'prod'] })).toEqual({
      ok: false,
      message: 'expected one of "dev", "prod" but got "test"',
    })
    expect(coerceConfigValue('3', 'number', { enum: [1, 2] })).toEqual({
      ok: false,
      message: 'expected one of 1, 2 but got 3',
    })
  })

  it('checks every array element', () => {
    expect(coerceConfigValue('read,write', 'string[]', { enum: ['read', 'write'] })).toEqual({
      ok: true,
      value: ['read', 'write'],
    })
    expect(coerceConfigValue('read,admin', 'string[]', { enum: ['read', 'write'] })).toEqual({
      ok: false,
      message: 'item 1: expected one of "read", "write" but got "admin"',
    })
  })

  it('ignores an empty enum', () => {
    expect(coerceConfigValue('x', 'string', { enum: [] })).toEqual({ ok: true, value: 'x' })
  })
})

describe('secrets', () => {
  it('never shows secret values in messages', () => {
    expect(failure('hunter2', 'number', true)).toBe(`expected a number but got ${SECRET_MASK}`)
    expect(failure('{hunter2', 'json', true)).toBe(`expected valid JSON but got ${SECRET_MASK}`)
    expect(failure('a,hunter2', 'number[]', true)).toBe(`item 0: expected a number but got ${SECRET_MASK}`)
    const result = coerceConfigValue('hunter2', 'string', { secret: true, enum: ['a'] })
    expect(result).toEqual({ ok: false, message: `expected one of "a" but got ${SECRET_MASK}` })
  })
})

it('truncates long values in messages', () => {
  const message = failure('x'.repeat(200), 'number')
  expect(message).toBe(`expected a number but got "${'x'.repeat(60)}…"`)
})

it('reports unsupported types', () => {
  expect(failure('x', 'date' as ConfigFieldType)).toBe('unsupported config type "date"')
})
