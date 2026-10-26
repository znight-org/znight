import { applyBinary, applyUnary, describeValue, isStaticPrimitive } from '../../src/project/index.ts'
import { describe, expect, test as it } from 'bun:test'

describe('applyBinary', () => {
  it.each([
    ['+', 1, 2, 3],
    ['+', 1n, 2n, 3n],
    ['+', 'a', 1, 'a1'],
    ['+', 1, 'a', '1a'],
    ['+', 'a', null, 'anull'],
    ['+', 'a', undefined, 'aundefined'],
    ['-', 5, 3, 2],
    ['*', 2n, 3n, 6n],
    ['/', 7, 2, 3.5],
    ['/', 7n, 2n, 3n],
    ['%', 7, 3, 1],
    ['**', 2, 10, 1024],
    ['<<', 1, 4, 16],
    ['>>', -16, 2, -4],
    ['>>>', -16, 28, 15],
    ['&', 6, 3, 2],
    ['|', 6, 3, 7],
    ['^', 6, 3, 5],
    ['===', 1, 1, true],
    ['!==', 'a', 'a', false],
    ['==', null, undefined, true],
    ['!=', 1, '1', false],
    ['<', 1, 2n, true],
    ['>=', 'b', 'a', true],
  ] as const)('%p %p %p = %p', (operator, left, right, expected) => {
    expect(applyBinary(operator, left, right)).toEqual({ ok: true, value: expected })
  })

  it.each([
    ['+', 1, 2n, "Operator '+' cannot be applied to number and bigint"],
    ['>>>', 1n, 2n, "Operator '>>>' cannot be applied to bigint and bigint"],
    ['/', 1n, 0n, 'Division by zero'],
    ['%', 1n, 0n, 'Division by zero'],
    ['<', 'a', 1, "Operator '<' cannot be applied to string and number"],
    ['-', true, 1, "Operator '-' cannot be applied to boolean and number"],
    ['in', 'a', 'b', "Operator 'in' is not statically evaluable"],
  ] as const)('%p on %p and %p fails: %s', (operator, left, right, message) => {
    expect(applyBinary(operator, left, right)).toEqual({ ok: false, message })
  })

  it('objects and arrays are never operands', () => {
    expect(applyBinary('+', 'a', ['b'])).toEqual({
      ok: false,
      message: "Operator '+' cannot be applied to string and an array",
    })
    expect(applyBinary('===', { a: 1 }, { a: 1 })).toMatchObject({ ok: false })
  })

  it('division by zero on numbers follows JavaScript', () => {
    expect(applyBinary('/', 1, 0)).toEqual({ ok: true, value: Number.POSITIVE_INFINITY })
  })

  it('turns bigint RangeErrors and huge bigint results into errors (never throws)', () => {
    expect(applyBinary('**', 2n, -1n)).toMatchObject({ ok: false })
    for (const [operator, left, right] of [
      ['**', 2n, 10n ** 12n],
      ['**', -3n, 2_000_000n],
      ['<<', 1n, 10n ** 12n],
      ['>>', 1n, -(10n ** 12n)],
    ] as const) {
      expect(applyBinary(operator, left, right)).toEqual({
        ok: false,
        message: `The result of '${operator}' is too large to be evaluated statically (more than 1000000 bits)`,
      })
    }
    expect(applyBinary('**', 2n, 64n)).toEqual({ ok: true, value: 2n ** 64n })
    expect(applyBinary('**', 1n, 10n ** 12n)).toEqual({ ok: true, value: 1n })
    expect(applyBinary('<<', 1n, 64n)).toEqual({ ok: true, value: 1n << 64n })
    expect(applyBinary('>>', 1n, 10n ** 12n)).toEqual({ ok: true, value: 0n })
  })
})

describe('applyUnary', () => {
  it.each([
    ['!', 0, true],
    ['!', 'x', false],
    ['-', 5, -5],
    ['-', 5n, -5n],
    ['+', 3, 3],
    ['~', 1, -2],
    ['~', 1n, -2n],
    ['void', 'x', undefined],
  ] as const)('%p %p = %p', (operator, value, expected) => {
    expect(applyUnary(operator, value)).toEqual({ ok: true, value: expected })
  })

  it.each([
    ['+', 1n, "Operator '+' cannot be applied to bigint"],
    ['-', 'a', "Operator '-' cannot be applied to string"],
    ['typeof', 1, "The 'typeof' operator is not statically evaluable"],
    ['delete', 1, "The 'delete' operator is not statically evaluable"],
  ] as const)('%p %p fails', (operator, value, message) => {
    expect(applyUnary(operator, value)).toEqual({ ok: false, message })
  })
})

describe('static values', () => {
  it('describeValue and isStaticPrimitive', () => {
    expect([null, undefined, 1, 'a', true, 1n, [], {}].map(describeValue)).toEqual([
      'null',
      'undefined',
      'number',
      'string',
      'boolean',
      'bigint',
      'an array',
      'an object',
    ])
    expect(isStaticPrimitive(null)).toBe(true)
    expect(isStaticPrimitive([])).toBe(false)
  })
})
