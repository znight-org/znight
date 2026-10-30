/**
 * Differential test of the built-in engine against croner (RFC 0004 §8, §12.2): fast-check generates
 * expressions (without `W`, years or `?`, in croner's OR mode), zones and instants; `next()` must equal
 * croner's `nextRun()`. Divergences fall in two classes, each checked and listed, never silenced:
 *
 * - `dst-gap`: the engine fires the occurrences of a spring gap once, when the gap ends (RFC 0004
 *   §4.4); croner does so only for "fixed-time" patterns (single second, minute and hour) and skips
 *   them for the others. Checked: the engine's answer is the end of a gap.
 * - `croner-february`: croner misses the first occurrences of March when its search starts in
 *   February (in the zone). Checked: the engine's answer is independently verified to match (wall
 *   fields read through `Intl`), and croner's answer is later.
 *
 * Anything else fails the test. `ZNIGHT_DIFFERENTIAL_RUNS` raises the number of generated expressions
 * (default 1500, 20 instants each); `ZNIGHT_DIFFERENTIAL_SEED` changes the seed.
 */
import type { CronSpec } from '../../src/cron/parse.ts'
import type { TimeZone } from '../../src/cron/zone.ts'

import { Cron } from 'croner'
import fc from 'fast-check'

import { neverFires } from '../../src/cron/analysis.ts'
import { daysInMonth } from '../../src/cron/fields.ts'
import { parseCronSpec } from '../../src/cron/parse.ts'
import { compileCron } from '../../src/cron/schedule.ts'
import { resolveTimeZone } from '../../src/cron/zone.ts'
import { describe, expect, test as it } from 'bun:test'

const ZONES = [
  'UTC',
  'Europe/Paris',
  'Europe/London',
  'America/New_York',
  'America/Sao_Paulo',
  'America/Santiago',
  'Australia/Lord_Howe',
  'Australia/Sydney',
  'Asia/Kathmandu',
  'Asia/Tokyo',
  'Pacific/Chatham',
  '+05:30',
] as const

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/** One item of a numeric field: value, range, step, range with step, start with step. */
function item(min: number, max: number, names?: readonly string[]): fc.Arbitrary<string> {
  const number = fc.integer({ min, max }).map(String)
  const value =
    names === undefined
      ? number
      : fc.oneof(
          number,
          fc.integer({ min, max }).map(n => names[n - min] as string),
        )
  const size = max - min + 1
  const pair = fc
    .tuple(fc.integer({ min, max }), fc.integer({ min, max }))
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const)
  return fc.oneof(
    { weight: 2, arbitrary: value },
    { weight: 2, arbitrary: pair.map(([a, b]) => `${a}-${b}`) },
    { weight: 2, arbitrary: fc.integer({ min: 1, max: size }).map(step => `*/${step}`) },
    {
      weight: 1,
      arbitrary: fc.tuple(pair, fc.integer({ min: 1, max: size })).map(([[a, b], step]) => `${a}-${b}/${step}`),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.integer({ min, max }), fc.integer({ min: 1, max: size }))
        .map(([a, step]) => `${a}/${step}`),
    },
  )
}

function field(items: fc.Arbitrary<string>, star: number): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: star, arbitrary: fc.constant('*') },
    { weight: 6, arbitrary: fc.array(items, { minLength: 1, maxLength: 3 }).map(list => list.join(',')) },
  )
}

const dayOfWeekItem: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 7 }).map(String) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 6 }).map(day => DAYS[day] as string) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 6 }))
      .map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`),
  },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 7 }).map(step => `*/${step}`) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 6 }).map(day => `${day}L`) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 5 }))
      .map(([day, n]) => `${day}#${n}`),
  },
)

const dayOfMonthItem: fc.Arbitrary<string> = fc.oneof(
  { weight: 8, arbitrary: item(1, 31) },
  { weight: 1, arbitrary: fc.constant('L') },
)

