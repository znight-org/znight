/**
 * Trusted proxies (RFC 0001 §5.6): `ctx.ip` and `ctx.protocol` behind load balancers, computed the
 * same way on every adapter from the socket peer (`AdapterRequest.remoteAddress`) and the
 * `x-forwarded-for` / `x-forwarded-proto` headers. The `Forwarded` header (RFC 7239) is not read.
 */
import { invalidOption } from './option-error.ts'

/**
 * The `trustProxy` option: `false` (default: the headers are ignored), a number of trusted hops
 * (`1`: one load balancer in front of the server), or the addresses of the trusted proxies (IPv4 /
 * IPv6 addresses, CIDR ranges and the aliases `'loopback'`, `'private'`, `'linklocal'`).
 */
export type TrustProxy = false | number | readonly string[]

/** Client address and protocol of a request (internal). */
export interface ClientInfo {
  readonly ip: string | undefined
  readonly protocol: 'http' | 'https'
}

/** A resolved `trustProxy` policy (internal). */
export interface TrustPolicy {
  /** `ctx.ip` and `ctx.protocol` of a request. */
  resolve(
    remoteAddress: string | undefined,
    headers: Readonly<Record<string, string | undefined>>,
    encrypted: boolean,
  ): ClientInfo
}

/** A parsed address: IPv4 (4 bytes, IPv4-mapped IPv6 included) or IPv6 (16 bytes). */
interface Address {
  readonly bytes: readonly number[]
  /** Normalised text (`::ffff:10.0.0.1` → `10.0.0.1`). */
  readonly text: string
}

interface Range {
  readonly bytes: readonly number[]
  readonly prefix: number
}

const ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  loopback: ['127.0.0.0/8', '::1/128'],
  private: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
})

const TRUST_HINTS: readonly string[] = [
  'trustProxy: 1 trusts one proxy (the socket peer); trustProxy: ["loopback", "10.0.0.0/8"] trusts these addresses',
  'Trusting every hop would let any client choose its ctx.ip with an x-forwarded-for header',
]

/** Validates the `trustProxy` option (ZNIGHT005); `undefined` when proxies are not trusted. */
export function resolveTrustProxy(value: TrustProxy | undefined): TrustPolicy | undefined {
  if (value === undefined || value === false) return undefined
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalidOption(
        'trustProxy',
        'false, a number of hops (an integer >= 1) or a list of addresses',
        value,
        undefined,
        TRUST_HINTS,
      )
    }
    return hopPolicy(value)
  }
  if (!Array.isArray(value)) {
    throw invalidOption(
      'trustProxy',
      'false, a number of hops (an integer >= 1) or a list of addresses',
      value,
      undefined,
      TRUST_HINTS,
    )
  }
  const ranges: Range[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw invalidOption('trustProxy', 'a list of addresses, CIDR ranges or aliases', value, undefined, TRUST_HINTS)
    }
    const expanded = ALIASES[entry] ?? [entry]
    for (const item of expanded) {
      const range = parseRange(item)
      if (range === undefined) {
        throw invalidOption(
          'trustProxy',
          `a list of IP addresses, CIDR ranges ("10.0.0.0/8") or aliases ("loopback", "private", "linklocal"); "${entry}" is invalid`,
          value,
          undefined,
          TRUST_HINTS,
        )
      }
      ranges.push(range)
    }
  }
  return listPolicy(ranges)
}

function hopPolicy(hops: number): TrustPolicy {
  return {
    resolve(remoteAddress, headers, encrypted) {
      const socket = remoteAddress === undefined ? undefined : parseAddress(remoteAddress)
      if (socket === undefined) return { ip: remoteAddress, protocol: encrypted ? 'https' : 'http' }
      let client = socket
      const chain = forwardedFor(headers)
      for (let index = 0; index < hops && index < chain.length; index++) {
        const next = parseAddress(chain[index] as string)
        if (next === undefined) break // a malformed entry stops the walk at the last valid address
        client = next
      }
      return { ip: client.text, protocol: forwardedProto(headers, encrypted) }
    },
  }
}

