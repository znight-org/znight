/**
 * CORS policy (RFC 0001 §5.4): option validation and the headers of preflights and replies. Pure:
 * the pipeline decides when to apply it (preflights are answered before routing and guards, the
 * same way on every adapter).
 */
import type { HeaderValue } from './exceptions.ts'

import { isHeaderName } from './headers.ts'
import { invalidOption } from './option-error.ts'

/**
 * Origins allowed to read responses: `'*'` (any origin), an exact origin
 * (`'https://app.example.com'`), an anchored `RegExp` (`/^https:\/\/[a-z0-9-]+\.example\.com$/`), a
 * list of those, or a function (awaited; a function that throws or rejects denies the origin).
 */
export type CorsOrigin =
  | '*'
  | string
  | RegExp
  | readonly (string | RegExp)[]
  | ((origin: string) => boolean | Promise<boolean>)

/** The `cors` option of `HttpPlugin.configure`. */
export interface CorsOptions {
  /** Allowed origins (required). */
  readonly origin: CorsOrigin
  /** `access-control-allow-credentials: true` (cookies, `Authorization`). Not with `'*'`. Default `false`. */
  readonly credentials?: boolean
  /** `access-control-allow-methods` of preflights. Default: the methods routed on the requested path. */
  readonly methods?: readonly string[]
  /**
   * `access-control-allow-headers` of preflights. Default: the headers the browser asks for
   * (`access-control-request-headers`). `'*'` is refused with `credentials`.
   */
  readonly allowHeaders?: readonly string[] | '*'
  /** `access-control-expose-headers` of replies. Default: the request id header (none when it is `false`). */
  readonly exposeHeaders?: readonly string[]
  /** `access-control-max-age` of preflights, in seconds (0 to 86400). Default `600`. */
  readonly maxAge?: number
}

/** A resolved CORS policy (internal). */
export interface CorsPolicy {
  /** Any origin is allowed: `access-control-allow-origin: *`. */
  readonly wildcard: boolean
  /** Replies get `vary: origin` (every policy but `origin: '*'`). */
  readonly varyOrigin: boolean
  readonly credentials: boolean
  /** Joined `methods`, `undefined` for the default (the methods of the path). */
  readonly methods: string | undefined
  /** Joined `allowHeaders` or `*`, `undefined` for the default (echo the request). */
  readonly allowHeaders: string | undefined
  /** Joined `exposeHeaders`, `undefined` when there are none. */
  readonly exposeHeaders: string | undefined
  readonly maxAge: string
  /** Whether `origin` (the request `origin` header) is allowed. May throw or reject: the caller denies it then. */
  allows(origin: string): boolean | Promise<boolean>
}

const KEYS = new Set(['origin', 'credentials', 'methods', 'allowHeaders', 'exposeHeaders', 'maxAge'])
/** RFC 9110 token (methods). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MAX_AGE_LIMIT = 86_400
const DEFAULT_MAX_AGE = 600
const PREFLIGHT_VARY = 'origin, access-control-request-method, access-control-request-headers'

/** Validates the `cors` option (ZNIGHT005). `undefined` / `false`: CORS is disabled. */
export function resolveCors(
  options: CorsOptions | false | undefined,
  requestIdHeader: string | undefined,
): CorsPolicy | undefined {
  if (options === undefined || options === false) return undefined
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidOption(
      'cors',
      '{ origin, credentials?, methods?, allowHeaders?, exposeHeaders?, maxAge? } or false',
      options,
    )
  }
  for (const key of Object.keys(options)) {
    if (!KEYS.has(key)) {
      throw invalidOption('cors', '{ origin, credentials?, methods?, allowHeaders?, exposeHeaders?, maxAge? }', options)
    }
  }
  const credentials = options.credentials ?? false
  if (typeof credentials !== 'boolean') throw invalidOption('cors.credentials', 'a boolean', credentials)
  const origin = resolveOrigin(options.origin)
  if (credentials && origin.wildcard) {
    throw invalidOption(
      'cors.origin',
      "explicit origins when credentials is true (not '*')",
      options.origin,
      undefined,
      ["Browsers reject 'access-control-allow-origin: *' on credentialed requests: list the origins"],
    )
  }
  const methods = tokenList('cors.methods', options.methods, TOKEN, 'HTTP method names')
  let allowHeaders: string | undefined
  if (options.allowHeaders === '*') {
    if (credentials) {
      throw invalidOption(
        'cors.allowHeaders',
        "a list of header names when credentials is true (not '*')",
        '*',
        undefined,
        ["Browsers ignore 'access-control-allow-headers: *' on credentialed requests"],
      )
    }
    allowHeaders = '*'
  } else {
    allowHeaders = headerList('cors.allowHeaders', options.allowHeaders)
  }
  const expose =
    options.exposeHeaders === undefined ? requestIdHeader : headerList('cors.exposeHeaders', options.exposeHeaders)
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE
  if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > MAX_AGE_LIMIT) {
    throw invalidOption('cors.maxAge', `an integer number of seconds between 0 and ${MAX_AGE_LIMIT}`, maxAge)
  }
  return Object.freeze({
    wildcard: origin.wildcard,
    varyOrigin: options.origin !== '*',
    credentials,
    methods,
    allowHeaders,
    exposeHeaders: expose === '' ? undefined : expose,
    maxAge: String(maxAge),
    allows: origin.allows,
  })
}

