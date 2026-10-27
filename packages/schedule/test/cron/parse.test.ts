/**
 * Grammar of the cron dialect (RFC 0004 §4.3): every accepted form, every error with its field and
 * its span in the expression.
 */
import { issue, pointed, runs, spec, values } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const range = (from: number, to: number, step = 1): number[] => {
  const result: number[] = []
  for (let value = from; value <= to; value += step) result.push(value)
  return result
}

describe('accepted forms', () => {
  it.each([
    ['*', range(0, 59)],
    ['5', [5]],
    ['1-4', [1, 2, 3, 4]],
    ['*/15', [0, 15, 30, 45]],
    ['10-30/10', [10, 20, 30]],
    ['50/5', [50, 55]],
    ['1,3,5-7', [1, 3, 5, 6, 7]],
    ['0-59', range(0, 59)],
    ['*/60', [0]],
    ['07', [7]],
  ])('minute %p', (field, expected) => {
    expect(values(spec(`${field} * * * *`).minutes)).toEqual(expected)
  })

  it('reads 5 fields with a zero second and 6 fields with the seconds first', () => {
    const five = spec('30 9 * * *')
    expect(five.withSeconds).toBe(false)
    expect(values(five.seconds)).toEqual([0])
    expect(values(five.minutes)).toEqual([30])
    expect(values(five.hours)).toEqual([9])
    const six = spec('*/10 30 9 * * *')
    expect(six.withSeconds).toBe(true)
    expect(values(six.seconds)).toEqual([0, 10, 20, 30, 40, 50])
    expect(six.fields.map(field => field.field)).toEqual([
      'second',
      'minute',
      'hour',
      'day-of-month',
      'month',
      'day-of-week',
    ])
    expect(five.fields.map(field => [field.field, field.text, field.start])).toEqual([
      ['minute', '30', 0],
      ['hour', '9', 3],
      ['day-of-month', '*', 5],
      ['month', '*', 7],
      ['day-of-week', '*', 9],
    ])
  })

  it('accepts month and day names, case-insensitive, in values and ranges', () => {
    expect(values(spec('0 0 * JAN,mar-May *').months)).toEqual([1, 3, 4, 5])
    expect(values(spec('0 0 * * MON-FRI').weekdays)).toEqual([1, 2, 3, 4, 5])
    expect(values(spec('0 0 * * sun,Sat').weekdays)).toEqual([0, 6])
  })

  it('treats 0 and 7 as Sunday, and SUN closing a range as 7', () => {
    expect(values(spec('0 0 * * 7').weekdays)).toEqual([0])
    expect(values(spec('0 0 * * 5-7').weekdays)).toEqual([0, 5, 6])
    expect(values(spec('0 0 * * FRI-SUN').weekdays)).toEqual([0, 5, 6])
    expect(values(spec('0 0 * * *').weekdays)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(values(spec('0 0 * * */2').weekdays)).toEqual([0, 2, 4, 6])
  })

  it("'a/s' from Sunday written 7 is Sunday alone (7 is the maximum), never an empty set", () => {
    expect(values(spec('0 0 * * 7/2').weekdays)).toEqual([0])
    expect(values(spec('0 0 * * 7/1').weekdays)).toEqual([0])
    expect(values(spec('0 0 * * 7-7/2').weekdays)).toEqual([0])
    expect(values(spec('0 0 * * 0/2').weekdays)).toEqual([0, 2, 4, 6])
    expect(values(spec('0 0 * * SUN/2').weekdays)).toEqual([0, 2, 4, 6])
    expect(values(spec('0 0 * * 1/2').weekdays)).toEqual([1, 3, 5])
    expect(runs('0 0 * * 7/2', '2026-10-27T00:00:00Z', 2)).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-08T00:00:00.000Z',
    ])
  })

  it('reads SUN closing a range that starts on Sunday as Sunday (SUN-SUN is 0-0, not the whole week)', () => {
    for (const expression of ['0 0 * * SUN-SUN', '0 0 * * sun-sun', '0 0 * * 0-SUN', '0 0 * * SUN-SUN/2']) {
      expect(values(spec(expression).weekdays)).toEqual([0])
    }
    expect(values(spec('0 0 * * SUN-SAT').weekdays)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(values(spec('0 0 * * MON-SUN').weekdays)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(values(spec('0 0 * * 0-7').weekdays)).toEqual([0, 1, 2, 3, 4, 5, 6]) // numbers: as written
    expect(runs('0 0 * * SUN-SUN', '2026-10-27T00:00:00Z', 2)).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-08T00:00:00.000Z',
    ])
  })

  it('reads L, <day>L, <day>#<n> and ?', () => {
    expect(spec('0 0 L * *').lastDay).toBe(true)
    expect(spec('0 0 1,L * *').lastDay).toBe(true)
    expect(values(spec('0 0 * * 5L').lastWeekdays)).toEqual([5])
    expect(values(spec('0 0 * * FRIL').lastWeekdays)).toEqual([5])
    const nth = spec('0 0 * * MON#2,1#4,FRI#5')
    expect(nth.nthWeekdays[1]).toBe(0b1010)
    expect(nth.nthWeekdays[5]).toBe(0b10000)
    expect(values(nth.weekdays)).toEqual([])
    const question = spec('0 0 ? * MON')
    expect(question.dayOfMonthRestricted).toBe(false)
    expect(question.dayOfWeekRestricted).toBe(true)
  })

  it('marks restricted day fields (OR rule) and full hours (DST fold rule)', () => {
    expect(spec('0 0 13 * FRI')).toMatchObject({ dayOfMonthRestricted: true, dayOfWeekRestricted: true })
    expect(spec('0 0 * * *')).toMatchObject({ dayOfMonthRestricted: false, dayOfWeekRestricted: false })
    expect(spec('0 0 */2 * *').dayOfMonthRestricted).toBe(true)
    expect(spec('*/30 * * * *').everyHour).toBe(true)
    expect(spec('0 0-23 * * *').everyHour).toBe(true)
    expect(spec('0 */1 * * *').everyHour).toBe(true)
    expect(spec('0 */2 * * *').everyHour).toBe(false)
  })

  it('expands nicknames, keeps them in the normalized form, and collapses whitespace', () => {
    const daily = spec('@daily')
    expect(daily.normalized).toBe('@daily')
    expect(values(daily.hours)).toEqual([0])
    expect(values(daily.minutes)).toEqual([0])
    expect(spec('@yearly').fields.map(field => field.text)).toEqual(['0', '0', '1', '1', '*'])
    expect(spec('@ANNUALLY').normalized).toBe('@ANNUALLY')
    expect(values(spec('@weekly').weekdays)).toEqual([0])
    expect(values(spec('@hourly').minutes)).toEqual([0])
    expect(values(spec('@monthly').days)).toEqual([1])
    expect(values(spec('@midnight').hours)).toEqual([0])
    expect(spec('  0   8\t*  *  MON-FRI ').normalized).toBe('0 8 * * MON-FRI')
  })
})

