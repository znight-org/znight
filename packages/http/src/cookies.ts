/**
 * Cookies (RFC 0006): parsing of the `cookie` request header, canonical value encoding, strict
 * `Set-Cookie` serialisation (RFC 6265bis: attribute validation, name prefixes, size limits),
 * `Set-Cookie` parsing (tests) and the response cookie jar.
 *
 * This module is import-free (pure functions): safe to import from anywhere, the compiler excepted
 * (it has its own token grammar).
 */

/** Options of a cookie set on a response (`ctx.setCookie()`, `HttpResponse.withCookie()`). */
export interface CookieOptions {
  /** Lifetime in seconds (integer). `0` or less expires the cookie now. Default: session cookie. */
  readonly maxAge?: number
  /** Absolute expiry (sent as an IMF-fixdate). */
  readonly expires?: Date
  /** Domain (sub-domains included). Default: none, a host-only cookie. */
  readonly domain?: string
  /** Default: `'/'`. */
  readonly path?: string
  /** Default: `true` (browsers only send it over HTTPS, `http://localhost` excepted). */
  readonly secure?: boolean
  /** Default: `true` (not readable from JavaScript). */
  readonly httpOnly?: boolean
  /** Default: `'lax'`. `'none'` requires `secure`. */
  readonly sameSite?: 'strict' | 'lax' | 'none'
  /** CHIPS partitioned cookie. Requires `secure`. Default: `false`. */
  readonly partitioned?: boolean
  /** Chromium `Priority`. Default: none. */
  readonly priority?: 'low' | 'medium' | 'high'
  /** Signs the value with the first secret of the plugin option `cookies.secrets`. Default: `false`. */
  readonly signed?: boolean
}

/** Plugin-wide defaults (`cookies.defaults`). Lifetime and signing are per cookie. */
export type CookieDefaults = Omit<CookieOptions, 'maxAge' | 'expires' | 'signed'>

/** What identifies a cookie to clear (and keeps prefixed names valid). */
export type ClearCookieOptions = Pick<
  CookieOptions,
  'domain' | 'path' | 'secure' | 'httpOnly' | 'sameSite' | 'partitioned'
>

/** A cookie to send, as given (defaults and signing are applied when the response is serialised). */
export interface ResponseCookie {
  readonly name: string
  /** `undefined`: a clearing cookie. */
  readonly value: string | undefined
  readonly options: CookieOptions
}

/** A parsed `Set-Cookie` line (see {@link parseSetCookie}). */
export interface SetCookieInfo {
  readonly name: string
  /** Decoded value (a signed cookie: `"<value>.<signature>"`, decoded). */
  readonly value: string
  /** The header line. */
  readonly raw: string
  readonly expires?: Date
  readonly maxAge?: number
  readonly domain?: string
  readonly path?: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite?: 'strict' | 'lax' | 'none'
  readonly partitioned: boolean
  readonly priority?: 'low' | 'medium' | 'high'
}

/** The secure defaults: `Path=/; Secure; HttpOnly; SameSite=Lax`, host-only. */
export const DEFAULT_COOKIE_OPTIONS: Readonly<{
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'strict' | 'lax' | 'none'
}> = Object.freeze({ path: '/', secure: true, httpOnly: true, sameSite: 'lax' })

/** Largest `name=value` (bytes on the wire, after encoding and signing). */
export const MAX_COOKIE_SIZE = 4096
/** Largest `Domain` / `Path` attribute value (bytes). */
export const MAX_COOKIE_ATTRIBUTE_SIZE = 1024
const MAX_DOMAIN_LENGTH = 253
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT'

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'maxAge',
  'expires',
  'domain',
  'path',
  'secure',
  'httpOnly',
  'sameSite',
  'partitioned',
  'priority',
  'signed',
])
const SAME_SITE: Readonly<Record<string, string>> = { strict: 'Strict', lax: 'Lax', none: 'None' }
const PRIORITY: Readonly<Record<string, string>> = { low: 'Low', medium: 'Medium', high: 'High' }

// -------------------------------------------------------------------------------------------------
// Request cookies
// -------------------------------------------------------------------------------------------------