interface ResolvedOrigin {
  readonly wildcard: boolean
  readonly allows: (origin: string) => boolean | Promise<boolean>
}

function resolveOrigin(value: CorsOrigin | undefined): ResolvedOrigin {
  if (value === undefined) {
    throw invalidOption(
      'cors.origin',
      "'*', an origin, an anchored RegExp, a list of them or a function",
      value,
      undefined,
      ["cors: { origin: 'https://app.example.com' }"],
    )
  }
  if (typeof value === 'function') {
    return { wildcard: false, allows: value }
  }
  const items: readonly unknown[] = Array.isArray(value) ? value : [value]
  const exact = new Set<string>()
  const patterns: RegExp[] = []
  let wildcard = false
  for (const item of items) {
    if (item === '*') wildcard = true
    else if (typeof item === 'string') exact.add(checkOrigin(item))
    else if (item instanceof RegExp) patterns.push(checkPattern(item))
    else {
      throw invalidOption('cors.origin', "'*', an origin, an anchored RegExp, a list of them or a function", value)
    }
  }
  if (wildcard) return { wildcard: true, allows: () => true }
  return {
    wildcard: false,
    allows: (origin: string): boolean => exact.has(origin) || patterns.some(pattern => pattern.test(origin)),
  }
}

/** An origin must be written exactly as browsers send it: `scheme://host[:port]`. */
function checkOrigin(value: string): string {
  if (value === 'null') {
    throw invalidOption('cors.origin', 'a real origin', value, undefined, [
      'The "null" origin is shared by sandboxed iframes, local files and redirects: never trust it',
    ])
  }
  let url: URL | undefined
  try {
    url = new URL(value)
  } catch {
    url = undefined
  }
  if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw invalidOption('cors.origin', 'an http(s) origin such as "https://app.example.com"', value)
  }
  if (url.origin !== value) {
    throw invalidOption(
      'cors.origin',
      `an origin without path, trailing slash or default port ("${url.origin}")`,
      value,
      undefined,
      [`Write "${url.origin}": browsers send the origin in this exact form`],
    )
  }
  return value
}

function checkPattern(pattern: RegExp): RegExp {
  const source = pattern.source
  const trailingBackslashes = /\\*\$$/.exec(source)?.[0].length ?? 0
  // `\$` at the end matches a dollar sign: the pattern is not anchored
  const anchoredEnd = source.endsWith('$') && (trailingBackslashes - 1) % 2 === 0
  if (!source.startsWith('^') || !anchoredEnd) {
    throw invalidOption('cors.origin', 'a RegExp anchored with ^ and $', pattern, undefined, [
      'Without anchors, /example\\.com/ also allows https://example.com.evil.net',
    ])
  }
  if (hasTopLevelAlternation(source)) {
    throw invalidOption('cors.origin', 'a RegExp anchored with ^ and $ around every alternative', pattern, undefined, [
      'In /^a|b$/ the anchors bind to one alternative each: write /^(?:a|b)$/',
    ])
  }
  if (pattern.global || pattern.sticky) {
    throw invalidOption('cors.origin', 'a RegExp without the g or y flag (test() would be stateful)', pattern)
  }
  return pattern
}

