/**
 * Static analysis (RFC 0004 §5.2): expressions that never fire, and a `*` minute or second under
 * fixed hours or minutes.
 */
import { cronWarnings, neverFires } from '../../src/cron/analysis.ts'
import { spec } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

describe('neverFires', () => {
  it.each([
    ['0 0 30 2 *', 'never fires: February has no day 30', "Use 'L' for the last day of the month: '0 0 L 2 *'"],
    [
      '0 0 30,31 2 *',
      'never fires: February has no day 30 or 31',
      "Use 'L' for the last day of the month: '0 0 L 2 *'",
    ],
    [
      '0 0 31 4,6,9,11 *',
      'never fires: April, June, September and November have no day 31',
      "Use 'L' for the last day of the month: '0 0 L 4,6,9,11 *'",
    ],
    ['0 0 0 31 FEB *', 'never fires: February has no day 31', "Use 'L' for the last day of the month: '0 0 0 L FEB *'"],
  ])('%p', (expression, message, hint) => {
    expect(neverFires(spec(expression))).toMatchObject({ message, hint, field: 'day-of-month' })
  })

  it.each(['0 0 29 2 *', '0 0 30 2 MON', '0 0 L 2 *', '0 0 * 2 1#5', '0 0 31 * *', '0 0 30 1-2 *'])(
    '%p fires (leap years, OR rule, L, #5)',
    expression => {
      expect(neverFires(spec(expression))).toBeUndefined()
    },
  )

  it('points at the day-of-month field', () => {
    const finding = neverFires(spec('0 0 30 2 *'))
    expect('0 0 30 2 *'.slice(finding?.start, finding?.end)).toBe('30')
  })
})

describe('cronWarnings', () => {
  it.each([
    [
      '* 9 * * *',
      'fires every minute from 09:00 to 09:59',
      "Once at 09:00 is '0 9 * * *'; write '0-59 9 * * *' to mean every minute",
    ],
    [
      '* 9,17 * * *',
      'fires every minute of the hours 9 and 17',
      "Once at 09:00 is '0 9,17 * * *'; write '0-59 9,17 * * *' to mean every minute",
    ],
    [
      '0 * 9 * * *',
      'fires every minute from 09:00 to 09:59',
      "Once at 09:00 is '0 0 9 * * *'; write '0 0-59 9 * * *' to mean every minute",
    ],
    [
      '* * 9 * * *',
      'fires every second from 09:00:00 to 09:59:59',
      "Once at 09:00 is '0 0 9 * * *'; write '* 0-59 9 * * *' to mean every minute",
    ],
    [
      '* 30 9 * * *',
      'fires every second from 09:30:00 to 09:30:59',
      "Once a minute is '0 30 9 * * *'; write '0-59 30 9 * * *' to mean every second",
    ],
    [
      '* 0,30 * * * *',
      'fires every second of the minutes 0 and 30',
      "Once a minute is '0 0,30 * * * *'; write '0-59 0,30 * * * *' to mean every second",
    ],
  ])('%p', (expression, message, hint) => {
    const [warning] = cronWarnings(spec(expression))
    expect(warning).toMatchObject({ message, hint })
  })

  it.each(['0-59 9 * * *', '* 9-17 * * *', '* */2 * * *', '* * * * *', '0 9 * * *', '0-59 30 9 * * *', '@hourly'])(
    '%p is fine',
    expression => {
      expect(cronWarnings(spec(expression))).toEqual([])
    },
  )
})
