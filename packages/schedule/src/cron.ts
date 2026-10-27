/**
 * Public API of the cron engine (RFC 0004 §4.3): applications validate user input with the rules the
 * compiler and the scheduler use.
 *
 * ```ts
 * const schedule = parseCron('0 8 * * MON-FRI', { timeZone: 'Europe/Paris' })
 * schedule.next(new Date('2026-10-27T10:00:00Z')) // 2026-10-28T07:00:00.000Z
 * schedule.nextRuns(3) // the next three occurrences after now
 * parseDuration('1.5h') // 5_400_000
 * ```
 */
import type { CronEngine } from './cron/schedule.ts'
import type { TimeZone } from './cron/zone.ts'

import { neverFires } from './cron/analysis.ts'
import { FIELDS_HINT } from './cron/fields.ts'
import { parseCronSpec } from './cron/parse.ts'
import { compileCron } from './cron/schedule.ts'
import { knownTimeZones, resolveTimeZone } from './cron/zone.ts'
import { checkDuration } from './duration.ts'
import { InvalidScheduleError } from './errors.ts'
import { closest } from './names.ts'

/** Options of {@link parseCron}. */
export interface ParseCronOptions {
  /** IANA name, `'UTC'`, a fixed offset (`'+05:30'`) or `'local'`. Default `'UTC'`. */
  readonly timeZone?: string
}

/** A validated cron expression bound to a time zone. */
export interface CronSchedule {
  /** As written. */
  readonly expression: string
  /** As written (`'local'` is resolved once, when parsing). */
  readonly timeZone: string
  /** The first occurrence strictly after `after` (default: now), `undefined` within 400 years. */
  next(after?: Date | number): Date | undefined
  /** The next `count` occurrences after `from` (default: now). */
  nextRuns(count: number, from?: Date | number): Date[]
  /** Whether `date` is an occurrence (DST rules included). */
  matches(date: Date | number): boolean
}

/**
 * Parses and validates a cron expression: 5 or 6 fields or a nickname, a known time zone, and an
 * expression that fires at least once in the proleptic Gregorian calendar.
 *
 * @throws InvalidScheduleError (ZNIGHT040) with `field`, `start` and `end` for field-level problems.
 */
export function parseCron(expression: string, options: ParseCronOptions = {}): CronSchedule {
  const engine = compileExpression(expression, options.timeZone ?? 'UTC')
  return new Schedule(engine)
}

/**
 * Converts a duration to milliseconds: a number of milliseconds, or a number with one unit (`'500ms'`,
 * `'30s'`, `'5m'`, `'1.5h'`, `'1d'`). A non-negative integer number of milliseconds, at most 366 days.
 *
 * @throws InvalidScheduleError (ZNIGHT040).
 */
export function parseDuration(value: number | string): number {
  const result = checkDuration(value)
  if (!result.ok)
    throw new InvalidScheduleError(result.message, result.hint === undefined ? {} : { hints: [result.hint] })
  return result.ms
}

/** Internal: validates and compiles an expression (ZNIGHT040). */
export function compileExpression(expression: string, timeZone: string, label = 'Invalid cron expression'): CronEngine {
  const parsed = parseCronSpec(expression)
  if (!parsed.ok) {
    const issue = parsed.issue
    throw new InvalidScheduleError(`${label} '${String(expression)}': ${issue.message}`, {
      field: issue.field,
      start: issue.start,
      end: issue.end,
      hints: [issue.hint ?? FIELDS_HINT],
    })
  }
  const never = neverFires(parsed.spec)
  if (never !== undefined) {
    throw new InvalidScheduleError(`Cron expression '${expression}' ${never.message}`, {
      field: never.field,
      start: never.start,
      end: never.end,
      hints: [never.hint],
    })
  }
  return compileCron(parsed.spec, zoneOrThrow(timeZone))
}

/** Internal: resolves a time zone with this runtime's `Intl` (ZNIGHT040 with a suggestion). */
export function zoneOrThrow(name: string, label = 'Invalid time zone'): TimeZone {
  const result = resolveTimeZone(name)
  if (result.ok) return result.zone
  const suggestion = result.unknown ? closest(name, knownTimeZones()) : undefined
  throw new InvalidScheduleError(
    `${label}: ${result.message}${suggestion === undefined ? '' : ` (did you mean '${suggestion}'?)`}`,
    { hints: ["Use an IANA name ('Europe/Paris'), 'UTC', a fixed offset ('+05:30') or 'local'"] },
  )
}

class Schedule implements CronSchedule {
  readonly #engine: CronEngine

  constructor(engine: CronEngine) {
    this.#engine = engine
  }

  get expression(): string {
    return this.#engine.spec.expression
  }

  get timeZone(): string {
    return this.#engine.zone.name
  }

  next(after: Date | number = Date.now()): Date | undefined {
    const next = this.#engine.next(instant(after, 'next'))
    return next === undefined ? undefined : new Date(next)
  }

  nextRuns(count: number, from: Date | number = Date.now()): Date[] {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new InvalidScheduleError(`nextRuns(count): count must be a non-negative integer, got ${String(count)}`)
    }
    const runs: Date[] = []
    let cursor = instant(from, 'nextRuns')
    for (let index = 0; index < count; index++) {
      const next = this.#engine.next(cursor)
      if (next === undefined) break
      runs.push(new Date(next))
      cursor = next
    }
    return runs
  }

  matches(date: Date | number): boolean {
    return this.#engine.matches(instant(date, 'matches'))
  }
}

function instant(value: Date | number, method: string): number {
  const time = value instanceof Date ? value.getTime() : value
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new InvalidScheduleError(`${method}(): expected a valid Date or epoch milliseconds, got ${String(value)}`)
  }
  return time
}