/** Whether a pattern source has a `|` outside any group and character class. */
function hasTopLevelAlternation(source: string): boolean {
  let depth = 0
  let inClass = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '\\') {
      index++
    } else if (inClass) {
      if (char === ']') inClass = false
    } else if (char === '[') {
      inClass = true
    } else if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
    } else if (char === '|' && depth === 0) {
      return true
    }
  }
  return false
}

function tokenList(name: string, value: unknown, grammar: RegExp, what: string): string | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && grammar.test(item))) {
    throw invalidOption(name, `an array of ${what}`, value)
  }
  return value.join(', ')
}

function headerList(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && isHeaderName(item))) {
    throw invalidOption(name, 'an array of header names', value)
  }
  return value.map((item: string) => item.toLowerCase()).join(', ')
}

/**
 * Whether a request is a CORS preflight: `OPTIONS` with `origin` and
 * `access-control-request-method`.
 */
export function isPreflight(method: string, headers: Readonly<Record<string, string | undefined>>): boolean {
  return (
    method === 'OPTIONS' && headers['origin'] !== undefined && headers['access-control-request-method'] !== undefined
  )
}

/** Headers of a `204` preflight answer for an allowed origin. */
export function preflightHeaders(
  policy: CorsPolicy,
  origin: string,
  requestHeaders: Readonly<Record<string, string | undefined>>,
  allow: string,
): Record<string, HeaderValue> {
  const headers: Record<string, HeaderValue> = {
    'access-control-allow-origin': policy.wildcard ? '*' : origin,
  }
  if (policy.credentials) headers['access-control-allow-credentials'] = 'true'
  const methods = policy.methods ?? allow
  if (methods !== '') headers['access-control-allow-methods'] = methods
  const allowHeaders = policy.allowHeaders ?? requestedHeaders(requestHeaders['access-control-request-headers'])
  if (allowHeaders !== undefined && allowHeaders !== '') headers['access-control-allow-headers'] = allowHeaders
  headers['access-control-max-age'] = policy.maxAge
  headers['allow'] = allow
  headers['vary'] = PREFLIGHT_VARY
  return headers
}

/** `access-control-request-headers` when it is a valid list of header names, lower-cased. */
function requestedHeaders(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const names: string[] = []
  for (const item of value.split(',')) {
    const name = item.trim()
    if (name === '') continue
    if (!isHeaderName(name)) return undefined
    names.push(name.toLowerCase())
  }
  return names.length === 0 ? undefined : names.join(', ')
}

/** CORS headers of a reply to an allowed origin (added when missing). */
export function corsReplyHeaders(policy: CorsPolicy, origin: string): Record<string, HeaderValue> {
  const headers: Record<string, HeaderValue> = { 'access-control-allow-origin': policy.wildcard ? '*' : origin }
  if (policy.credentials) headers['access-control-allow-credentials'] = 'true'
  if (policy.exposeHeaders !== undefined) headers['access-control-expose-headers'] = policy.exposeHeaders
  return headers
}

/** Adds `token` to the `vary` header, unless it (or `*`) is already listed. */
export function mergeVary(headers: Record<string, HeaderValue>, token: string): void {
  const existing = headers['vary']
  if (existing === undefined) {
    headers['vary'] = token
    return
  }
  const text = typeof existing === 'string' ? existing : existing.join(', ')
  const tokens = text.split(',').map(item => item.trim().toLowerCase())
  if (tokens.includes('*') || tokens.includes(token)) return
  headers['vary'] = text.trim() === '' ? token : `${text}, ${token}`
}