/**
 * Parses a `cookie` request header into a prototype-less, frozen record (`__proto__` is just a
 * name). Pairs are split on `;` only (never `,`) and trimmed; a pair without `=` or with an empty
 * name is ignored; names are kept as sent (case-sensitive); a value wrapped in double quotes is
 * unquoted, and percent-decoded when it contains `%` (a malformed sequence keeps the raw value).
 * When a name repeats, the first occurrence wins (browsers send the most specific path first).
 * Linear time, never throws.
 */
export function parseCookieHeader(header: string | undefined): Readonly<Record<string, string>> {
  const result = Object.create(null) as Record<string, string>
  if (typeof header === 'string') {
    let start = 0
    const length = header.length
    while (start < length) {
      let end = header.indexOf(';', start)
      if (end === -1) end = length
      const equals = header.indexOf('=', start)
      if (equals !== -1 && equals < end) {
        const name = trim(header, start, equals)
        if (name !== '' && !Object.hasOwn(result, name)) {
          result[name] = decodeCookieValue(unquote(trim(header, equals + 1, end)))
        }
      }
      start = end + 1
    }
  }
  return Object.freeze(result)
}

/** `text.slice(start, end)` without leading and trailing SP / HTAB. */
function trim(text: string, start: number, end: number): string {
  let from = start
  let to = end
  while (from < to && isBlank(text.charCodeAt(from))) from++
  while (to > from && isBlank(text.charCodeAt(to - 1))) to--
  return text.slice(from, to)
}

function isBlank(code: number): boolean {
  return code === 0x20 || code === 0x09
}

function unquote(value: string): string {
  return value.length >= 2 && value.charCodeAt(0) === 0x22 && value.charCodeAt(value.length - 1) === 0x22
    ? value.slice(1, -1)
    : value
}

/**
 * Decodes a cookie value produced by {@link encodeCookieValue} (`decodeURIComponent` when it
 * contains `%`; a malformed sequence keeps the raw value). Never throws.
 */
export function decodeCookieValue(value: string): string {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Encodes a cookie value canonically: the UTF-8 bytes outside RFC 6265 `cookie-octet` (space, `"`,
 * `,`, `;`, `\`, controls, non-ASCII) and `%` are percent-encoded (upper-case hex), so that
 * {@link decodeCookieValue} restores the value exactly (`a b;c` → `a%20b%3Bc`), and
 * `encode(decode(w)) === w` for every encoded `w`. Quotes are never emitted.
 *
 * @throws TypeError for a non-string or a string with lone surrogates (they cannot round-trip).
 */
export function encodeCookieValue(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`A cookie value must be a string (received ${describe(value)})`)
  }
  if (!value.isWellFormed()) {
    throw new TypeError('A cookie value must be a well-formed string (it contains a lone surrogate)')
  }
  let encoded = ''
  let plain = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (isCookieOctet(code)) continue
    encoded += value.slice(plain, index)
    if (code < 0x80) {
      encoded += `%${HEX[code] as string}`
      plain = index + 1
    } else {
      // a whole code point (a surrogate pair is two UTF-16 units): `encodeURIComponent` gives its UTF-8 bytes
      const point = value.codePointAt(index) as number
      const width = point > 0xffff ? 2 : 1
      encoded += encodeURIComponent(value.slice(index, index + width))
      index += width - 1
      plain = index + 1
    }
  }
  return plain === 0 ? value : encoded + value.slice(plain)
}

const HEX: readonly string[] = Array.from({ length: 128 }, (_, code) =>
  code.toString(16).toUpperCase().padStart(2, '0'),
)

/** RFC 6265 `cookie-octet`, `%` excluded (the escape character). */
function isCookieOctet(code: number): boolean {
  return (
    code === 0x21 ||
    (code >= 0x23 && code <= 0x2b && code !== 0x25) ||
    (code >= 0x2d && code <= 0x3a) ||
    (code >= 0x3c && code <= 0x5b) ||
    (code >= 0x5d && code <= 0x7e)
  )
}

/** Whether `name` is an RFC 9110 token (a cookie name Znight can set). */
export function isCookieName(name: unknown): name is string {
  if (typeof name !== 'string' || name === '') return false
  for (let index = 0; index < name.length; index++) {
    if (!isTokenChar(name.charCodeAt(index))) return false
  }
  return true
}

function isTokenChar(code: number): boolean {
  // ! # $ % & ' * + - . ^ _ ` | ~ DIGIT ALPHA
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x21 ||
    (code >= 0x23 && code <= 0x27) ||
    code === 0x2a ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x5e ||
    code === 0x5f ||
    code === 0x60 ||
    code === 0x7c ||
    code === 0x7e
  )
}

