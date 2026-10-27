/**
 * Parser of the cron dialect (RFC 0004 §4.3), shared by the compiler extension and the runtime. This
 * module is **pure** (it only imports other pure modules of `src/cron/`): problems are returned as
 * {@link CronIssue}s carrying the offending field and its span in the expression, never thrown.
 *
 * ```
 * expression = nickname | [second] minute hour day-of-month month day-of-week
 * field      = item ("," item)*
 * item       = "*" ["/" step] | value ["-" value] ["/" step]          ; "a/s" runs from a to the maximum
 *            | "?"                                                     ; day-of-month and day-of-week only
 *            | "L"                                                     ; day-of-month: last day of the month
 *            | value "L" | value "#" n                                 ; day-of-week: last / n-th weekday
 * ```
 */
import type { CronField, FieldSpec } from './fields.ts'

import { FIELDS, FIELDS_HINT, NICKNAMES } from './fields.ts'

/** A problem in a cron expression. */
export interface CronIssue {
  readonly message: string
  /** The field in error; `undefined` when the problem is the whole expression (field count, nickname). */
  readonly field: CronField | undefined
  /** Offset of the offending text in the expression as written, in UTF-16 units. */
  readonly start: number
  /** End offset (exclusive). */
  readonly end: number
  readonly hint: string | undefined
}

/** The text of one field and where it is in the expression. */
export interface CronFieldText {
  readonly field: CronField
  /** As written (the expansion for a nickname). */
  readonly text: string
  readonly start: number
  readonly end: number
}

/**
 * A parsed expression: one bitset per field (`1` at allowed values) plus the `L` / `#` rules. Plain
 * data; {@link compileCron} turns it into a schedule.
 */
export interface CronSpec {
  /** As written. */
  readonly expression: string
  /** Trimmed, whitespace runs collapsed to single spaces (nicknames kept). */
  readonly normalized: string
  /** `true` with 6 fields; with 5 fields (and nicknames) the second is `0`. */
  readonly withSeconds: boolean
  readonly seconds: Uint8Array
  readonly minutes: Uint8Array
  readonly hours: Uint8Array
  /** Index 1-31. */
  readonly days: Uint8Array
  /** `L` in the day-of-month field. */
  readonly lastDay: boolean
  /** Index 1-12. */
  readonly months: Uint8Array
  /** Index 0-6 (Sunday first). */
  readonly weekdays: Uint8Array
  /** `<day>#<n>`: bit `n - 1` set at index `day`. */
  readonly nthWeekdays: Uint8Array
  /** `<day>L`: `1` at index `day`. */
  readonly lastWeekdays: Uint8Array
  /** The day-of-month field is anything but `*` or `?` (OR rule). */
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
  /** The hour field matches every hour (DST fold rule). */
  readonly everyHour: boolean
  /** Source of each field (the second is absent with 5 fields). */
  readonly fields: readonly CronFieldText[]
}

/** Result of {@link parseCronSpec}. */
export type CronParseResult =
  | { readonly ok: true; readonly spec: CronSpec }
  | { readonly ok: false; readonly issue: CronIssue }

/** Parses a cron expression. Never throws. */
export function parseCronSpec(expression: string): CronParseResult {
  if (typeof expression !== 'string') {
    return fail(`a cron expression must be a string, got ${typeof expression}`, undefined, 0, 0)
  }
  const tokens = tokenize(expression)
  if (tokens.length === 0) {
    return fail('the cron expression is empty', undefined, 0, expression.length, FIELDS_HINT)
  }
  const first = tokens[0] as Token
  if (first.text.startsWith('@')) return parseNickname(expression, tokens)
  if (tokens.length === 7) {
    const year = tokens[6] as Token
    return fail(
      '7 fields: the year field is not supported',
      undefined,
      year.start,
      year.end,
      'Use 5 fields (minute hour day-of-month month day-of-week), or 6 with the seconds first',
    )
  }
  if (tokens.length !== 5 && tokens.length !== 6) {
    return fail(
      `expected 5 or 6 fields, got ${tokens.length}`,
      undefined,
      first.start,
      (tokens[tokens.length - 1] as Token).end,
      FIELDS_HINT,
    )
  }
  return build(
    expression,
    tokens.map(token => token.text).join(' '),
    tokens.length === 6 ? tokens : [{ text: '0', start: -1, end: -1 }, ...tokens],
    tokens.length === 6,
  )
}

