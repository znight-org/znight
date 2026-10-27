/**
 * Time zones of cron schedules (RFC 0004 §4.4): IANA names through `Intl` (Node 24 has no
 * `Temporal`), `UTC`, fixed offsets (`+05:30`) and `local`. This module is **pure** (standard
 * globals only); it keeps one cache of zones and of their yearly transitions.
 *
 * Offsets are computed with one cached `Intl.DateTimeFormat` per zone. Transitions are found once per
 * zone and year, by sampling the offset every day and bisecting to the second where it changes.
 */
import { civilFromDays, daysFromCivil } from './fields.ts'

/** A change of UTC offset. Offsets are in milliseconds, wall time minus UTC. */
export interface ZoneTransition {
  /** First instant (epoch ms) with the new offset. */
  readonly at: number
  readonly before: number
  readonly after: number
}

/** A time zone, as the cron engine needs it. */
export interface TimeZone {
  /** The name as written (never canonicalised). */
  readonly name: string
  /** `true` for `UTC` and fixed offsets: no transition, no `Intl`. */
  readonly fixed: boolean
  /** Offset at an instant, in milliseconds (wall time minus UTC). */
  offsetAt(instant: number): number
  /** The first transition in `(from, to]`. */
  firstTransition(from: number, to: number): ZoneTransition | undefined
  /** The last transition in `(from, to]`. */
  lastTransition(from: number, to: number): ZoneTransition | undefined
}

/** Result of {@link resolveTimeZone}. */
export type ZoneResult =
  | { readonly ok: true; readonly zone: TimeZone }
  | { readonly ok: false; readonly message: string; readonly unknown: boolean }

const DAY = 86_400_000
const FIXED_OFFSET = /^([+-])(\d{2})(?::?(\d{2}))?$/

const cache = new Map<string, TimeZone>()

/**
 * Resolves a time zone: `'UTC'`, a fixed offset (`'+05:30'`, `'-03'`), `'local'` (the zone of the
 * process, read now) or an IANA name known to this runtime's `Intl`. The name is kept as written.
 */
export function resolveTimeZone(name: string): ZoneResult {
  if (typeof name !== 'string' || name === '') {
    return { ok: false, message: 'a time zone must be a non-empty string', unknown: false }
  }
  const cached = cache.get(name)
  if (cached !== undefined) return { ok: true, zone: cached }
  if (name === 'local') {
    const local = localZoneName()
    const resolved = local === undefined ? undefined : resolveTimeZone(local)
    if (resolved?.ok === true) return { ok: true, zone: renamed(resolved.zone, name) }
    return { ok: true, zone: fixedZone(name, -new Date().getTimezoneOffset() * 60_000) }
  }
  let zone: TimeZone
  if (name === 'UTC') {
    zone = fixedZone(name, 0)
  } else {
    const fixed = FIXED_OFFSET.exec(name)
    if (fixed === null) {
      let formatter: Intl.DateTimeFormat
      try {
        formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: name,
          hourCycle: 'h23',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        })
      } catch {
        return { ok: false, message: `unknown time zone '${name}'`, unknown: true }
      }
      zone = new IntlZone(name, formatter)
    } else {
      const hours = Number(fixed[2])
      const minutes = Number(fixed[3] ?? '0')
      if (hours > 23 || minutes > 59) {
        return { ok: false, message: `invalid UTC offset '${name}' (from -23:59 to +23:59)`, unknown: false }
      }
      zone = fixedZone(name, (fixed[1] === '-' ? -1 : 1) * (hours * 3_600_000 + minutes * 60_000))
    }
  }
  cache.set(name, zone)
  return { ok: true, zone }
}

/** Time zones known to this runtime (`Intl.supportedValuesOf('timeZone')`), for suggestions. */
export function knownTimeZones(): readonly string[] {
  try {
    return [...Intl.supportedValuesOf('timeZone'), 'UTC']
  } catch {
    return ['UTC']
  }
}

/** Name of the zone of the process (`TZ` or the system zone). */
export function localZoneName(): string | undefined {
  try {
    const name = new Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof name === 'string' && name !== '' ? name : undefined
  } catch {
    return undefined
  }
}