const expression: fc.Arbitrary<string> = fc
  .record({
    second: fc.oneof({ weight: 3, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: field(item(0, 59), 1) }),
    minute: field(item(0, 59), 1),
    hour: field(item(0, 23), 3),
    dayOfMonth: field(dayOfMonthItem, 5),
    month: field(item(1, 12, MONTHS), 6),
    dayOfWeek: field(dayOfWeekItem, 5),
  })
  .map(fields =>
    [fields.second, fields.minute, fields.hour, fields.dayOfMonth, fields.month, fields.dayOfWeek]
      .filter(part => part !== undefined)
      .join(' '),
  )

const instant: fc.Arbitrary<number> = fc.integer({
  min: Date.parse('2000-01-01T00:00:00Z'),
  max: Date.parse('2040-01-01T00:00:00Z'),
})

const RUNS = Number(process.env['ZNIGHT_DIFFERENTIAL_RUNS'] ?? 1500)
const SEED = Number(process.env['ZNIGHT_DIFFERENTIAL_SEED'] ?? 20_261_027)

interface Divergence {
  readonly expression: string
  readonly zone: string
  readonly after: string
  readonly engine: string | undefined
  readonly croner: string | undefined
}

type DivergenceClass = 'dst-gap' | 'croner-february'

interface WallFields {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly weekday: number
}

function offsetMinutes(zone: string): number | undefined {
  if (!/^[+-]\d{2}:\d{2}$/.test(zone)) return undefined
  return (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)))
}

function cronerNext(pattern: string, timeZone: string, after: number): number | undefined {
  const offset = offsetMinutes(timeZone)
  const options = offset === undefined ? { timezone: timeZone } : { utcOffset: offset }
  const next = new Cron(pattern, { ...options, paused: true, sloppyRanges: true, mode: '5-or-6-parts' }).nextRun(
    new Date(after),
  )
  return next === null ? undefined : next.getTime()
}

/** Wall-clock fields of an instant in a zone, read through `Intl` (independent of the engine). */
function wall(zone: string, at: number): WallFields {
  const offset = offsetMinutes(zone)
  if (offset !== undefined) {
    const date = new Date(at + offset * 60_000)
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      weekday: date.getUTCDay(),
    }
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
  }).formatToParts(at)
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: DAYS.indexOf(get('weekday').toUpperCase()),
  }
}

/** Whether the wall time of `at` matches the expression (a naive matcher, OR rule included). */
function matchesWall(spec: CronSpec, zone: string, at: number): boolean {
  const fields = wall(zone, at)
  const length = daysInMonth(fields.year, fields.month)
  const nth = spec.nthWeekdays[fields.weekday] as number
  const dom = spec.days[fields.day] === 1 || (spec.lastDay && fields.day === length)
  const dow =
    spec.weekdays[fields.weekday] === 1 ||
    ((nth >> Math.floor((fields.day - 1) / 7)) & 1) === 1 ||
    (spec.lastWeekdays[fields.weekday] === 1 && fields.day + 7 > length)
  let day = true
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) day = dom || dow
  else if (spec.dayOfMonthRestricted) day = dom
  else if (spec.dayOfWeekRestricted) day = dow
  return (
    day &&
    spec.months[fields.month] === 1 &&
    spec.hours[fields.hour] === 1 &&
    spec.minutes[fields.minute] === 1 &&
    spec.seconds[fields.second] === 1
  )
}

function classify(
  spec: CronSpec,
  zone: TimeZone,
  zoneName: string,
  after: number,
  ours: number | undefined,
  theirs: number | undefined,
): DivergenceClass | undefined {
  if (ours === undefined || (theirs !== undefined && theirs < ours)) return undefined
  const transition = zone.firstTransition(ours - 1, ours)
  if (transition !== undefined && transition.at === ours && transition.after > transition.before) return 'dst-gap'
  if (wall(zoneName, after).month === 2 && wall(zoneName, ours).month === 3 && matchesWall(spec, zoneName, ours)) {
    return 'croner-february'
  }
  return undefined
}

