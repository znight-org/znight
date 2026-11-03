/**
 * Content negotiation of the GraphQL endpoint (RFC 0005 §8.3): which of the media types the
 * endpoint produces a request accepts best. Import-free.
 *
 * `application/json` is the only type matched by wildcards (`*\/*`, `application/*`): the
 * GraphQL-over-HTTP draft asks for `application/json` when the client accepts anything, and the
 * other types change the protocol (`application/graphql-response+json` statuses, an event stream,
 * the GraphiQL page), so they are chosen only when listed. Among types of equal quality, the order
 * of {@link Media} decides: an event stream, then `application/graphql-response+json`, then
 * `application/json`, then HTML (a browser listing `text/html` first gets GraphiQL).
 */

/** What a response is encoded as. */
export const Media: {
  readonly EventStream: 0
  readonly GraphQLJson: 1
  readonly Json: 2
  readonly Html: 3
  /** Nothing the endpoint produces is acceptable: 406. */
  readonly None: 4
} = Object.freeze({ EventStream: 0, GraphQLJson: 1, Json: 2, Html: 3, None: 4 })

/** One of the {@link Media} values. */
export type MediaKind = (typeof Media)[keyof typeof Media]

/** The media type names, by {@link Media} value (`None` excluded). */
const NAMES: readonly (readonly [type: string, subtype: string])[] = [
  ['text', 'event-stream'],
  ['application', 'graphql-response+json'],
  ['application', 'json'],
  ['text', 'html'],
]

/** A media range of an `accept` header. */
interface Range {
  readonly type: string
  readonly subtype: string
  readonly q: number
}

/** The media ranges of an `accept` header (lower-case, without parameters other than `q`). */
function parseRanges(header: string): Range[] {
  const ranges: Range[] = []
  for (const item of header.split(',')) {
    const parts = item.split(';')
    const media = (parts[0] as string).trim().toLowerCase()
    const slash = media.indexOf('/')
    if (slash <= 0 || slash === media.length - 1) continue
    let q = 1
    for (let index = 1; index < parts.length; index++) {
      const parameter = (parts[index] as string).trim()
      if (parameter.length < 2 || (parameter.charCodeAt(0) | 0x20) !== 0x71 /* q */ || parameter[1] !== '=') continue
      const value = Number(parameter.slice(2))
      // an invalid weight leaves the range as it is (RFC 9110 §12.4.2 allows 0 to 1, 3 decimals)
      if (value >= 0 && value <= 1) q = value
    }
    ranges.push({ type: media.slice(0, slash), subtype: media.slice(slash + 1), q })
  }
  return ranges
}

/**
 * The quality of `type/subtype` in `ranges`: that of the most specific matching range (RFC 9110
 * §12.5.1), wildcards only when `wildcards` is set; 0 when nothing matches.
 */
function quality(ranges: readonly Range[], type: string, subtype: string, wildcards: boolean): number {
  let best = -1
  let specificity = -1
  for (const range of ranges) {
    let level: number
    if (range.type === type && range.subtype === subtype) level = 2
    else if (!wildcards) continue
    else if (range.type === type && range.subtype === '*') level = 1
    else if (range.type === '*' && range.subtype === '*') level = 0
    else continue
    if (level > specificity || (level === specificity && range.q > best)) {
      specificity = level
      best = range.q
    }
  }
  return best < 0 ? 0 : best
}

/**
 * Chooses the media type of a response among `produced` (a bit mask of `1 << Media.X`), per
 * `accept` (`undefined`: no header, i.e. `application/json`).
 */
export function negotiate(accept: string | undefined, produced: number): MediaKind {
  if (accept === undefined) return produced & (1 << Media.Json) ? Media.Json : Media.None
  const ranges = parseRanges(accept)
  if (ranges.length === 0) return produced & (1 << Media.Json) ? Media.Json : Media.None
  let chosen: MediaKind = Media.None
  let best = 0
  for (let media = 0; media < NAMES.length; media++) {
    if ((produced & (1 << media)) === 0) continue
    const [type, subtype] = NAMES[media] as readonly [string, string]
    const q = quality(ranges, type, subtype, media === Media.Json)
    if (q > best) {
      best = q
      chosen = media as MediaKind
    }
  }
  return chosen
}

const CACHE_MAX = 64

/**
 * {@link negotiate} for one route, memoised by header value: a server sees a handful of `accept`
 * values, so a request costs a map lookup. Bounded, since clients choose the values: cleared when
 * full.
 */
export class Negotiator {
  readonly #produced: number
  readonly #cache = new Map<string, MediaKind>()
  /** The answer without `accept` header. */
  readonly #absent: MediaKind

  /** `produced`: a bit mask of `1 << Media.X`. */
  constructor(produced: number) {
    this.#produced = produced
    this.#absent = negotiate(undefined, produced)
  }

  choose(accept: string | undefined): MediaKind {
    if (accept === undefined) return this.#absent
    let media = this.#cache.get(accept)
    if (media === undefined) {
      media = negotiate(accept, this.#produced)
      if (this.#cache.size === CACHE_MAX) this.#cache.clear()
      this.#cache.set(accept, media)
    }
    return media
  }
}
