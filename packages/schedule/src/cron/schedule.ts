/**
 * Occurrences of a parsed cron expression in a time zone (RFC 0004 §4.4, §7.2, §7.3). This module is
 * **pure** (it only imports other pure modules of `src/cron/`).
 *
 * Expressions are evaluated on the wall clock of the zone. `next(after)` walks candidate days, then
 * hours, minutes and seconds, skipping with per-field lookup tables, then turns the wall time back
 * into an instant with the offset of the segment (the interval between two offset transitions) it
 * falls in. Daylight saving time rules (normative):
 *
 * - **gap** (spring forward): a matching wall time that does not exist fires once, at the first
 *   instant after the gap; occurrences falling on the same instant fire once;
 * - **fold** (fall back): a wall time that exists twice fires at its first occurrence only, unless
 *   the hour field matches every hour (`*`, `0-23`, `*∕1`): then the repeated hour fires again.
 */
import type { CronSpec } from './parse.ts'
import type { TimeZone } from './zone.ts'

import { civilFromDays, daysFromCivil, daysInMonth, weekdayOfDays } from './fields.ts'

/** Search horizon of {@link CronEngine.next}: 400 years (one Gregorian cycle). */
export const HORIZON_MS: number = 146_097 * 86_400_000

const DAY = 86_400_000
const DAY_SECONDS = 86_400
/** Upper bound of the transitions crossed by one `next()` call (DST zones have two a year). */
const MAX_SEGMENTS = 4096

/** A compiled cron expression bound to a time zone. */
export interface CronEngine {
  readonly spec: CronSpec
  readonly zone: TimeZone
  /** The first occurrence strictly after `after` (epoch ms), `undefined` within 400 years. */
  next(after: number): number | undefined
  /** Whether `instant` (epoch ms) is an occurrence. */
  matches(instant: number): boolean
}

/** Binds a parsed expression to a time zone. */
export function compileCron(spec: CronSpec, zone: TimeZone): CronEngine {
  const matcher = new WallMatcher(spec)
  return {
    spec,
    zone,
    next: after => nextOccurrence(matcher, zone, spec.everyHour, after),
    matches(instant) {
      if (!Number.isFinite(instant) || instant % 1000 !== 0) return false
      return nextOccurrence(matcher, zone, spec.everyHour, instant - 1) === instant
    },
  }
}

function nextOccurrence(matcher: WallMatcher, zone: TimeZone, everyHour: boolean, after: number): number | undefined {
  if (!Number.isFinite(after)) return undefined
  let from = Math.floor(after / 1000) * 1000 + 1000
  const horizon = after + HORIZON_MS
  const limit = Math.floor((horizon + 2 * DAY) / 1000)
  for (let segment = 0; segment < MAX_SEGMENTS; segment++) {
    const offset = zone.offsetAt(from)
    let wallFrom = from + offset
    if (!everyHour && !zone.fixed) {
      // inside the second pass of a fold: wall times already reached do not fire again
      const fold = zone.lastTransition(from - DAY, from)
      if (fold !== undefined && fold.before > fold.after) wallFrom = Math.max(wallFrom, fold.at + fold.before)
    }
    const wall = matcher.next(Math.ceil(wallFrom / 1000), limit)
    if (wall < 0) return undefined
    const candidate = wall * 1000 - offset
    if (candidate > horizon) return undefined
    const transition = zone.fixed ? undefined : zone.firstTransition(from, candidate)
    if (transition === undefined) return candidate
    // the wall time falls in a gap opened by the transition: it fires when the gap ends
    if (transition.after > transition.before && wall * 1000 < transition.at + transition.after) return transition.at
    from = transition.at
  }
  return undefined
}

/** Matching on naive wall-clock seconds (no zone). */
class WallMatcher {
  readonly #seconds: Int8Array
  readonly #minutes: Int8Array
  readonly #hours: Int8Array
  readonly #months: Int8Array
  readonly #firstSecond: number
  readonly #firstMinute: number
  readonly #spec: CronSpec

  constructor(spec: CronSpec) {
    this.#spec = spec
    this.#seconds = nextTable(spec.seconds)
    this.#minutes = nextTable(spec.minutes)
    this.#hours = nextTable(spec.hours)
    this.#months = nextTable(spec.months)
    this.#firstSecond = this.#seconds[0] as number
    this.#firstMinute = this.#minutes[0] as number
  }

  /** The first matching wall second `>= from`, or `-1` beyond `limit`. */
  next(from: number, limit: number): number {
    let days = Math.floor(from / DAY_SECONDS)
    let time = from - days * DAY_SECONDS
    const lastDay = Math.floor(limit / DAY_SECONDS)
    const firstMonth = this.#months[1] as number
    if (firstMonth < 0) return -1
    while (days <= lastDay) {
      const { year, month, day } = civilFromDays(days)
      if (this.#spec.months[month] !== 1) {
        const following = this.#months[month + 1] as number
        days = following < 0 ? daysFromCivil(year + 1, firstMonth, 1) : daysFromCivil(year, following, 1)
        time = 0
        continue
      }
      if (this.#dayMatches(year, month, day, weekdayOfDays(days))) {
        const found = this.#timeOfDay(time)
        if (found >= 0) return days * DAY_SECONDS + found
      }
      days++
      time = 0
    }
    return -1
  }

  #dayMatches(year: number, month: number, day: number, weekday: number): boolean {
    const spec = this.#spec
    if (!spec.dayOfMonthRestricted && !spec.dayOfWeekRestricted) return true
    const length = daysInMonth(year, month)
    const dom = spec.days[day] === 1 || (spec.lastDay && day === length)
    if (spec.dayOfMonthRestricted && !spec.dayOfWeekRestricted) return dom
    const nth = spec.nthWeekdays[weekday] as number
    const dow =
      spec.weekdays[weekday] === 1 ||
      (nth !== 0 && ((nth >> Math.floor((day - 1) / 7)) & 1) === 1) ||
      (spec.lastWeekdays[weekday] === 1 && day + 7 > length)
    if (!spec.dayOfMonthRestricted) return dow
    return dom || dow
  }

  /** The first matching second of the day `>= time`, or `-1`. */
  #timeOfDay(time: number): number {
    let hour = Math.floor(time / 3600)
    let minute = Math.floor((time % 3600) / 60)
    let second = time % 60
    for (;;) {
      const nextHour = this.#hours[hour] as number
      if (nextHour < 0) return -1
      if (nextHour !== hour) return nextHour * 3600 + this.#firstMinute * 60 + this.#firstSecond
      const nextMinute = this.#minutes[minute] as number
      if (nextMinute < 0) {
        hour++
        minute = 0
        second = 0
        continue
      }
      if (nextMinute !== minute) return hour * 3600 + nextMinute * 60 + this.#firstSecond
      const nextSecond = this.#seconds[second] as number
      if (nextSecond >= 0) return hour * 3600 + minute * 60 + nextSecond
      minute++
      second = 0
    }
  }
}

/** `table[v]` is the smallest allowed value `>= v`, or `-1` (one extra slot past the maximum). */
function nextTable(values: Uint8Array): Int8Array {
  const table = new Int8Array(values.length + 1)
  table[values.length] = -1
  for (let index = values.length - 1; index >= 0; index--) {
    table[index] = values[index] === 1 ? index : (table[index + 1] as number)
  }
  return table
}