// -------------------------------------------------------------------------------------------------
// Response cookies
// -------------------------------------------------------------------------------------------------

/**
 * Checks what a cookie says about itself, without plugin defaults: the name, the value type, the
 * options (types, `maxAge`, `expires`, `domain`, `path`) and the size before signing. Run by
 * `HttpResponse.withCookie()` / `withoutCookie()` at call time; the rules depending on the defaults
 * (prefixes, `SameSite=None` and `partitioned` with `secure`), signing and the final size are checked
 * when the response is serialised.
 *
 * @throws TypeError / RangeError naming the cookie.
 */
export function checkCookie(name: string, value: string | undefined, options: CookieOptions | undefined): void {
  checkName(name)
  const checked = checkOptions(name, options)
  if (value !== undefined) {
    const encoded = encodeValue(name, value)
    checkSize(name, encoded)
  }
  if (checked.domain !== undefined) normalizeDomain(name, checked.domain)
  if (checked.path !== undefined) checkPath(name, checked.path)
}

/** A cookie resolved with the defaults: its `Set-Cookie` line and its jar key. */
export interface SerializedCookie {
  /** `name` + domain + path: a later cookie with the same key replaces an earlier one. */
  readonly key: string
  readonly line: string
}

/**
 * Serialises a response cookie with `defaults` (merged under the options): every rule of RFC 0006
 * §4.3 is checked. `sign` turns the encoded value into its signed wire form (`signed: true`).
 *
 * @throws TypeError / RangeError naming the cookie.
 */
export function serializeResponseCookie(
  cookie: ResponseCookie,
  defaults: CookieDefaults,
  sign?: (name: string, encoded: string) => string,
): SerializedCookie {
  const { name, value } = cookie
  checkName(name)
  const options = checkOptions(name, cookie.options)
  checkOptions(name, defaults, true)
  const attributes = resolveAttributes(name, { ...defaults, ...definedOnly(options) })
  let wire: string
  let maxAge: number | undefined
  let expires: string | undefined
  if (value === undefined) {
    wire = ''
    maxAge = 0
    expires = EPOCH
  } else {
    wire = encodeValue(name, value)
    if (options.signed === true) {
      if (sign === undefined) throw new TypeError(`Cannot sign the cookie "${name}": no signing key`)
      wire = sign(name, wire)
    }
    if (options.maxAge !== undefined) maxAge = Math.max(options.maxAge, 0)
    if (options.expires !== undefined) expires = options.expires.toUTCString()
  }
  checkSize(name, wire)
  let line = `${name}=${wire}`
  if (maxAge !== undefined) line += `; Max-Age=${maxAge}`
  if (expires !== undefined) line += `; Expires=${expires}`
  if (attributes.domain !== undefined) line += `; Domain=${attributes.domain}`
  line += `; Path=${attributes.path}`
  if (attributes.secure) line += '; Secure'
  if (attributes.httpOnly) line += '; HttpOnly'
  if (attributes.sameSite !== undefined) line += `; SameSite=${SAME_SITE[attributes.sameSite] as string}`
  if (attributes.partitioned) line += '; Partitioned'
  if (attributes.priority !== undefined && value !== undefined) {
    line += `; Priority=${PRIORITY[attributes.priority] as string}`
  }
  return { key: cookieKey(name, attributes.domain, attributes.path), line }
}

/**
 * The `Set-Cookie` line of a cookie with the secure defaults
 * (`Path=/; Secure; HttpOnly; SameSite=Lax`, overridable per cookie), in the order
 * `name=value; Max-Age; Expires; Domain; Path; Secure; HttpOnly; SameSite; Partitioned; Priority`.
 * The value is percent-encoded (see {@link encodeCookieValue}). Signing (`signed: true`) needs the
 * secrets of the plugin: use `ctx.setCookie()` or `HttpPlugin.signCookie()`.
 *
 * ```ts
 * serializeCookie('theme', 'dark', { maxAge: 86_400, httpOnly: false })
 * // theme=dark; Max-Age=86400; Path=/; Secure; SameSite=Lax
 * ```
 *
 * @throws TypeError for an invalid name, value or attribute, a `SameSite=None` or partitioned cookie
 *   without `Secure`, a broken `__Secure-` / `__Host-` / `__Http-` / `__Host-Http-` prefix rule.
 * @throws RangeError when `name=value` exceeds 4096 bytes, or `Domain` / `Path` 1024 bytes.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  return serializeResponseCookie({ name, value, options }, DEFAULT_COOKIE_OPTIONS).line
}

/**
 * The `Set-Cookie` line clearing a cookie: `name=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
 * plus `Domain`, `Path`, `Secure`, `HttpOnly`, `SameSite` and `Partitioned` (secure defaults merged
 * with `options`), so that a prefixed cookie is cleared with valid attributes.
 */