function listPolicy(ranges: readonly Range[]): TrustPolicy {
  const trusted = (address: Address): boolean => ranges.some(range => inRange(address, range))
  return {
    resolve(remoteAddress, headers, encrypted) {
      const socket = remoteAddress === undefined ? undefined : parseAddress(remoteAddress)
      if (socket === undefined) return { ip: remoteAddress, protocol: encrypted ? 'https' : 'http' }
      if (!trusted(socket)) return { ip: socket.text, protocol: encrypted ? 'https' : 'http' }
      let client = socket
      for (const entry of forwardedFor(headers)) {
        const next = parseAddress(entry)
        if (next === undefined) break
        client = next
        if (!trusted(next)) break
      }
      return { ip: client.text, protocol: forwardedProto(headers, encrypted) }
    },
  }
}

/** `x-forwarded-for` entries from right (nearest proxy) to left (client). */
function forwardedFor(headers: Readonly<Record<string, string | undefined>>): string[] {
  const value = headers['x-forwarded-for']
  if (value === undefined) return []
  return value
    .split(',')
    .map(entry => entry.trim())
    .reverse()
}

/** The leftmost `x-forwarded-proto` value when it is `http` or `https`, else the connection protocol. */
function forwardedProto(headers: Readonly<Record<string, string | undefined>>, encrypted: boolean): 'http' | 'https' {
  const value = headers['x-forwarded-proto']?.split(',')[0]?.trim().toLowerCase()
  if (value === 'http' || value === 'https') return value
  return encrypted ? 'https' : 'http'
}

function inRange(address: Address, range: Range): boolean {
  if (address.bytes.length !== range.bytes.length) return false
  let bits = range.prefix
  for (let index = 0; index < range.bytes.length && bits > 0; index++) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff
    if (((address.bytes[index] as number) & mask) !== ((range.bytes[index] as number) & mask)) return false
    bits -= 8
  }
  return true
}

/** `10.0.0.0/8`, `fc00::/7` or a single address. */
function parseRange(value: string): Range | undefined {
  const slash = value.indexOf('/')
  const address = parseAddress(slash === -1 ? value : value.slice(0, slash))
  if (address === undefined) return undefined
  const bits = address.bytes.length * 8
  if (slash === -1) return { bytes: address.bytes, prefix: bits }
  const prefixText = value.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefixText)) return undefined
  const prefix = Number(prefixText)
  return prefix > bits ? undefined : { bytes: address.bytes, prefix }
}

/** Parses an IPv4 or IPv6 address (zone ids ignored); IPv4-mapped IPv6 addresses become IPv4. */
export function parseAddress(value: string): Address | undefined {
  const text = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  const v4 = parseIPv4(text)
  if (v4 !== undefined) return { bytes: v4, text }
  const zone = text.indexOf('%')
  const v6 = parseIPv6(zone === -1 ? text : text.slice(0, zone))
  if (v6 === undefined) return undefined
  if (v6.slice(0, 10).every(byte => byte === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    const bytes = v6.slice(12)
    return { bytes, text: bytes.join('.') }
  }
  return { bytes: v6, text: text.toLowerCase() }
}

function parseIPv4(text: string): number[] | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return undefined
    const byte = Number(part)
    if (byte > 255) return undefined
    bytes.push(byte)
  }
  return bytes
}

function parseIPv6(text: string): number[] | undefined {
  if (text === '' || text.length > 45) return undefined
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const groups = (part: string): number[] | undefined => {
    if (part === '') return []
    const result: number[] = []
    const items = part.split(':')
    for (let index = 0; index < items.length; index++) {
      const item = items[index] as string
      if (index === items.length - 1 && item.includes('.')) {
        const v4 = parseIPv4(item)
        if (v4 === undefined) return undefined
        result.push(((v4[0] as number) << 8) | (v4[1] as number), ((v4[2] as number) << 8) | (v4[3] as number))
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(item)) return undefined
        result.push(Number.parseInt(item, 16))
      }
    }
    return result
  }
  const head = groups(halves[0] as string)
  const tail = halves.length === 2 ? groups(halves[1] as string) : []
  if (head === undefined || tail === undefined) return undefined
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined
  const words = [...head, ...new Array<number>(missing).fill(0), ...tail]
  const bytes: number[] = []
  for (const word of words) bytes.push(word >> 8, word & 0xff)
  return bytes
}
