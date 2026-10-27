/**
 * Static analysis of parsed cron expressions (RFC 0004 §5.2): expressions that never fire and
 * likely mistakes. This module is **pure** (it only imports other pure modules of `src/cron/`).
 */
import type { CronField } from './fields.ts'
import type { CronFieldText, CronSpec } from './parse.ts'

import { FIELDS_HINT, MONTH_LABELS } from './fields.ts'

/** A finding of the analysis, located on a field of the expression. */
export interface CronFinding {
  readonly message: string
  readonly hint: string
  readonly field: CronField | undefined
  readonly start: number
  readonly end: number
}

/** How often a field of seconds fires, by its number of values. */
const RATES: Readonly<Record<number, string>> = { 1: 'every minute', 60: 'every second' }

/** Longest month of each month number (February: 29, leap years included). */
const LONGEST: readonly number[] = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Why the expression never fires (proleptic Gregorian calendar), or `undefined`: a field that allows
 * no value (defensive: the parser never builds one), or a restricted day-of-month without day-of-week
 * that no month has. Every day of the week, every `#n` and every `L` happens within a 400-year cycle.
 */
export function neverFires(spec: CronSpec): CronFinding | undefined {
  const empty = emptyField(spec)
  if (empty !== undefined) {
    const field = fieldOf(spec, empty)
    return {
      message: `never fires: the ${empty} field allows no value`,
      hint: FIELDS_HINT,
      field: empty,
      start: field?.start ?? 0,
      end: field?.end ?? spec.expression.length,
    }
  }
  if (!spec.dayOfMonthRestricted || spec.dayOfWeekRestricted || spec.lastDay) return undefined
  const months = values(spec.months, 1)
  const days = values(spec.days, 1)
  const longest = Math.max(...months.map(month => LONGEST[month] as number))
  if (days.length === 0 || (days[0] as number) <= longest) return undefined
  const field = fieldOf(spec, 'day-of-month')
  const names = months.map(month => MONTH_LABELS[month] as string)
  const lastDay = spec.fields.map(entry => (entry.field === 'day-of-month' ? 'L' : entry.text)).join(' ')
  return {
    message: `never fires: ${list(names, 'and')} ${names.length === 1 ? 'has' : 'have'} no day ${list(days.map(String), 'or')}`,
    hint: `Use 'L' for the last day of the month: '${lastDay}'`,
    field: 'day-of-month',
    start: field?.start ?? 0,
    end: field?.end ?? spec.expression.length,
  }
}

/**
 * Likely mistakes: a `*` minute (or second) under fixed hours (or minutes), which fires every minute
 * of those hours (`'* 9 * * *'` runs 60 times from 09:00 to 09:59). `0-59` states the intent. Every
 * expression a hint suggests means what the hint says, and raises no warning.
 */
export function cronWarnings(spec: CronSpec): CronFinding[] {
  const second = fieldOf(spec, 'second')
  const minute = fieldOf(spec, 'minute') as CronFieldText
  const hour = fieldOf(spec, 'hour') as CronFieldText
  const findings: CronFinding[] = []
  const replace = (changes: Partial<Record<CronField, string>>): string =>
    spec.fields.map(entry => changes[entry.field] ?? entry.text).join(' ')
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (minute.text === '*' && isValueList(hour.text)) {
    const hours = hour.text.split(',').map(Number)
    const first = pad(hours[0] as number)
    // runs per minute: 1 with 5 fields (second 0), 60 for a `*` second
    const perMinute = second === undefined ? 1 : values(spec.seconds, 0).length
    const everySecond = perMinute === 60
    const rate = RATES[perMinute] ?? `${perMinute} times a minute`
    const message =
      hours.length === 1
        ? `fires ${rate} from ${first}:00${everySecond ? ':00' : ''} to ${first}:59${everySecond ? ':59' : ''}`
        : `fires ${rate} ${perMinute === 1 || everySecond ? 'of' : 'in'} the hours ${list(hours.map(String), 'and')}`
    // a second field firing several times a minute becomes `0` for "once" and "every minute"
    const seconds: Partial<Record<CronField, string>> = perMinute === 1 ? {} : { second: '0' }
    const once = replace({ ...seconds, minute: '0' })
    const everyMinute = replace({ ...seconds, minute: '0-59' })
    const keep = perMinute === 1 ? '' : `, or '${replace({ minute: '0-59' })}' to mean ${rate}`
    findings.push({
      message,
      hint: `Once at ${first}:00 is '${once}'; write '${everyMinute}' to mean every minute${keep}`,
      field: 'minute',
      start: minute.start,
      end: minute.end,
    })
    return findings
  }
  if (second !== undefined && second.text === '*' && isValueList(minute.text)) {
    const minutes = minute.text.split(',').map(Number)
    const singleHour = isValueList(hour.text) && !hour.text.includes(',') ? Number(hour.text) : undefined
    const at = singleHour !== undefined && minutes.length === 1 ? `${pad(singleHour)}:${pad(minutes[0] as number)}` : ''
    const message =
      at === ''
        ? `fires every second of the minute${minutes.length === 1 ? '' : 's'} ${list(minutes.map(String), 'and')}`
        : `fires every second from ${at}:00 to ${at}:59`
    const zero = replace({ second: '0' })
    findings.push({
      message,
      hint: `${at === '' ? `At second 0 only is '${zero}'` : `Once at ${at} is '${zero}'`}; write '${replace({ second: '0-59' })}' to mean every second`,
      field: 'second',
      start: second.start,
      end: second.end,
    })
  }
  return findings
}

/** A field that allows no value (the day fields count their `L` and `#` rules, OR-ed when both are restricted). */
function emptyField(spec: CronSpec): CronField | undefined {
  if (values(spec.seconds, 0).length === 0) return 'second'
  if (values(spec.minutes, 0).length === 0) return 'minute'
  if (values(spec.hours, 0).length === 0) return 'hour'
  if (values(spec.months, 1).length === 0) return 'month'
  const dayOfMonth = !spec.dayOfMonthRestricted || spec.lastDay || values(spec.days, 1).length > 0
  const dayOfWeek =
    !spec.dayOfWeekRestricted ||
    values(spec.weekdays, 0).length > 0 ||
    spec.nthWeekdays.some(bits => bits !== 0) ||
    values(spec.lastWeekdays, 0).length > 0
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) {
    return dayOfMonth || dayOfWeek ? undefined : 'day-of-week'
  }
  if (!dayOfMonth) return 'day-of-month'
  return dayOfWeek ? undefined : 'day-of-week'
}

function fieldOf(spec: CronSpec, field: CronField): CronFieldText | undefined {
  return spec.fields.find(entry => entry.field === field)
}

/** `9` or `9,17`: plain values only (no range, step or name). */
function isValueList(text: string): boolean {
  return /^\d+(?:,\d+)*$/.test(text)
}

function values(bits: Uint8Array, from: number): number[] {
  const result: number[] = []
  for (let index = from; index < bits.length; index++) if (bits[index] === 1) result.push(index)
  return result
}

/** `a`, `a and b`, `a, b and c`. */
function list(items: readonly string[], conjunction: string): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`
}
