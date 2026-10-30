import { BadRequestException, coerce } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

function failure(fn: () => unknown): BadRequestException {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException)
    return error as BadRequestException
  }
  throw new Error('Expected a BadRequestException')
}

describe('coerce', () => {
  it('string', () => {
    expect(coerce.string('abc', 'param "id"')).toBe('abc')
    expect(coerce.string('', 'query "q"')).toBe('')
    expect(failure(() => coerce.string(undefined, 'query "q"')).message).toBe('Missing query "q"')
    expect(failure(() => coerce.string(['a', 'b'], 'query "q"')).message).toBe(
      'Invalid query "q": expected a single value, received 2',
    )
    expect(failure(() => coerce.string(42, 'query "q"')).message).toBe(
      'Invalid query "q": expected a string, received number',
    )
  })

  it('number', () => {
    expect(coerce.number('42', 'x')).toBe(42)
    expect(coerce.number('-1.5', 'x')).toBe(-1.5)
    expect(coerce.number('.5', 'x')).toBe(0.5)
    expect(coerce.number('1e3', 'x')).toBe(1000)
    expect(coerce.number(' 7 ', 'x')).toBe(7)
    for (const value of ['', ' ', 'abc', '0x10', '1_000', 'Infinity', 'NaN', '1e999', '12px']) {
      expect(failure(() => coerce.number(value, 'param "id"')).message).toBe(
        `Invalid param "id": expected a number, received ${JSON.stringify(value)}`,
      )
    }
    expect(coerce.number('1.', 'x')).toBe(1)
    expect(coerce.number('+2.5e-3', 'x')).toBe(0.0025)
  })

  it('number runs in linear time (no backtracking blow-up on long digit runs)', () => {
    // the former pattern took ~0.8 s for 32 000 digits and grew quadratically
    for (const value of [`${'1'.repeat(64_000)}x`, `${'1'.repeat(64_000)}.${'1'.repeat(64_000)}x`]) {
      const started = performance.now()
      expect(failure(() => coerce.number(value, 'query "price"')).message).toContain('expected a number')
      expect(performance.now() - started).toBeLessThan(100)
    }
  })

  it('number and integer: the plain digits fast path parses like Number() and falls back otherwise', () => {
    const digits = ['0', '7', '42', '007', '000', '1000000', '123456789012345', '999999999999999']
    for (const value of digits) {
      expect(coerce.number(value, 'x')).toBe(Number(value))
      expect(coerce.integer(value, 'x')).toBe(Number(value))
    }
    expect(Object.is(coerce.number('0', 'x'), 0)).toBe(true)
    // longer runs, signs, spaces, fractions and exponents take the general path
    expect(coerce.number('1234567890123456', 'x')).toBe(1234567890123456)
    expect(coerce.integer('9007199254740991', 'x')).toBe(9007199254740991)
    expect(Object.is(coerce.number('-0', 'x'), -0)).toBe(true)
    expect(coerce.number('+5', 'x')).toBe(5)
    expect(coerce.integer(' 12', 'x')).toBe(12)
    expect(coerce.number('4.', 'x')).toBe(4)
    expect(coerce.number('4e2', 'x')).toBe(400)
    for (const value of ['4/', '4:', '٤', '12 3', '1a']) {
      expect(failure(() => coerce.number(value, 'param "id"')).message).toBe(
        `Invalid param "id": expected a number, received ${JSON.stringify(value)}`,
      )
      expect(failure(() => coerce.integer(value, 'param "id"')).message).toContain('expected an integer')
    }
    expect(failure(() => coerce.number(undefined, 'param "id"')).message).toBe('Missing param "id"')
    expect(failure(() => coerce.integer(['1', '2'], 'query "n"')).message).toBe(
      'Invalid query "n": expected a single value, received 2',
    )
  })

  it('integer', () => {
    expect(coerce.integer('42', 'x')).toBe(42)
    expect(coerce.integer('-7', 'x')).toBe(-7)
    expect(failure(() => coerce.integer('1.5', 'x')).message).toContain('expected an integer')
    expect(failure(() => coerce.integer('9007199254740993', 'x')).message).toContain('expected an integer')
  })

  it('boolean', () => {
    for (const value of ['true', 'TRUE', '1', ' True ']) expect(coerce.boolean(value, 'x')).toBe(true)
    for (const value of ['false', 'False', '0']) expect(coerce.boolean(value, 'x')).toBe(false)
    expect(failure(() => coerce.boolean('yes', 'query "flag"')).message).toBe(
      'Invalid query "flag": expected a boolean (true, false, 1 or 0), received "yes"',
    )
    expect(failure(() => coerce.boolean('', 'x')).message).toContain('expected a boolean')
    // the canonical spellings are matched exactly; anything else goes through the general path
    expect(failure(() => coerce.boolean(['true'], 'query "flag"')).message).toBe(
      'Invalid query "flag": expected a single value, received 1',
    )
    expect(failure(() => coerce.boolean(undefined, 'query "flag"')).message).toBe('Missing query "flag"')
    expect(coerce.boolean(' 0 ', 'x')).toBe(false)
  })

  it('bigint', () => {
    expect(coerce.bigint('9007199254740993', 'x')).toBe(9007199254740993n)
    expect(coerce.bigint('-1', 'x')).toBe(-1n)
    expect(failure(() => coerce.bigint('1.5', 'x')).message).toContain('expected an integer')
  })

  it('date', () => {
    expect(coerce.date('2024-01-02T03:04:05.000Z', 'x').toISOString()).toBe('2024-01-02T03:04:05.000Z')
    expect(coerce.date('0', 'x').getTime()).toBe(0)
    expect(coerce.date('1700000000000', 'x').getTime()).toBe(1_700_000_000_000)
    expect(failure(() => coerce.date('not a date', 'x')).message).toContain('expected a date')
    expect(failure(() => coerce.date('', 'x')).message).toContain('expected a date')
  })

  it('date accepts ISO 8601 only, independently of the server time zone', () => {
    const iso = (value: string): string => coerce.date(value, 'x').toISOString()
    expect(iso('2024-01-02')).toBe('2024-01-02T00:00:00.000Z')
    expect(iso('2024-02-29')).toBe('2024-02-29T00:00:00.000Z')
    expect(iso('2024-01-02T03:04Z')).toBe('2024-01-02T03:04:00.000Z')
    expect(iso('2024-01-02t03:04:05.123456789z')).toBe('2024-01-02T03:04:05.123Z')
    expect(iso('2024-01-02T03:04:05+02:00')).toBe('2024-01-02T01:04:05.000Z')
    expect(iso('2024-01-02T03:04:05-0130')).toBe('2024-01-02T04:34:05.000Z')
    expect(iso('2024-01-01T00:30:00+01:00')).toBe('2023-12-31T23:30:00.000Z')
    expect(iso('0050-06-01')).toBe('0050-06-01T00:00:00.000Z')
    for (const value of [
      'foo 2024', // the legacy Date parser of the engine accepted these
      '1 2 3',
      'March 7',
      'Tuesday',
      '01/02/2024',
      '2024-1-2',
      '2024-02-30', // rolled over to March 1
      '2023-02-29',
      '2024-13-01',
      '2024-01-02T24:00Z',
      '2024-01-02T10:60Z',
      '2024-01-02T10:00:60Z',
      '2024-01-02T10:00+24:00',
      '2024-01-02T10:00', // no offset: would depend on the server time zone
      '2024-01-02T10:00:00.1234567890Z',
    ]) {
      expect({ value, message: failure(() => coerce.date(value, 'query "since"')).message }).toEqual({
        value,
        message: `Invalid query "since": expected a date (ISO 8601 such as 2024-01-02 or 2024-01-02T10:00:00Z, or a timestamp), received ${JSON.stringify(value)}`,
      })
    }
  })

  it('enum', () => {
    expect(coerce.enum('asc', 'query "sort"', ['asc', 'desc'])).toBe('asc')
    expect(coerce.enum('2', 'x', [1, 2])).toBe(2)
    expect(coerce.enum('true', 'x', [true])).toBe(true)
    expect(failure(() => coerce.enum('up', 'query "sort"', ['asc', 'desc'])).message).toBe(
      'Invalid query "sort": expected one of "asc", "desc", received "up"',
    )
    const typed: 'asc' | 'desc' = coerce.enum('desc', 'x', ['asc', 'desc'])
    expect(typed).toBe('desc')
  })

  it('array', () => {
    expect(coerce.array('1', 'query "id"', coerce.number)).toEqual([1])
    expect(coerce.array(['1', '2'], 'query "id"', coerce.number)).toEqual([1, 2])
    expect(coerce.array([], 'query "id"', coerce.number)).toEqual([])
    expect(failure(() => coerce.array(['1', 'x'], 'query "id"', coerce.number)).message).toBe(
      'Invalid query "id"[1]: expected a number, received "x"',
    )
    expect(failure(() => coerce.array(undefined, 'query "id"', coerce.number)).message).toBe('Missing query "id"')
  })

  it('optional', () => {
    expect(coerce.optional(undefined, 'x', coerce.number)).toBeUndefined()
    expect(coerce.optional(null, 'x', coerce.number)).toBeUndefined()
    expect(coerce.optional('3', 'x', coerce.number)).toBe(3)
    expect(coerce.optional(['1'], 'x', (value, label) => coerce.array(value, label, coerce.integer))).toEqual([1])
    expect(failure(() => coerce.optional('', 'x', coerce.number)).message).toContain('expected a number')
  })

  it('truncates long received values in messages', () => {
    const message = failure(() => coerce.number('x'.repeat(100), 'x')).message
    expect(message.length).toBeLessThan(120)
    expect(message).toContain('…')
  })

  it('is frozen', () => {
    expect(Object.isFrozen(coerce)).toBe(true)
  })
})