interface Token {
  readonly text: string
  readonly start: number
  readonly end: number
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  for (const match of expression.matchAll(/\S+/g)) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length })
  }
  return tokens
}

function parseNickname(expression: string, tokens: readonly Token[]): CronParseResult {
  const first = tokens[0] as Token
  const name = first.text.toLowerCase()
  if (name === '@reboot') {
    return fail('@reboot is not supported', undefined, first.start, first.end, 'Use runOnStart: true or @Timeout(0)')
  }
  const expansion = NICKNAMES[name]
  if (expansion === undefined) {
    return fail(
      `unknown nickname '${first.text}'`,
      undefined,
      first.start,
      first.end,
      `Nicknames: ${Object.keys(NICKNAMES).join(', ')}`,
    )
  }
  if (tokens.length > 1) {
    const extra = tokens[1] as Token
    return fail(
      `a nickname stands for the whole expression: unexpected '${extra.text}'`,
      undefined,
      extra.start,
      (tokens[tokens.length - 1] as Token).end,
    )
  }
  // every field of a nickname points at the nickname itself
  const fields = ['0', ...expansion.split(' ')].map(text => ({ text, start: first.start, end: first.end }))
  return build(expression, first.text, fields, false)
}

/** Mutable bitsets of the field being parsed. */
interface Bits {
  readonly values: Uint8Array
  lastDay: boolean
  readonly nth: Uint8Array
  readonly last: Uint8Array
}

function build(
  expression: string,
  normalized: string,
  tokens: readonly Token[],
  withSeconds: boolean,
): CronParseResult {
  const sets: Bits[] = []
  for (let index = 0; index < FIELDS.length; index++) {
    const spec = FIELDS[index] as FieldSpec
    const token = tokens[index] as Token
    const bits: Bits = {
      values: new Uint8Array(spec.name === 'day-of-week' ? 7 : spec.max + 1),
      lastDay: false,
      nth: new Uint8Array(7),
      last: new Uint8Array(7),
    }
    const issue = parseField(spec, token, bits)
    if (issue !== undefined) return { ok: false, issue }
    sets.push(bits)
  }
  const [seconds, minutes, hours, days, months, weekdays] = sets as [Bits, Bits, Bits, Bits, Bits, Bits]
  const fields: CronFieldText[] = []
  for (let index = withSeconds ? 0 : 1; index < FIELDS.length; index++) {
    const token = tokens[index] as Token
    fields.push({ field: (FIELDS[index] as FieldSpec).name, text: token.text, start: token.start, end: token.end })
  }
  const domText = (tokens[3] as Token).text
  const dowText = (tokens[5] as Token).text
  const spec: CronSpec = {
    expression,
    normalized,
    withSeconds,
    seconds: seconds.values,
    minutes: minutes.values,
    hours: hours.values,
    days: days.values,
    lastDay: days.lastDay,
    months: months.values,
    weekdays: weekdays.values,
    nthWeekdays: weekdays.nth,
    lastWeekdays: weekdays.last,
    dayOfMonthRestricted: domText !== '*' && domText !== '?',
    dayOfWeekRestricted: dowText !== '*' && dowText !== '?',
    everyHour: hours.values.every(value => value === 1),
    fields,
  }
  return { ok: true, spec }
}

function parseField(spec: FieldSpec, token: Token, bits: Bits): CronIssue | undefined {
  const text = token.text
  let offset = 0
  const items = text.split(',')
  for (const item of items) {
    const start = token.start + offset
    offset += item.length + 1
    const issue = parseItem(spec, item, start, items.length, bits)
    if (issue !== undefined) return issue
  }
  return undefined
}

