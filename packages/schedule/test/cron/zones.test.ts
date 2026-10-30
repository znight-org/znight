/**
 * Time zones and daylight saving time (RFC 0004 §4.4). The expected values are part of the tests:
 * gaps fire once at the end of the gap, folds fire at their first occurrence unless the hour field
 * matches every hour.
 */
import { compileCron } from '../../src/cron/schedule.ts'
import { resolveTimeZone, zoneCacheSizes } from '../../src/cron/zone.ts'
import { between, runs, spec } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

describe('Europe/Paris', () => {
  const zone = 'Europe/Paris'

  it('spring gap (2027-03-28): a missing wall time fires once, when the gap ends', () => {
    expect(between('30 2 * * *', '2027-03-27T00:00:00Z', '2027-03-30T00:00:00Z', zone)).toEqual([
      '2027-03-27T01:30:00.000Z', // 02:30 CET
      '2027-03-28T01:00:00.000Z', // 02:30 does not exist: 03:00 CEST
      '2027-03-29T00:30:00.000Z', // 02:30 CEST
    ])
  })

  it('spring gap: sub-hourly jobs keep running every N minutes of real time', () => {
    expect(between('*/30 * * * *', '2027-03-27T23:30:00Z', '2027-03-28T02:00:00Z', zone)).toEqual([
      '2027-03-27T23:30:00.000Z',
      '2027-03-28T00:00:00.000Z',
      '2027-03-28T00:30:00.000Z',
      '2027-03-28T01:00:00.000Z', // 02:00 and 02:30 do not exist: once, at 03:00 CEST
      '2027-03-28T01:30:00.000Z',
    ])
    expect(between('0 * * * *', '2027-03-27T23:00:00Z', '2027-03-28T03:00:00Z', zone)).toEqual([
      '2027-03-27T23:00:00.000Z',
      '2027-03-28T00:00:00.000Z',
      '2027-03-28T01:00:00.000Z',
      '2027-03-28T02:00:00.000Z',
    ])
  })

  it('autumn fold (2026-10-25): a repeated wall time fires at its first occurrence', () => {
    expect(between('30 2 * * *', '2026-10-24T00:00:00Z', '2026-10-27T00:00:00Z', zone)).toEqual([
      '2026-10-24T00:30:00.000Z', // 02:30 CEST
      '2026-10-25T00:30:00.000Z', // 02:30 CEST, not 02:30 CET
      '2026-10-26T01:30:00.000Z', // 02:30 CET
    ])
    expect(between('0 1-3 * * *', '2026-10-24T22:00:00Z', '2026-10-25T03:00:00Z', zone)).toEqual([
      '2026-10-24T23:00:00.000Z', // 01:00 CEST
      '2026-10-25T00:00:00.000Z', // 02:00 CEST
      '2026-10-25T02:00:00.000Z', // 03:00 CET (02:00 CET does not fire again)
    ])
  })

  it('autumn fold: an every-hour job fires again in the repeated hour', () => {
    expect(between('*/30 * * * *', '2026-10-24T23:00:00Z', '2026-10-25T02:30:00Z', zone)).toEqual([
      '2026-10-24T23:00:00.000Z',
      '2026-10-24T23:30:00.000Z',
      '2026-10-25T00:00:00.000Z', // 02:00 CEST
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:00:00.000Z', // 02:00 CET
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ])
  })

  it('weekdays at 08:00 follow the switch (RFC §4.8 example)', () => {
    expect(between('0 8 * * MON-FRI', '2027-03-26T06:00:00Z', '2027-03-30T07:00:00Z', zone)).toEqual([
      '2027-03-26T07:00:00.000Z', // Friday, CET
      '2027-03-29T06:00:00.000Z', // Monday, CEST
      '2027-03-30T06:00:00.000Z',
    ])
  })

  it('starts the search inside the second pass of a fold', () => {
    // 01:10Z is 02:10 CET (second pass): 02:30 already fired at 00:30Z
    expect(between('30 2 * * *', '2026-10-25T01:10:00Z', '2026-10-27T00:00:00Z', zone)).toEqual([
      '2026-10-26T01:30:00.000Z',
    ])
    expect(between('*/30 * * * *', '2026-10-25T01:10:00Z', '2026-10-25T02:01:00Z', zone)).toEqual([
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ])
  })
})

