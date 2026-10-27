/**
 * Occurrences in UTC (RFC 0004 §4.3, §7.3): ranges, steps, lists, names, nicknames, `L`, `5L`,
 * `MON#2`, the OR rule, leap years, seconds, and the public `parseCron` / `parseDuration` API.
 */
import { InvalidScheduleError, parseCron, parseDuration } from '../../src/index.ts'
import { between, runs } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

describe('occurrences in UTC', () => {
  it.each([
    ['0 9 * * MON-FRI', '2026-01-02T10:00:00Z', ['2026-01-05T09:00:00.000Z', '2026-01-06T09:00:00.000Z']],
    ['*/15 * * * *', '2026-01-01T00:07:00Z', ['2026-01-01T00:15:00.000Z', '2026-01-01T00:30:00.000Z']],
    ['0 0 1 1 *', '2026-06-01T00:00:00Z', ['2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z']],
    ['0 12 * JUN,DEC SUN', '2026-01-01T00:00:00Z', ['2026-06-07T12:00:00.000Z', '2026-06-14T12:00:00.000Z']],
    ['@hourly', '2026-01-01T00:30:00Z', ['2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z']],
    ['@weekly', '2026-01-01T00:00:00Z', ['2026-01-04T00:00:00.000Z', '2026-01-11T00:00:00.000Z']],
    ['@monthly', '2026-01-15T00:00:00Z', ['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z']],
    [
      '0 0 L * *',
      '2026-01-01T00:00:00Z',
      ['2026-01-31T00:00:00.000Z', '2026-02-28T00:00:00.000Z', '2026-03-31T00:00:00.000Z'],
    ],
    ['0 0 L 2 *', '2027-03-01T00:00:00Z', ['2028-02-29T00:00:00.000Z', '2029-02-28T00:00:00.000Z']],
    [
      '0 0 * * 5L',
      '2026-01-01T00:00:00Z',
      ['2026-01-30T00:00:00.000Z', '2026-02-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'],
    ],
    [
      '0 0 * * MON#2',
      '2026-01-01T00:00:00Z',
      ['2026-01-12T00:00:00.000Z', '2026-02-09T00:00:00.000Z', '2026-03-09T00:00:00.000Z'],
    ],
    [
      '0 0 * * 1#1,5#3',
      '2026-01-01T00:00:00Z',
      ['2026-01-05T00:00:00.000Z', '2026-01-16T00:00:00.000Z', '2026-02-02T00:00:00.000Z'],
    ],
    ['0 0 29 2 *', '2026-01-01T00:00:00Z', ['2028-02-29T00:00:00.000Z', '2032-02-29T00:00:00.000Z']],
    ['*/20 * * * * *', '2026-01-01T00:00:00.500Z', ['2026-01-01T00:00:20.000Z', '2026-01-01T00:00:40.000Z']],
    ['30 59 23 31 12 *', '2026-12-31T23:59:30Z', ['2027-12-31T23:59:30.000Z']],
  ])('%p after %p', (expression, from, expected) => {
    expect(runs(expression, from, expected.length)).toEqual(expected)
  })

  it('OR-s the day of month and the day of week when both are restricted (Vixie cron, POSIX)', () => {
    // every 13th, and every Friday
    expect(runs('0 0 13 * FRI', '2026-01-01T00:00:00Z', 4)).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-09T00:00:00.000Z',
      '2026-01-13T00:00:00.000Z',
      '2026-01-16T00:00:00.000Z',
    ])
    // a restricted day of week alone, or with '?' in the day of month
    expect(runs('0 0 ? * FRI', '2026-01-01T00:00:00Z', 2)).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-09T00:00:00.000Z',
    ])
    // 'L' OR-ed with Mondays
    expect(between('0 0 L * MON', '2026-02-20T00:00:00Z', '2026-03-03T00:00:00Z')).toEqual([
      '2026-02-23T00:00:00.000Z',
      '2026-02-28T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
    ])
  })

  it('finds a fifth Monday of February across decades', () => {
    const found = runs('0 0 * 2 1#5', '2026-01-01T00:00:00Z', 3)
    expect(found).toHaveLength(3)
    for (const iso of found) {
      const date = new Date(iso)
      expect(date.getUTCMonth()).toBe(1)
      expect(date.getUTCDate()).toBe(29)
      expect(date.getUTCDay()).toBe(1)
    }
    expect(found[0]).toBe('2044-02-29T00:00:00.000Z')
  })

  it('returns strictly later occurrences', () => {
    expect(runs('0 0 * * *', '2026-01-01T00:00:00Z', 1)).toEqual(['2026-01-02T00:00:00.000Z'])
    expect(runs('0 0 * * *', '2025-12-31T23:59:59.999Z', 1)).toEqual(['2026-01-01T00:00:00.000Z'])
  })

  it('finds occurrences before 1970 (negative epoch seconds are not "not found")', () => {
    expect(runs('0 0 * * *', '1960-01-01T00:00:00Z', 2)).toEqual([
      '1960-01-02T00:00:00.000Z',
      '1960-01-03T00:00:00.000Z',
    ])
    expect(runs('0 0 29 2 *', '1896-03-01T00:00:00Z', 1)).toEqual(['1904-02-29T00:00:00.000Z']) // 1900 is not leap
    expect(runs('59 59 23 31 12 *', '1969-12-31T23:59:58Z', 1)).toEqual(['1969-12-31T23:59:59.000Z'])
    const daily = parseCron('0 0 * * *')
    expect(daily.matches(new Date('1960-01-02T00:00:00Z'))).toBe(true)
    expect(daily.nextRuns(1, new Date('1700-06-01T12:00:00Z'))).toEqual([new Date('1700-06-02T00:00:00Z')])
    expect(parseCron('0 9 * * *', { timeZone: 'Europe/Paris' }).next(new Date('1960-07-01T00:00:00Z'))).toEqual(
      new Date('1960-07-01T08:00:00Z'), // CET all year in 1960
    )
  })
})