function fixedZone(name: string, offset: number): TimeZone {
  return {
    name,
    fixed: true,
    offsetAt: () => offset,
    firstTransition: () => undefined,
    lastTransition: () => undefined,
  }
}

function renamed(zone: TimeZone, name: string): TimeZone {
  return {
    name,
    fixed: zone.fixed,
    offsetAt: instant => zone.offsetAt(instant),
    firstTransition: (from, to) => zone.firstTransition(from, to),
    lastTransition: (from, to) => zone.lastTransition(from, to),
  }
}

/** Offset at the start of a year and the transitions in `(start, end]`. */
interface YearInfo {
  readonly start: number
  readonly startOffset: number
  readonly transitions: readonly ZoneTransition[]
}

class IntlZone implements TimeZone {
  readonly name: string
  readonly fixed = false
  readonly #formatter: Intl.DateTimeFormat
  readonly #years = new Map<number, YearInfo>()

  constructor(name: string, formatter: Intl.DateTimeFormat) {
    this.name = name
    this.#formatter = formatter
  }

  offsetAt(instant: number): number {
    const info = this.#year(yearOf(instant))
    let offset = info.startOffset
    for (const transition of info.transitions) {
      if (transition.at > instant) break
      offset = transition.after
    }
    return offset
  }

  firstTransition(from: number, to: number): ZoneTransition | undefined {
    if (!(to > from)) return undefined
    const last = yearOf(to)
    for (let year = yearOf(from); year <= last; year++) {
      for (const transition of this.#year(year).transitions) {
        if (transition.at > to) return undefined
        if (transition.at > from) return transition
      }
    }
    return undefined
  }

  lastTransition(from: number, to: number): ZoneTransition | undefined {
    if (!(to > from)) return undefined
    const first = yearOf(from)
    for (let year = yearOf(to); year >= first; year--) {
      const transitions = this.#year(year).transitions
      for (let index = transitions.length - 1; index >= 0; index--) {
        const transition = transitions[index] as ZoneTransition
        if (transition.at <= from) return undefined
        if (transition.at <= to) return transition
      }
    }
    return undefined
  }

  #year(year: number): YearInfo {
    let info = this.#years.get(year)
    if (info === undefined) {
      info = this.#scan(year)
      this.#years.set(year, info)
    }
    return info
  }

  /** Samples the offset every day of the year and bisects every change to the second. */
  #scan(year: number): YearInfo {
    const start = daysFromCivil(year, 1, 1) * DAY
    const end = daysFromCivil(year + 1, 1, 1) * DAY
    const startOffset = this.#raw(start)
    const transitions: ZoneTransition[] = []
    let lo = start
    let before = startOffset
    for (let sample = start + DAY; ; sample += DAY) {
      const at = Math.min(sample, end)
      let offset = this.#raw(at)
      // several changes between two samples: find them one after the other
      while (offset !== before) {
        const transition = this.#bisect(lo, at, before)
        transitions.push(transition)
        before = transition.after
        lo = transition.at
        offset = this.#raw(at)
      }
      lo = at
      if (at === end) break
    }
    return { start, startOffset, transitions }
  }

  /** The first second in `(lo, hi]` whose offset differs from `before` (the offset at `lo`). */
  #bisect(lo: number, hi: number, before: number): ZoneTransition {
    let low = lo
    let high = hi
    while (high - low > 1000) {
      const middle = low + Math.floor((high - low) / 2000) * 1000
      if (this.#raw(middle) === before) low = middle
      else high = middle
    }
    return { at: high, before, after: this.#raw(high) }
  }

  /** Offset at a whole second, through `Intl`. */
  #raw(instant: number): number {
    const values = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
    for (const part of this.#formatter.formatToParts(instant)) {
      if (part.type in values) values[part.type as keyof typeof values] = Number(part.value)
    }
    const wall =
      daysFromCivil(values.year, values.month, values.day) * DAY +
      values.hour * 3_600_000 +
      values.minute * 60_000 +
      values.second * 1000
    return wall - Math.floor(instant / 1000) * 1000
  }
}

function yearOf(instant: number): number {
  return civilFromDays(Math.floor(instant / DAY)).year
}