describe('America/New_York', () => {
  const zone = 'America/New_York'

  it('2026-03-08: 02:30 does not exist and fires at 03:00 EDT', () => {
    expect(between('30 2 * * *', '2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z', zone)).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ])
  })

  it('2026-11-01: 01:30 exists twice and fires once; every-hour jobs fire in both passes', () => {
    expect(between('30 1 * * *', '2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z', zone)).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ])
    expect(between('*/30 * * * *', '2026-11-01T04:30:00Z', '2026-11-01T07:01:00Z', zone)).toEqual([
      '2026-11-01T04:30:00.000Z',
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:00:00.000Z',
    ])
  })
})

describe('Australia/Lord_Howe (30-minute DST)', () => {
  const zone = 'Australia/Lord_Howe'

  it('2026-04-05: 01:30-02:00 repeats; 01:45 fires once', () => {
    expect(between('45 1 * * *', '2026-04-03T00:00:00Z', '2026-04-06T00:00:00Z', zone)).toEqual([
      '2026-04-03T14:45:00.000Z', // 01:45 +11:00
      '2026-04-04T14:45:00.000Z', // first pass, +11:00
      '2026-04-05T15:15:00.000Z', // 01:45 +10:30
    ])
    expect(between('*/10 * * * *', '2026-04-04T14:30:00Z', '2026-04-04T15:31:00Z', zone)).toEqual([
      '2026-04-04T14:30:00.000Z',
      '2026-04-04T14:40:00.000Z',
      '2026-04-04T14:50:00.000Z',
      '2026-04-04T15:00:00.000Z',
      '2026-04-04T15:10:00.000Z',
      '2026-04-04T15:20:00.000Z',
      '2026-04-04T15:30:00.000Z',
    ])
  })

  it('2026-10-04: 02:00-02:30 does not exist; 02:15 fires at 02:30 +11:00', () => {
    expect(between('15 2 * * *', '2026-10-02T00:00:00Z', '2026-10-05T00:00:00Z', zone)).toEqual([
      '2026-10-02T15:45:00.000Z',
      '2026-10-03T15:30:00.000Z',
      '2026-10-04T15:15:00.000Z',
    ])
  })
})

describe('other zones', () => {
  it('Asia/Kathmandu (+05:45)', () => {
    expect(between('0 9 * * *', '2026-06-01T00:00:00Z', '2026-06-03T00:00:00Z', 'Asia/Kathmandu')).toEqual([
      '2026-06-01T03:15:00.000Z',
      '2026-06-02T03:15:00.000Z',
    ])
  })

  it('America/Sao_Paulo: a DST switch at midnight (2018), none since 2019', () => {
    expect(between('0 0 * * *', '2018-11-03T00:00:00Z', '2018-11-06T00:00:00Z', 'America/Sao_Paulo')).toEqual([
      '2018-11-03T03:00:00.000Z',
      '2018-11-04T03:00:00.000Z', // 00:00 did not exist: 01:00 -02:00
      '2018-11-05T02:00:00.000Z',
    ])
    expect(between('0 0 * * *', '2026-11-03T00:00:00Z', '2026-11-06T00:00:00Z', 'America/Sao_Paulo')).toEqual([
      '2026-11-03T03:00:00.000Z',
      '2026-11-04T03:00:00.000Z',
      '2026-11-05T03:00:00.000Z',
    ])
  })

  it('Pacific/Apia: 2011-12-30 was skipped; its occurrence fires when the gap ends', () => {
    expect(between('0 12 * * *', '2011-12-29T00:00:00Z', '2011-12-31T00:00:00Z', 'Pacific/Apia')).toEqual([
      '2011-12-29T22:00:00.000Z', // Dec 29 12:00 -10:00
      '2011-12-30T10:00:00.000Z', // Dec 30 did not exist: Dec 31 00:00 +14:00
      '2011-12-30T22:00:00.000Z', // Dec 31 12:00 +14:00
    ])
  })

  it('fixed offsets and UTC skip Intl', () => {
    expect(between('0 9 * * *', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', '+05:30')).toEqual([
      '2026-06-01T03:30:00.000Z',
    ])
    expect(between('0 9 * * *', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', '-03')).toEqual([
      '2026-06-01T12:00:00.000Z',
    ])
    expect(between('0 9 * * *', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', '+0545')).toEqual([
      '2026-06-01T03:15:00.000Z',
    ])
    for (const name of ['UTC', '+05:30', '-03']) {
      const zone = resolveTimeZone(name)
      expect(zone.ok && zone.zone.fixed).toBe(true)
    }
  })
})

