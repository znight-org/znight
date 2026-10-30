/**
 * Durations of `@Interval`, `@Timeout` and `maxDuration` (RFC 0004 §4.2): milliseconds, or a number
 * with one unit (`'500ms'`, `'30s'`, `'5m'`, `'1.5h'`, `'1d'`). Shared by the compiler extension and
 * the runtime. This module is **pure**: no imports, no I/O, no global state.
 */

/** Milliseconds, or a number with one unit: `'500ms'`, `'30s'`, `'5m'`, `'1.5h'`, `'1d'`. */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

/** Longest accepted duration: 366 days. */
export const MAX_DURATION_MS: number = 366 * 86_400_000

/** Milliseconds per unit. */
export const DURATION_UNITS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
})

/** Result of {@link checkDuration}. */
export type DurationResult =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly message: string; readonly hint: string | undefined }

/** Unit spellings people write, and the unit they mean. */
const UNIT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  msec: 'ms',
  msecs: 'ms',
  millis: 'ms',
  millisecond: 'ms',
  milliseconds: 'ms',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  min: 'm',
  mins: 'm',
  minute: 'm',
  minutes: 'm',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  day: 'd',
  days: 'd',
})

const UNITS_LIST = '(ms, s, m, h, d)'

/**
 * Converts a duration to milliseconds: a non-negative integer number of milliseconds once converted,
 * at most 366 days. Never throws.
 */
export function checkDuration(value: unknown): DurationResult {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return invalid(`${String(value)} is not a duration: use a non-negative number of milliseconds`)
    }
    if (!Number.isInteger(value)) return invalid(`${value} is not a whole number of milliseconds`)
    return bounded(value, String(value))
  }
  if (typeof value !== 'string') {
    return invalid(
      `expected a duration (milliseconds, or a string such as '30s'), got ${value === null ? 'null' : typeof value}`,
    )
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value)
  if (match === null) return invalid(`'${value}' is not a duration: ${suggest(value)}`)
  const amount = Number(match[1])
  const unit = DURATION_UNITS[match[2] as string] as number
  const ms = Math.round(amount * unit * 1000) / 1000
  if (!Number.isInteger(ms)) return invalid(`'${value}' is not a whole number of milliseconds`)
  return bounded(ms, `'${value}'`)
}

/** `'1m'`, `'1.5h'`, `'500ms'`: the largest unit giving at most one decimal. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms)
  for (const unit of ['d', 'h', 'm', 's'] as const) {
    const size = DURATION_UNITS[unit] as number
    if (ms < size) continue
    const amount = ms / size
    if (Number.isInteger(amount * 10)) return `${amount}${unit}`
  }
  return `${ms}ms`
}

function bounded(ms: number, written: string): DurationResult {
  if (ms > MAX_DURATION_MS) {
    return invalid(`${written} is longer than 366 days`, 'Durations go up to 366 days; use @Cron for longer periods')
  }
  return { ok: true, ms }
}

/** "use '5m' (ms, s, m, h, d)" for `'5 min'`, `'5mins'`, `'5'`... */
function suggest(value: string): string {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z]*)\s*$/.exec(value)
  if (match === null) return `use a number of milliseconds or a number with a unit ${UNITS_LIST}`
  const amount = match[1] as string
  const written = (match[2] as string).toLowerCase()
  if (amount.startsWith('-')) return 'durations are non-negative'
  if (written === '') return `add a unit: '${amount}ms', '${amount}s'... ${UNITS_LIST}`
  const unit = DURATION_UNITS[written] === undefined ? UNIT_ALIASES[written] : written
  if (unit !== undefined) return `use '${amount}${unit}' ${UNITS_LIST}`
  return `unknown unit '${match[2]}' ${UNITS_LIST}`
}

function invalid(message: string, hint?: string): DurationResult {
  return { ok: false, message, hint }
}
