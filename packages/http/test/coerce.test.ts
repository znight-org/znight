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
