/**
 * Fields of the cron dialect (RFC 0004 §4.3). This module is **pure**: no imports, no I/O, no global
 * state, so the compiler extension can load it without loading the schedule runtime.
 */

/** A field of a cron expression, in order: `[second] minute hour day-of-month month day-of-week`. */
export type CronField = 'second' | 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week'

/** Bounds and names of a field. */
export interface FieldSpec {
  readonly name: CronField
  readonly min: number
  readonly max: number
  /** Upper-case names accepted for values (`JAN` → 1, `SUN` → 0). */
  readonly names: Readonly<Record<string, number>> | undefined
  /** How values are written in hints (`'1-12 or JAN-DEC'`). */
  readonly accepts: string
}

const MONTH_NAMES: Readonly<Record<string, number>> = Object.freeze({
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
})

const DAY_NAMES: Readonly<Record<string, number>> = Object.freeze({
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
})

/** The six fields, in expression order (the second is optional). */
export const FIELDS: readonly FieldSpec[] = Object.freeze([
  { name: 'second', min: 0, max: 59, names: undefined, accepts: '0-59' },
  { name: 'minute', min: 0, max: 59, names: undefined, accepts: '0-59' },
  { name: 'hour', min: 0, max: 23, names: undefined, accepts: '0-23' },
  { name: 'day-of-month', min: 1, max: 31, names: undefined, accepts: '1-31, L or ?' },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, accepts: '1-12 or JAN-DEC' },
  { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES, accepts: '0-7 (0 and 7 are Sunday) or SUN-SAT' },
] satisfies FieldSpec[])

/** Display names of the months, by number (messages). */
export const MONTH_LABELS: readonly string[] = Object.freeze([
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
])

/** Display names of the days of the week, Sunday first (messages). */
export const DAY_LABELS: readonly string[] = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
])

/** Nicknames and the 5-field expressions they stand for. */
export const NICKNAMES: Readonly<Record<string, string>> = Object.freeze({
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
})

/** Hint shown under field-level errors. */
export const FIELDS_HINT = 'Fields: [second] minute hour day-of-month month day-of-week'

/** Days in a month of the proleptic Gregorian calendar (`month` 1-12). */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Days since 1970-01-01 of a civil date (proleptic Gregorian, any year). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = (month + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146_097 + doe - 719_468
}

/** A civil date. */
export interface CivilDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** Civil date of a day number (days since 1970-01-01). */
export function civilFromDays(days: number): CivilDate {
  const z = days + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day }
}

/** Day of the week of a day number: 0 is Sunday (1970-01-01 was a Thursday). */
export function weekdayOfDays(days: number): number {
  return (((days + 4) % 7) + 7) % 7
}