export function serializeClearCookie(name: string, options: ClearCookieOptions = {}): string {
  return serializeResponseCookie({ name, value: undefined, options }, DEFAULT_COOKIE_OPTIONS).line
}

/** The jar key of a cookie (RFC 6265: a cookie is identified by its name, domain and path). */
export function cookieKey(name: string, domain: string | undefined, path: string): string {
  return `${name}\u0000${domain ?? ''}\u0000${path}`
}

interface Attributes {
  readonly domain: string | undefined
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite: 'strict' | 'lax' | 'none' | undefined
  readonly partitioned: boolean
  readonly priority: 'low' | 'medium' | 'high' | undefined
}

/** Attributes after the defaults, checked against the cross-attribute and prefix rules. */
function resolveAttributes(name: string, options: CookieOptions): Attributes {
  const domain = options.domain === undefined ? undefined : normalizeDomain(name, options.domain)
  const path = options.path ?? '/'
  checkPath(name, path)
  const attributes: Attributes = {
    domain,
    path,
    secure: options.secure === true,
    httpOnly: options.httpOnly === true,
    sameSite: options.sameSite,
    partitioned: options.partitioned === true,
    priority: options.priority,
  }
  if (attributes.sameSite === 'none' && !attributes.secure) {
    throw invalid(name, 'SameSite=None requires secure: true (browsers reject it otherwise)')
  }
  if (attributes.partitioned && !attributes.secure) {
    throw invalid(name, 'partitioned cookies require secure: true')
  }
  checkPrefix(name, attributes)
  return attributes
}

/** `__Secure-`, `__Host-`, `__Http-`, `__Host-Http-` (case-insensitive, like browsers). */
function checkPrefix(name: string, attributes: Attributes): void {
  const lower = name.toLowerCase()
  const host = lower.startsWith('__host-')
  const http = lower.startsWith('__http-') || lower.startsWith('__host-http-')
  if (!host && !http && !lower.startsWith('__secure-')) return
  const prefix = prefixName(host, http)
  if (!attributes.secure) throw invalid(name, `the ${prefix} prefix requires secure: true`)
  if (http && !attributes.httpOnly) throw invalid(name, `the ${prefix} prefix requires httpOnly: true`)
  if (host) {
    if (attributes.domain !== undefined) throw invalid(name, `the ${prefix} prefix forbids a domain`)
    if (attributes.path !== '/') throw invalid(name, `the ${prefix} prefix requires path: '/'`)
  }
}

function checkName(name: string): void {
  if (!isCookieName(name)) {
    throw new TypeError(
      `Invalid cookie name ${describe(name)}: expected a token (letters, digits and ! # $ % & ' * + - . ^ _ \` | ~)`,
    )
  }
}

function encodeValue(name: string, value: string): string {
  if (typeof value !== 'string') throw invalid(name, `the value must be a string (received ${describe(value)})`)
  if (!value.isWellFormed()) throw invalid(name, 'the value contains a lone surrogate')
  return encodeCookieValue(value)
}

function checkSize(name: string, wire: string): void {
  const size = byteLength(name) + 1 + wire.length // the wire value is ASCII
  if (size > MAX_COOKIE_SIZE) {
    throw new RangeError(
      `Invalid cookie "${name}": name=value is ${size} bytes on the wire, above the limit of ${MAX_COOKIE_SIZE} (browsers drop it)`,
    )
  }
}

