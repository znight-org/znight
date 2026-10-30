import type { CronIssue, CronSpec } from '../../src/cron/parse.ts'

import { parseCronSpec } from '../../src/cron/parse.ts'
import { compileCron } from '../../src/cron/schedule.ts'
import { resolveTimeZone } from '../../src/cron/zone.ts'

/** Parses an expression that must be valid. */
export function spec(expression: string): CronSpec {
  const result = parseCronSpec(expression)
  if (!result.ok) throw new Error(`unexpected issue in '${expression}': ${result.issue.message}`)
  return result.spec
}

/** The issue of an expression that must be invalid. */
export function issue(expression: string): CronIssue {
  const result = parseCronSpec(expression)
  if (result.ok) throw new Error(`expected '${expression}' to be invalid`)
  return result.issue
}

/** The text an issue points at. */
export function pointed(expression: string): string {
  const found = issue(expression)
  return expression.slice(found.start, found.end)
}

/** Allowed values of a bitset. */
export function values(bits: Uint8Array): number[] {
  const result: number[] = []
  for (let index = 0; index < bits.length; index++) if (bits[index] === 1) result.push(index)
  return result
}

/** The next `count` occurrences after `from`, as ISO strings. */
export function runs(expression: string, from: string, count: number, timeZone = 'UTC'): string[] {
  const zone = resolveTimeZone(timeZone)
  if (!zone.ok) throw new Error(zone.message)
  const engine = compileCron(spec(expression), zone.zone)
  const result: string[] = []
  let cursor = Date.parse(from)
  for (let index = 0; index < count; index++) {
    const next = engine.next(cursor)
    if (next === undefined) break
    result.push(new Date(next).toISOString())
    cursor = next
  }
  return result
}

/** Every occurrence in `[from, to)`, as ISO strings. */
export function between(expression: string, from: string, to: string, timeZone = 'UTC'): string[] {
  const zone = resolveTimeZone(timeZone)
  if (!zone.ok) throw new Error(zone.message)
  const engine = compileCron(spec(expression), zone.zone)
  const end = Date.parse(to)
  const result: string[] = []
  let cursor = Date.parse(from) - 1
  for (;;) {
    const next = engine.next(cursor)
    if (next === undefined || next >= end) break
    result.push(new Date(next).toISOString())
    cursor = next
  }
  return result
}