describe('parseCron', () => {
  it('validates and computes occurrences in a zone (RFC example)', () => {
    const schedule = parseCron('0 8 * * MON-FRI', { timeZone: 'Europe/Paris' })
    expect(schedule.expression).toBe('0 8 * * MON-FRI')
    expect(schedule.timeZone).toBe('Europe/Paris')
    expect(schedule.next(new Date('2026-10-27T10:00:00Z'))?.toISOString()).toBe('2026-10-28T07:00:00.000Z')
    expect(schedule.matches(new Date('2026-10-28T07:00:00Z'))).toBe(true)
    expect(schedule.matches(new Date('2026-10-28T07:00:01Z'))).toBe(false)
    expect(schedule.matches(Date.parse('2026-10-28T07:00:00.500Z'))).toBe(false)
    const after = Date.now()
    const upcoming = schedule.nextRuns(3)
    expect(upcoming).toHaveLength(3)
    expect(upcoming[0]?.getTime()).toBeGreaterThan(after)
    expect(schedule.nextRuns(2, new Date('2026-10-30T08:00:00Z')).map(date => date.toISOString())).toEqual([
      '2026-11-02T07:00:00.000Z',
      '2026-11-03T07:00:00.000Z',
    ])
    expect(parseCron('@daily').timeZone).toBe('UTC')
    expect(schedule.next()?.getTime()).toBeGreaterThan(after)
  })

  it('throws InvalidScheduleError (ZNIGHT040) with the field and its span', () => {
    let thrown: unknown
    try {
      parseCron('0 24 * * MON-FRI')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvalidScheduleError)
    expect(thrown).toMatchObject({
      code: 'ZNIGHT040',
      field: 'hour',
      start: 2,
      end: 4,
      message: "ZNIGHT040: Invalid cron expression '0 24 * * MON-FRI': hour 24 is out of range (0-23)",
    })
    expect(() => parseCron('0 0 30 2 *')).toThrow("Cron expression '0 0 30 2 *' never fires: February has no day 30")
    expect(() => parseCron('@daily', { timeZone: 'Europe/Pari' })).toThrow(
      "Invalid time zone: unknown time zone 'Europe/Pari' (did you mean 'Europe/Paris'?)",
    )
    expect(() => parseCron('@daily', { timeZone: '+25:00' })).toThrow("invalid UTC offset '+25:00'")
    expect(() => parseCron('@daily').nextRuns(-1)).toThrow('count must be a non-negative integer')
    expect(() => parseCron('@daily').next(new Date('invalid'))).toThrow('expected a valid Date')
  })
})

describe('parseDuration', () => {
  it.each([
    [0, 0],
    [1500, 1500],
    ['500ms', 500],
    ['30s', 30_000],
    ['5m', 300_000],
    ['1.5h', 5_400_000],
    ['1d', 86_400_000],
    ['366d', 31_622_400_000],
    ['0.5s', 500],
  ])('%p is %p ms', (value, expected) => {
    expect(parseDuration(value)).toBe(expected)
  })

  it.each([
    ['5 min', "'5 min' is not a duration: use '5m' (ms, s, m, h, d)"],
    ['5mins', "'5mins' is not a duration: use '5m' (ms, s, m, h, d)"],
    ['10 seconds', "'10 seconds' is not a duration: use '10s' (ms, s, m, h, d)"],
    ['500', "'500' is not a duration: add a unit: '500ms', '500s'... (ms, s, m, h, d)"],
    ['5w', "'5w' is not a duration: unknown unit 'w' (ms, s, m, h, d)"],
    ['-5s', "'-5s' is not a duration: durations are non-negative"],
    ['0.5ms', "'0.5ms' is not a whole number of milliseconds"],
    ['367d', "'367d' is longer than 366 days"],
    [-1, '-1 is not a duration: use a non-negative number of milliseconds'],
    [1.5, '1.5 is not a whole number of milliseconds'],
    [Number.NaN, 'NaN is not a duration'],
  ])('%p: %s', (value, message) => {
    expect(() => parseDuration(value)).toThrow(message)
  })
})