/** Checks the type of every option (and rejects unknown keys); returns the options. */
function checkOptions(name: string, options: CookieOptions | undefined, defaults = false): CookieOptions {
  if (options === undefined) return {}
  const what = defaults ? 'cookies.defaults' : 'options'
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalid(name, `${what} must be an object (received ${describe(options)})`)
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw invalid(name, `unknown option "${key}"`)
  }
  const { maxAge, expires, domain, path, secure, httpOnly, sameSite, partitioned, priority, signed } = options
  if (maxAge !== undefined && !(typeof maxAge === 'number' && Number.isSafeInteger(maxAge))) {
    throw invalid(name, `maxAge must be an integer number of seconds (received ${describe(maxAge)})`)
  }
  if (expires !== undefined && !(expires instanceof Date && !Number.isNaN(expires.getTime()))) {
    throw invalid(name, `expires must be a valid Date (received ${describe(expires)})`)
  }
  if (domain !== undefined && typeof domain !== 'string') {
    throw invalid(name, `domain must be a string (received ${describe(domain)})`)
  }
  if (path !== undefined && typeof path !== 'string') {
    throw invalid(name, `path must be a string (received ${describe(path)})`)
  }
  for (const [key, flag] of [
    ['secure', secure],
    ['httpOnly', httpOnly],
    ['partitioned', partitioned],
    ['signed', signed],
  ] as const) {
    if (flag !== undefined && typeof flag !== 'boolean') {
      throw invalid(name, `${key} must be a boolean (received ${describe(flag)})`)
    }
  }
  if (sameSite !== undefined && !Object.hasOwn(SAME_SITE, sameSite)) {
    throw invalid(name, `sameSite must be 'strict', 'lax' or 'none' (received ${describe(sameSite)})`)
  }
  if (priority !== undefined && !Object.hasOwn(PRIORITY, priority)) {
    throw invalid(name, `priority must be 'low', 'medium' or 'high' (received ${describe(priority)})`)
  }
  return options
}

/** Lower-cased, one leading `.` removed; an ASCII host name of at most 253 characters. */
function normalizeDomain(name: string, domain: string): string {
  const normalized = (domain.startsWith('.') ? domain.slice(1) : domain).toLowerCase()
  if (normalized.length > MAX_COOKIE_ATTRIBUTE_SIZE) {
    throw new RangeError(`Invalid cookie "${name}": the domain exceeds ${MAX_COOKIE_ATTRIBUTE_SIZE} bytes`)
  }
  if (!isHostName(normalized)) {
    throw invalid(
      name,
      `invalid domain ${describe(domain)}: expected an ASCII host name (letters, digits, -, dot-separated labels; IDNs in punycode)`,
    )
  }
  return normalized
}

function isHostName(domain: string): boolean {
  if (domain === '' || domain.length > MAX_DOMAIN_LENGTH) return false
  let label = 0
  for (let index = 0; index < domain.length; index++) {
    const code = domain.charCodeAt(index)
    if (code === 0x2e) {
      if (label === 0) return false
      label = 0
      continue
    }
    const valid = (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a) || code === 0x2d
    if (!valid) return false
    label++
  }
  return label > 0
}

/** Starts with `/`, `%x20-7E` except `;`, at most 1024 bytes. */
function checkPath(name: string, path: string): void {
  if (path.length > MAX_COOKIE_ATTRIBUTE_SIZE) {
    throw new RangeError(`Invalid cookie "${name}": the path exceeds ${MAX_COOKIE_ATTRIBUTE_SIZE} bytes`)
  }
  let valid = path.startsWith('/')
  for (let index = 0; valid && index < path.length; index++) {
    const code = path.charCodeAt(index)
    valid = code >= 0x20 && code <= 0x7e && code !== 0x3b
  }
  if (!valid) {
    throw invalid(name, `invalid path ${describe(path)}: expected "/..." made of visible ASCII characters without ";"`)
  }
}

/** The options without `undefined` values (they would erase defaults when spread). */
function definedOnly(options: CookieOptions): CookieOptions {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(options)) {
    const value = (options as Record<string, unknown>)[key]
    if (value !== undefined) result[key] = value
  }
  return result as CookieOptions
}

// -------------------------------------------------------------------------------------------------
// Set-Cookie parsing
// -------------------------------------------------------------------------------------------------

/**
 * Parses a `Set-Cookie` line (attribute names are case-insensitive; the value is decoded like a
 * request cookie). Used by `inject()` to fill `response.cookies`.
 *
 * @throws TypeError when the line has no `name=value` pair.
 */
