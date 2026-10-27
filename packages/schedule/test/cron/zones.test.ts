/**
 * Time zones and daylight saving time (RFC 0004 §4.4). The expected values are part of the tests:
 * gaps fire once at the end of the gap, folds fire at their first occurrence unless the hour field
 * matches every hour.
 */
import { resolveTimeZone } from '../../src/cron/zone.ts'
import { between } from './helpers.ts'
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