describe('errors', () => {
  it.each([
    ['0 24 * * MON-FRI', 'hour', '24', 'hour 24 is out of range (0-23)'],
    ['60 * * * *', 'minute', '60', 'minute 60 is out of range (0-59)'],
    ['0 0 0 * *', 'day-of-month', '0', 'day-of-month 0 is out of range (1-31)'],
    ['0 0 32 * *', 'day-of-month', '32', 'day-of-month 32 is out of range (1-31)'],
    ['0 0 * 13 *', 'month', '13', 'month 13 is out of range (1-12)'],
    ['0 0 * * 8', 'day-of-week', '8', 'day-of-week 8 is out of range (0-7)'],
    ['61 * * * * *', 'second', '61', 'second 61 is out of range (0-59)'],
    ['*/0 * * * *', 'minute', '0', 'step 0 in the minute field: a step must be at least 1'],
    ['*/61 * * * *', 'minute', '61', 'step 61 is larger than the minute field (60 values)'],
    [
      '0 0 * * FRI-MON',
      'day-of-week',
      'FRI-MON',
      "reversed range 'FRI-MON' in the day-of-week field: ranges do not wrap",
    ],
    ['50-10 * * * *', 'minute', '50-10', "reversed range '50-10' in the minute field: ranges do not wrap"],
    ['0 ? * * *', 'hour', '?', "'?' is only allowed in the day-of-month and day-of-week fields"],
    ['0 0 1W * *', 'day-of-month', '1W', "'1W': 'W' (nearest weekday) is not supported"],
    ['0 0 LW * *', 'day-of-month', 'LW', "'LW': 'W' (nearest weekday) is not supported"],
    ['0 0 L-3 * *', 'day-of-month', 'L-3', "'L-3' (an offset from the last day) is not supported"],
    ['0 0 * * L', 'day-of-week', 'L', "'L' alone is not a day of the week"],
    ['0 0 * * MON#6', 'day-of-week', '6', "'MON#6': the occurrence after '#' must be 1-5"],
    ['0 0 * * 1-5L', 'day-of-week', '1-5L', "'1-5L': 'L' follows a single day ('5L' is the last Friday of the month)"],
    ['0 0 1#2 * *', 'day-of-month', '#', "'#' is only allowed in the day-of-week field"],
    ['0 L * * *', 'hour', 'L', "'L' is only allowed in the day-of-month and day-of-week fields"],
    ['H * * * *', 'minute', 'H', "'H' (hashed values) is not supported"],
    ['0 0 * FOO *', 'month', 'FOO', "unknown month name 'FOO'"],
    ['0 0 * * FUN', 'day-of-week', 'FUN', "unknown day name 'FUN'"],
    ['0 MON * * *', 'hour', 'MON', "the hour field does not accept names ('MON')"],
    ['1,,2 * * * *', 'minute', ',', 'empty value in the minute field'],
    ['5x * * * *', 'minute', 'x', "unexpected '5x' in the minute field"],
    ['*/a * * * *', 'minute', 'a', "invalid step 'a' in the minute field"],
    ['0 0 ?,1 * *', 'day-of-month', '?', "'?' cannot be part of a list"],
  ])('%p: %s', (expression, field, text, message) => {
    const found = issue(expression)
    expect(found.message).toBe(message)
    expect(found.field).toBe(field as never)
    expect(pointed(expression)).toBe(text)
  })

  it('gives hints for ranges that wrap', () => {
    expect(issue('0 0 * * FRI-MON').hint).toBe('Write FRI-SUN,MON')
    expect(issue('0 0 * * 5-2').hint).toBe('Write 5-7,1-2')
    expect(values(spec('0 0 * * SAT-SUN').weekdays)).toEqual([0, 6]) // SUN closing a range is 7
    expect(issue('50-10 * * * *').hint).toBe('Write 50-59,0-10')
  })

  it('reports the field count, the year field, nicknames and @reboot on the whole expression', () => {
    expect(issue('* * * *')).toMatchObject({ message: 'expected 5 or 6 fields, got 4', field: undefined })
    expect(issue('0 0 0 1 1 * 2027')).toMatchObject({
      message: '7 fields: the year field is not supported',
      field: undefined,
    })
    expect(pointed('0 0 0 1 1 * 2027')).toBe('2027')
    expect(issue('@reboot')).toMatchObject({
      message: '@reboot is not supported',
      hint: 'Use runOnStart: true or @Timeout(0)',
    })
    expect(issue('@every')).toMatchObject({ message: "unknown nickname '@every'" })
    expect(issue('@daily 5')).toMatchObject({ message: "a nickname stands for the whole expression: unexpected '5'" })
    expect(issue('   ')).toMatchObject({ message: 'the cron expression is empty' })
    expect(issue(42 as never)).toMatchObject({ message: 'a cron expression must be a string, got number' })
  })

  it('points into the right field of 6-field expressions', () => {
    expect(issue('0 0 25 * * *')).toMatchObject({ field: 'hour', start: 4, end: 6 })
    expect(pointed('0 0 25 * * *')).toBe('25')
  })
})