export function parseSetCookie(line: string): SetCookieInfo {
  const parts = String(line).split(';')
  const pair = parts[0] as string
  const equals = pair.indexOf('=')
  const name = equals === -1 ? '' : trim(pair, 0, equals)
  if (name === '') throw new TypeError(`Invalid Set-Cookie line ${describe(line)}: missing name=value`)
  const info: {
    -readonly [K in keyof SetCookieInfo]: SetCookieInfo[K]
  } = {
    name,
    value: decodeCookieValue(unquote(trim(pair, equals + 1, pair.length))),
    raw: line,
    secure: false,
    httpOnly: false,
    partitioned: false,
  }
  for (const part of parts.slice(1)) {
    const separator = part.indexOf('=')
    const key = trim(part, 0, separator === -1 ? part.length : separator).toLowerCase()
    const value = separator === -1 ? '' : trim(part, separator + 1, part.length)
    switch (key) {
      case 'max-age': {
        const seconds = /^-?\d+$/.test(value) ? Number(value) : Number.NaN
        if (Number.isSafeInteger(seconds)) info.maxAge = seconds
        break
      }
      case 'expires': {
        const date = new Date(value)
        if (!Number.isNaN(date.getTime())) info.expires = date
        break
      }
      case 'domain':
        if (value !== '') info.domain = (value.startsWith('.') ? value.slice(1) : value).toLowerCase()
        break
      case 'path':
        if (value.startsWith('/')) info.path = value
        break
      case 'secure':
        info.secure = true
        break
      case 'httponly':
        info.httpOnly = true
        break
      case 'partitioned':
        info.partitioned = true
        break
      case 'samesite': {
        const sameSite = value.toLowerCase()
        if (sameSite === 'strict' || sameSite === 'lax' || sameSite === 'none') info.sameSite = sameSite
        break
      }
      case 'priority': {
        const priority = value.toLowerCase()
        if (priority === 'low' || priority === 'medium' || priority === 'high') info.priority = priority
        break
      }
      default:
        break
    }
  }
  return Object.freeze(info)
}

/** The `set-cookie` lines of a response parsed by name (the last one wins), prototype-less and frozen. */
export function parseSetCookies(
  lines: readonly string[] | string | undefined,
): Readonly<Record<string, SetCookieInfo>> {
  const result = Object.create(null) as Record<string, SetCookieInfo>
  const list = typeof lines === 'string' ? [lines] : (lines ?? [])
  for (const line of list) {
    try {
      const info = parseSetCookie(line)
      result[info.name] = info
    } catch {
      // not a cookie line: ignored
    }
  }
  return Object.freeze(result)
}

// -------------------------------------------------------------------------------------------------
// Jar
// -------------------------------------------------------------------------------------------------

/**
 * Cookies of a response in insertion order, keyed by name, domain and path: a later cookie with
 * the same key replaces the earlier one in place (set then clear gives one clearing cookie).
 */
export class CookieJar<T> {
  readonly #entries = new Map<string, T>()

  /** Adds or replaces (in place) the entry of `key`. */
  set(key: string, entry: T): void {
    this.#entries.set(key, entry)
  }

  get size(): number {
    return this.#entries.size
  }

  values(): T[] {
    return [...this.#entries.values()]
  }

  entries(): [string, T][] {
    return [...this.#entries.entries()]
  }
}

/**
 * The jar key of a cookie as given (`HttpResponse.withCookie()`, before the defaults are known):
 * an absent domain or path is keyed as "default".
 */
export function givenCookieKey(name: string, options: CookieOptions): string {
  const domain =
    options.domain === undefined
      ? '\u0001'
      : (options.domain.startsWith('.') ? options.domain.slice(1) : options.domain).toLowerCase()
  return `${name}\u0000${domain}\u0000${options.path ?? '\u0001'}`
}

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

function prefixName(host: boolean, http: boolean): string {
  if (host) return http ? '__Host-Http-' : '__Host-'
  return http ? '__Http-' : '__Secure-'
}

function invalid(name: string, reason: string): TypeError {
  return new TypeError(`Invalid cookie "${name}": ${reason}`)
}

function byteLength(text: string): number {
  let size = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) size += 1
    else if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff))
      size += 2 // a surrogate pair: 4 bytes
    else size += 3
  }
  return size
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value)
  if (value instanceof Date) return 'an invalid Date'
  if (value === null) return 'null'
  if (typeof value === 'object') return 'an object'
  return typeof value === 'bigint' ? `${value}n` : String(value)
}
