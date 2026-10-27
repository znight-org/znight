/**
 * Static analysis of parsed cron expressions (RFC 0004 §5.2): expressions that never fire and
 * likely mistakes. This module is **pure** (it only imports other pure modules of `src/cron/`).
 */
import type { CronField } from './fields.ts'
import type { CronFieldText, CronSpec } from './parse.ts'

import { MONTH_LABELS } from './fields.ts'

/** A finding of the analysis, located on a field of the expression. */
export interface CronFinding {
  readonly message: string
  readonly hint: string
  readonly field: CronField | undefined
  readonly start: number
  readonly end: number
}

/** Longest month of each month number (February: 29, leap years included). */
const LONGEST: readonly number[] = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Why the expression never fires (proleptic Gregorian calendar), or `undefined`. Only a restricted
 * day-of-month without day-of-week can do that: every day of the week, every `#n` and every `L`
 * happens within a 400-year cycle.
 */
export function neverFires(spec: CronSpec): CronFinding | undefined {
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
 * of those hours (`'* 9 * * *'` runs 60 times from 09:00 to 09:59). `0-59` states the intent.
 */
export function cronWarnings(spec: CronSpec): CronFinding[] {
  const second = fieldOf(spec, 'second')
  const minute = fieldOf(spec, 'minute') as CronFieldText
  const hour = fieldOf(spec, 'hour') as CronFieldText
  const findings: CronFinding[] = []
  const replace = (changes: Partial<Record<CronField, string>>): string =>
    spec.fields.map(entry => changes[entry.field] ?? entry.text).join(' ')
  if (minute.text === '*' && isValueList(hour.text)) {
    const hours = hour.text.split(',').map(Number)
    const everySecond = second?.text === '*'
    const unit = everySecond ? 'second' : 'minute'
    const pad = (value: number): string => String(value).padStart(2, '0')
    const message =
      hours.length === 1
        ? `fires every ${unit} from ${pad(hours[0] as number)}:00${everySecond ? ':00' : ''} to ${pad(hours[0] as number)}:59${everySecond ? ':59' : ''}`
        : `fires every ${unit} of the hours ${list(hours.map(String), 'and')}`
    const once = replace(everySecond ? { second: '0', minute: '0' } : { minute: '0' })
    const every = replace({ minute: '0-59' })
    findings.push({
      message,
      hint: `Once at ${pad(hours[0] as number)}:00 is '${once}'; write '${every}' to mean every minute`,
      field: 'minute',
      start: minute.start,
      end: minute.end,
    })
    return findings
  }
  if (second !== undefined && second.text === '*' && isValueList(minute.text)) {
    const minutes = minute.text.split(',').map(Number)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const singleHour = isValueList(hour.text) && !hour.text.includes(',') ? Number(hour.text) : undefined
    const message =
      singleHour !== undefined && minutes.length === 1
        ? `fires every second from ${pad(singleHour)}:${pad(minutes[0] as number)}:00 to ${pad(singleHour)}:${pad(minutes[0] as number)}:59`
        : `fires every second of the minute${minutes.length === 1 ? '' : 's'} ${list(minutes.map(String), 'and')}`
    findings.push({
      message,
      hint: `Once a minute is '${replace({ second: '0' })}'; write '${replace({ second: '0-59' })}' to mean every second`,
      field: 'second',
      start: second.start,
      end: second.end,
    })
  }
  return findings
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