describe('differential test against croner', () => {
  it(`agrees with croner on ${RUNS} expressions × 20 instants, but for the listed classes`, () => {
    const unexplained: Divergence[] = []
    const explained: Record<DivergenceClass, number> = { 'dst-gap': 0, 'croner-february': 0 }
    let compared = 0
    fc.assert(
      fc.property(
        expression,
        fc.constantFrom(...ZONES),
        fc.array(instant, { minLength: 20, maxLength: 20 }),
        (pattern, zoneName, instants) => {
          const parsed = parseCronSpec(pattern)
          if (!parsed.ok) throw new Error(`generated an invalid expression '${pattern}': ${parsed.issue.message}`)
          if (neverFires(parsed.spec) !== undefined) return
          const resolved = resolveTimeZone(zoneName)
          if (!resolved.ok) throw new Error(resolved.message)
          const engine = compileCron(parsed.spec, resolved.zone)
          for (const after of instants) {
            compared++
            const ours = engine.next(after)
            const theirs = cronerNext(pattern, zoneName, after)
            if (ours === theirs) continue
            const found = classify(parsed.spec, resolved.zone, zoneName, after, ours, theirs)
            if (found !== undefined) {
              explained[found]++
              continue
            }
            unexplained.push({
              expression: pattern,
              zone: zoneName,
              after: new Date(after).toISOString(),
              engine: ours === undefined ? undefined : new Date(ours).toISOString(),
              croner: theirs === undefined ? undefined : new Date(theirs).toISOString(),
            })
          }
        },
      ),
      { numRuns: RUNS, seed: SEED },
    )
    expect(unexplained.slice(0, 10)).toEqual([])
    expect(compared).toBeGreaterThan(RUNS * 15)
    // both classes are rare: transitions and February only
    expect(explained['dst-gap'] + explained['croner-february']).toBeLessThan(compared / 200)
  }, 300_000)

  it('dst-gap: the engine fires a gap occurrence when the gap ends, croner skips it (not a fixed time)', () => {
    const parsed = parseCronSpec('9/9 * 4 * *')
    const zone = resolveTimeZone('America/Sao_Paulo')
    if (!parsed.ok || !zone.ok) throw new Error('invalid')
    const after = Date.parse('2018-10-19T12:36:44Z')
    // 2018-11-04 00:00 did not exist in Sao Paulo: 00:09 fires at 01:00 -02:00 (03:00Z)
    expect(new Date(compileCron(parsed.spec, zone.zone).next(after) ?? 0).toISOString()).toBe(
      '2018-11-04T03:00:00.000Z',
    )
    expect(new Date(cronerNext('9/9 * 4 * *', 'America/Sao_Paulo', after) ?? 0).toISOString()).toBe(
      '2018-11-04T03:09:00.000Z',
    )
  })

  it('croner-february: croner misses March 1 when its search starts in February', () => {
    const pattern = '* 23/8,12/15 */6,18-27/18 * *'
    const parsed = parseCronSpec(pattern)
    const zone = resolveTimeZone('Europe/London')
    if (!parsed.ok || !zone.ok) throw new Error('invalid')
    const after = Date.parse('2002-02-28T13:53:38Z')
    const ours = compileCron(parsed.spec, zone.zone).next(after) ?? 0
    expect(new Date(ours).toISOString()).toBe('2002-03-01T12:00:00.000Z')
    expect(matchesWall(parsed.spec, 'Europe/London', ours)).toBe(true)
    expect(new Date(cronerNext(pattern, 'Europe/London', after) ?? 0).toISOString()).toBe('2002-03-07T12:00:00.000Z')
  })

  it('agrees with croner on the DST rules of RFC 0004 §4.4 (Europe/Paris)', () => {
    for (const [pattern, from] of [
      ['30 2 * * *', '2027-03-27T00:00:00Z'],
      ['*/30 * * * *', '2027-03-27T23:45:00Z'],
      ['30 2 * * *', '2026-10-24T00:00:00Z'],
      ['*/30 * * * *', '2026-10-24T23:45:00Z'],
    ] as const) {
      const parsed = parseCronSpec(pattern)
      const zone = resolveTimeZone('Europe/Paris')
      if (!parsed.ok || !zone.ok) throw new Error('invalid')
      const engine = compileCron(parsed.spec, zone.zone)
      let ours = Date.parse(from)
      let theirs = ours
      for (let index = 0; index < 6; index++) {
        ours = engine.next(ours) ?? 0
        theirs = cronerNext(pattern, 'Europe/Paris', theirs) ?? 0
        expect(new Date(ours).toISOString()).toBe(new Date(theirs).toISOString())
      }
    }
  })
})