describe('a search starting in the last second before a gap', () => {
  /** Wall clock of an instant (ms, read as UTC) through `Intl`: independent of the engine. */
  function wallClock(zone: string): (at: number) => number {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    return at => {
      const parts: Record<string, number> = {}
      for (const part of format.formatToParts(at)) parts[part.type] = Number(part.value)
      return Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day, parts.hour, parts.minute, parts.second)
    }
  }

  /**
   * Brute-force gap rule (RFC 0004 §4.4), second by second, for windows without a fold: the first
   * second after `after` whose wall time matches, or that ends a gap skipping a matching wall time.
   */
  function reference(wall: (at: number) => number, matches: (wall: Date) => boolean, after: number): number {
    for (let at = Math.floor(after / 1000) * 1000 + 1000; at <= after + 3 * 3_600_000; at += 1000) {
      const current = wall(at)
      for (let skipped = wall(at - 1000) + 1000; skipped < current; skipped += 1000) {
        if (matches(new Date(skipped))) return at
      }
      if (matches(new Date(current))) return at
    }
    throw new Error('no occurrence within 3 hours')
  }

  const EXPRESSIONS: readonly (readonly [string, (wall: Date) => boolean])[] = [
    ['* * 1,2 * * *', wall => wall.getUTCHours() === 1 || wall.getUTCHours() === 2],
    ['0,59 59 * * * *', wall => wall.getUTCMinutes() === 59 && wall.getUTCSeconds() % 59 === 0],
    ['30 2 * * *', wall => wall.getUTCHours() === 2 && wall.getUTCMinutes() === 30 && wall.getUTCSeconds() === 0],
    ['15 2 * * *', wall => wall.getUTCHours() === 2 && wall.getUTCMinutes() === 15 && wall.getUTCSeconds() === 0],
    ['* * 2 * * *', wall => wall.getUTCHours() === 2],
    ['*/30 * * * *', wall => wall.getUTCMinutes() % 30 === 0 && wall.getUTCSeconds() === 0],
  ]

  /** Spring gaps of a zone in `[from, to)`. */
  function gaps(zone: string, from: string, to: string): number[] {
    const resolved = resolveTimeZone(zone)
    if (!resolved.ok) throw new Error(resolved.message)
    const found: number[] = []
    for (let cursor = Date.parse(from); ; ) {
      const transition = resolved.zone.firstTransition(cursor, Date.parse(to))
      if (transition === undefined) return found
      if (transition.after > transition.before) found.push(transition.at)
      cursor = transition.at
    }
  }

  it.each([
    ['Europe/Paris', '2024-01-01T00:00:00Z', '2028-01-01T00:00:00Z'],
    ['America/New_York', '2024-01-01T00:00:00Z', '2028-01-01T00:00:00Z'],
    ['Australia/Lord_Howe', '2024-01-01T00:00:00Z', '2028-01-01T00:00:00Z'],
    ['Pacific/Apia', '2011-12-01T00:00:00Z', '2012-01-01T00:00:00Z'],
  ])('%s: next() agrees with a brute-force reference, and matches() its answers', (zone, from, to) => {
    const resolved = resolveTimeZone(zone)
    if (!resolved.ok) throw new Error(resolved.message)
    const wall = wallClock(zone)
    const found = gaps(zone, from, to)
    expect(found.length).toBeGreaterThan(0)
    const mismatches: string[] = []
    for (const at of found) {
      for (const [expression, matches] of EXPRESSIONS) {
        const engine = compileCron(spec(expression), resolved.zone)
        for (const after of [at - 1001, at - 1000, at - 500, at - 1]) {
          const expected = reference(wall, matches, after)
          const actual = engine.next(after)
          if (actual !== expected || !engine.matches(expected)) {
            mismatches.push(`${expression} after ${new Date(after).toISOString()}: ${actual} vs ${expected}`)
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('the scheduler chain (next of the last occurrence) keeps the gap occurrence', () => {
    // Europe/Paris, 2027-03-28: 02:00-02:59:59 CET does not exist, 01:00:00Z is 03:00:00 CEST
    expect(runs('* * 1,2 * * *', '2027-03-28T00:59:57Z', 4, 'Europe/Paris')).toEqual([
      '2027-03-28T00:59:58.000Z', // 01:59:58 CET
      '2027-03-28T00:59:59.000Z', // 01:59:59 CET
      '2027-03-28T01:00:00.000Z', // every 02:xx:xx at once, when the gap ends
      '2027-03-28T23:00:00.000Z', // 01:00:00 CEST the next day
    ])
    expect(runs('0,59 59 * * * *', '2027-03-28T00:59:30Z', 3, 'Europe/Paris')).toEqual([
      '2027-03-28T00:59:59.000Z',
      '2027-03-28T01:00:00.000Z', // 02:59:00 and 02:59:59 do not exist
      '2027-03-28T01:59:00.000Z',
    ])
    const daily = resolveTimeZone('Europe/Paris')
    if (!daily.ok) throw new Error(daily.message)
    const engine = compileCron(spec('30 2 * * *'), daily.zone)
    const end = Date.parse('2027-03-28T01:00:00Z')
    expect(engine.next(end - 1)).toBe(end)
    expect(engine.matches(end)).toBe(true)
  })
})

describe('resolveTimeZone', () => {
  it('keeps the name as written (aliases are never canonicalised)', () => {
    const zone = resolveTimeZone('US/Eastern')
    expect(zone.ok && zone.zone.name).toBe('US/Eastern')
    expect(between('0 12 * * *', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 'US/Eastern')).toEqual([
      '2026-07-01T16:00:00.000Z',
    ])
  })

  it('reports unknown zones and invalid offsets', () => {
    expect(resolveTimeZone('Mars/Olympus')).toEqual({
      ok: false,
      message: "unknown time zone 'Mars/Olympus'",
      unknown: true,
    })
    expect(resolveTimeZone('+24:00')).toMatchObject({ ok: false, unknown: false })
    expect(resolveTimeZone('')).toMatchObject({ ok: false })
  })

  it('resolves local to the zone of the process', () => {
    const local = resolveTimeZone('local')
    expect(local.ok && local.zone.name).toBe('local')
    const system = new Intl.DateTimeFormat().resolvedOptions().timeZone
    const reference = resolveTimeZone(system)
    const instant = Date.parse('2026-07-01T12:00:00Z')
    expect(local.ok && local.zone.offsetAt(instant)).toBe(reference.ok ? reference.zone.offsetAt(instant) : -1)
  })

  it('keeps its cache bounded whatever the spellings (names may come from user input)', () => {
    const name = 'America/Argentina/ComodRivadavia'
    const spell = (variant: number): string =>
      [...name].map((char, index) => ((variant >> (index % 10)) & 1 ? char.toUpperCase() : char.toLowerCase())).join('')
    const spellings = new Set(Array.from({ length: 1024 }, (_, variant) => spell(variant)))
    expect(spellings.size).toBeGreaterThan(1000)
    const instant = Date.parse('2026-07-01T12:00:00Z')
    const before = zoneCacheSizes()
    for (const spelling of spellings) {
      const zone = resolveTimeZone(spelling)
      if (!zone.ok) throw new Error(zone.message)
      expect(zone.zone.name).toBe(spelling) // kept as written
      expect(zone.zone.offsetAt(instant)).toBe(-3 * 3_600_000)
    }
    const after = zoneCacheSizes()
    expect(after.zones - before.zones).toBeLessThanOrEqual(1) // one formatter and transition cache
    expect(after.names).toBeLessThanOrEqual(256)
  })

  it('finds the transitions of a year', () => {
    const zone = resolveTimeZone('Europe/Paris')
    if (!zone.ok) throw new Error('no zone')
    const transition = zone.zone.firstTransition(Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z'))
    expect(transition).toEqual({ at: Date.parse('2026-03-29T01:00:00Z'), before: 3_600_000, after: 7_200_000 })
    const last = zone.zone.lastTransition(Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z'))
    expect(last).toEqual({ at: Date.parse('2026-10-25T01:00:00Z'), before: 7_200_000, after: 3_600_000 })
    expect(zone.zone.firstTransition(5, 5)).toBeUndefined()
  })
})