function parseItem(spec: FieldSpec, item: string, start: number, count: number, bits: Bits): CronIssue | undefined {
  const field = spec.name
  const end = start + item.length
  const issue = (message: string, from = start, to = end, hint?: string): CronIssue => ({
    message,
    field,
    start: from,
    end: to,
    hint,
  })
  if (item === '') return issue(`empty value in the ${field} field`, start, Math.max(end, start + 1))
  const upper = item.toUpperCase()
  const days = field === 'day-of-month' || field === 'day-of-week'

  if (/^H(?:$|[(/])/.test(upper)) {
    return issue(`'H' (hashed values) is not supported`, start, start + 1, 'Write the value explicitly')
  }
  if (item === '?') {
    if (!days) {
      return issue(
        `'?' is only allowed in the day-of-month and day-of-week fields`,
        start,
        end,
        `Use '*' in the ${field} field`,
      )
    }
    if (count > 1) return issue(`'?' cannot be part of a list`)
    fill(bits.values, spec, spec.min, field === 'day-of-week' ? 6 : spec.max, 1)
    return undefined
  }
  if (field === 'day-of-month') {
    if (upper === 'L') {
      bits.lastDay = true
      return undefined
    }
    if (upper === 'LW' || upper.endsWith('W')) {
      return issue(
        `'${item}': 'W' (nearest weekday) is not supported`,
        start,
        end,
        "Supported day-of-month forms: values, ranges, steps, 'L' (last day)",
      )
    }
    if (/^L-\d+$/.test(upper)) {
      return issue(
        `'${item}' (an offset from the last day) is not supported`,
        start,
        end,
        "Use 'L' for the last day of the month, or list the days",
      )
    }
  }
  if (field === 'day-of-week') {
    const hash = upper.indexOf('#')
    if (hash !== -1) return nthWeekday(spec, item, start, hash, bits)
    if (upper === 'L') {
      return issue(
        `'L' alone is not a day of the week`,
        start,
        end,
        "Use '5L' for the last Friday of the month, or 'L' in the day-of-month field for the last day",
      )
    }
    if (upper.length > 1 && upper.endsWith('L')) {
      if (upper.includes('-') || upper.includes('/')) {
        return issue(`'${item}': 'L' follows a single day ('5L' is the last Friday of the month)`)
      }
      const day = value(spec, item.slice(0, -1), start, false)
      if (typeof day !== 'number') return day
      bits.last[day % 7] = 1
      return undefined
    }
  } else if (upper.includes('#')) {
    return issue(
      `'#' is only allowed in the day-of-week field`,
      start + upper.indexOf('#'),
      start + upper.indexOf('#') + 1,
    )
  }
  if (!days && /(^|[^A-Z])L$/.test(upper)) {
    return issue(`'L' is only allowed in the day-of-month and day-of-week fields`)
  }

  // [range or value or *] [/ step]
  const slash = item.indexOf('/')
  const base = slash === -1 ? item : item.slice(0, slash)
  let step = 1
  if (slash !== -1) {
    const stepText = item.slice(slash + 1)
    const stepStart = start + slash + 1
    if (!/^\d+$/.test(stepText)) {
      return issue(`invalid step '${stepText}' in the ${field} field`, stepStart, Math.max(end, stepStart + 1))
    }
    step = Number(stepText)
    const size = field === 'day-of-week' ? 7 : spec.max - spec.min + 1
    if (step === 0) {
      return issue(`step 0 in the ${field} field: a step must be at least 1`, stepStart, end)
    }
    if (step > size) {
      return issue(
        `step ${step} is larger than the ${field} field (${size} values)`,
        stepStart,
        end,
        `Steps go up to ${size}`,
      )
    }
  }
  const top = field === 'day-of-week' ? 6 : spec.max
  if (base === '*') {
    fill(bits.values, spec, spec.min, top, step)
    return undefined
  }
  if (base === '') return issue(`missing value before '/' in the ${field} field`, start, start + 1)
  const dash = base.indexOf('-', 1)
  if (dash === -1) {
    const single = value(spec, base, start, false)
    if (typeof single !== 'number') return single
    // `a/s` runs from `a` to the maximum: `7/s` (Sunday written 7) is Sunday alone, never an empty set
    fill(bits.values, spec, single, slash === -1 ? single : Math.max(top, single), step)
    return undefined
  }
  const low = value(spec, base.slice(0, dash), start, false)
  if (typeof low !== 'number') return low
  const highText = base.slice(dash + 1)
  let high = value(spec, highText, start + dash + 1, true)
  if (typeof high !== 'number') return high
  // `SUN` closing a range is 7 (`FRI-SUN`), but Sunday alone after Sunday (`SUN-SUN`, `0-SUN`, like `0-0`)
  if (field === 'day-of-week' && low === 0 && high === 7 && !/^\d+$/.test(highText)) high = 0
  if (high < low) {
    return issue(
      `reversed range '${base}' in the ${field} field: ranges do not wrap`,
      start,
      start + base.length,
      `Write ${wrapHint(spec, base.slice(0, dash), base.slice(dash + 1), low, high)}`,
    )
  }
  fill(bits.values, spec, low, high, step)
  return undefined
}

/** `MON#2`: the second Monday of the month. */
function nthWeekday(spec: FieldSpec, item: string, start: number, hash: number, bits: Bits): CronIssue | undefined {
  const day = value(spec, item.slice(0, hash), start, false)
  if (typeof day !== 'number') return day
  const nText = item.slice(hash + 1)
  const n = /^\d$/.test(nText) ? Number(nText) : Number.NaN
  if (!(n >= 1 && n <= 5)) {
    return {
      message: `'${item}': the occurrence after '#' must be 1-5`,
      field: spec.name,
      start: start + hash + 1,
      end: Math.max(start + item.length, start + hash + 2),
      hint: "'MON#2' is the second Monday of the month",
    }
  }
  const index = day % 7
  bits.nth[index] = (bits.nth[index] as number) | (1 << (n - 1))
  return undefined
}

/** A value of the field (number or name), or the issue. `rangeEnd`: `SUN` closing a range is 7. */
function value(spec: FieldSpec, text: string, start: number, rangeEnd: boolean): number | CronIssue {
  const end = start + text.length
  if (text === '') {
    return {
      message: `missing value in the ${spec.name} field`,
      field: spec.name,
      start,
      end: start + 1,
      hint: undefined,
    }
  }
  if (/^\d+$/.test(text)) {
    const number = Number(text)
    if (number < spec.min || number > spec.max) {
      return {
        message: `${spec.name} ${text} is out of range (${spec.min}-${spec.max})`,
        field: spec.name,
        start,
        end,
        hint: spec.name === 'day-of-week' ? 'Days of the week are 0-7 (0 and 7 are Sunday) or SUN-SAT' : FIELDS_HINT,
      }
    }
    return number
  }
  const upper = text.toUpperCase()
  const named = spec.names?.[upper]
  if (named !== undefined) return rangeEnd && spec.name === 'day-of-week' && named === 0 ? 7 : named
  if (/^[A-Z]+$/.test(upper) && spec.names !== undefined) {
    return {
      message: `unknown ${spec.name === 'month' ? 'month' : 'day'} name '${text}'`,
      field: spec.name,
      start,
      end,
      hint: `The ${spec.name} field accepts ${spec.accepts}`,
    }
  }
  const bad = /[^0-9]/.exec(text)
  const at = bad === null ? 0 : bad.index
  return {
    message: /^[A-Za-z]+$/.test(text)
      ? `the ${spec.name} field does not accept names ('${text}')`
      : `unexpected '${text}' in the ${spec.name} field`,
    field: spec.name,
    start: /^[A-Za-z]+$/.test(text) ? start : start + at,
    end: /^[A-Za-z]+$/.test(text) ? end : start + at + 1,
    hint: `The ${spec.name} field accepts ${spec.accepts}`,
  }
}

function fill(values: Uint8Array, spec: FieldSpec, from: number, to: number, step: number): void {
  for (let current = from; current <= to; current += step) {
    values[spec.name === 'day-of-week' ? current % 7 : current] = 1
  }
}

/** `FRI-MON` → `FRI-SUN,MON`; `50-10` → `50-59,0-10`. */
function wrapHint(spec: FieldSpec, lowText: string, highText: string, low: number, high: number): string {
  if (spec.name === 'day-of-week') {
    const named = /^[A-Za-z]+$/.test(lowText)
    const sunday = named ? 'SUN' : '7'
    if (high === 0) return `${lowText}-${sunday}`
    const monday = named ? 'MON' : '1'
    return `${lowText}-${sunday},${high === 1 ? monday : `${monday}-${highText}`}`
  }
  const first = spec.min === high ? `${spec.min}` : `${spec.min}-${highText}`
  const last = low === spec.max ? lowText : `${lowText}-${spec.max}`
  return `${last},${first}`
}

function fail(
  message: string,
  field: CronField | undefined,
  start: number,
  end: number,
  hint?: string,
): { readonly ok: false; readonly issue: CronIssue } {
  return { ok: false, issue: { message, field, start, end, hint } }
}
