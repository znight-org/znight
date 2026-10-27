/**
 * Security headers (RFC 0001 §5.5): validated and computed once at boot, then added to every reply
 * (except `@Res()` raw replies) when the handler, an interceptor, an exception or a hook wrapper did
 * not set them.
 */
import { isHeaderValue } from './headers.ts'
import { invalidOption } from './option-error.ts'

/** HSTS settings (`strict-transport-security`). */
export interface HstsOptions {
  /** `max-age`, in seconds. Default `31536000` (one year). */
  readonly maxAge?: number
  /** `includeSubDomains`. Default `true`. */
  readonly includeSubDomains?: boolean
  /** `preload` (needs `includeSubDomains` and a `maxAge` of at least one year). Default `false`. */
  readonly preload?: boolean
}

/** The `securityHeaders` option of `HttpPlugin.configure` (merged over the defaults). */
export interface SecurityHeadersOptions {
  /** `content-security-policy`. Default `"default-src 'none'; frame-ancestors 'none'"`. */
  readonly contentSecurityPolicy?: string | false
  /** `x-frame-options`. Default `'DENY'`. */
  readonly frameOptions?: 'DENY' | 'SAMEORIGIN' | false
  /** `x-content-type-options: nosniff`. Default `true`. */
  readonly noSniff?: boolean
  /** `referrer-policy` (a policy or a comma-separated fallback list). Default `'no-referrer'`. */
  readonly referrerPolicy?: string | false
  /** `strict-transport-security`. Default `false`; `true`: `max-age=31536000; includeSubDomains`. */
  readonly hsts?: boolean | HstsOptions
  /** `cross-origin-resource-policy`. Default `false`. */
  readonly crossOriginResourcePolicy?: 'same-origin' | 'same-site' | 'cross-origin' | false
  /** `cache-control` of replies that do not set one (`'no-store'` for personal data). Default `false`. */
  readonly cacheControl?: string | false
}

const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'"
const ONE_YEAR = 31_536_000
const KEYS = new Set([
  'contentSecurityPolicy',
  'frameOptions',
  'noSniff',
  'referrerPolicy',
  'hsts',
  'crossOriginResourcePolicy',
  'cacheControl',
])
const REFERRER_POLICIES = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
])
const RESOURCE_POLICIES = new Set(['same-origin', 'same-site', 'cross-origin'])
const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({})

/**
 * Validates the `securityHeaders` option (ZNIGHT005) and returns the headers to add, frozen
 * (`{}` when disabled).
 */
export function resolveSecurityHeaders(
  value: boolean | SecurityHeadersOptions | undefined,
): Readonly<Record<string, string>> {
  if (value === false) return NO_HEADERS
  if (value !== undefined && value !== true && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw invalidOption('securityHeaders', 'a boolean or an object of header settings', value)
  }
  const options: SecurityHeadersOptions = value === undefined || value === true ? {} : value
  for (const key of Object.keys(options)) {
    if (!KEYS.has(key)) {
      throw invalidOption('securityHeaders', `an object with ${[...KEYS].join(', ')} (unknown "${key}")`, options)
    }
  }
  const headers: Record<string, string> = {}
  const csp = options.contentSecurityPolicy ?? DEFAULT_CSP
  if (csp !== false) headers['content-security-policy'] = text('securityHeaders.contentSecurityPolicy', csp)
  const frame = options.frameOptions ?? 'DENY'
  if (frame !== false) {
    if (frame !== 'DENY' && frame !== 'SAMEORIGIN') {
      throw invalidOption('securityHeaders.frameOptions', '"DENY", "SAMEORIGIN" or false', frame)
    }
    headers['x-frame-options'] = frame
  }
  const noSniff = options.noSniff ?? true
  if (typeof noSniff !== 'boolean') throw invalidOption('securityHeaders.noSniff', 'a boolean', noSniff)
  if (noSniff) headers['x-content-type-options'] = 'nosniff'
  const referrer = options.referrerPolicy ?? 'no-referrer'
  if (referrer !== false) headers['referrer-policy'] = referrerPolicy(referrer)
  const hsts = strictTransportSecurity(options.hsts ?? false)
  if (hsts !== undefined) headers['strict-transport-security'] = hsts
  const corp = options.crossOriginResourcePolicy ?? false
  if (corp !== false) {
    if (typeof corp !== 'string' || !RESOURCE_POLICIES.has(corp)) {
      throw invalidOption(
        'securityHeaders.crossOriginResourcePolicy',
        '"same-origin", "same-site", "cross-origin" or false',
        corp,
      )
    }
    headers['cross-origin-resource-policy'] = corp
  }
  const cacheControl = options.cacheControl ?? false
  if (cacheControl !== false) headers['cache-control'] = text('securityHeaders.cacheControl', cacheControl)
  return Object.freeze(headers)
}

function text(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || !isHeaderValue(value)) {
    throw invalidOption(name, 'a non-empty header value (or false)', value)
  }
  return value
}

function referrerPolicy(value: unknown): string {
  const policies = typeof value === 'string' ? value.split(',').map(item => item.trim()) : []
  if (policies.length === 0 || !policies.every(policy => REFERRER_POLICIES.has(policy))) {
    throw invalidOption(
      'securityHeaders.referrerPolicy',
      `a referrer policy (${[...REFERRER_POLICIES].join(', ')}) or false`,
      value,
    )
  }
  return policies.join(', ')
}

function strictTransportSecurity(value: boolean | HstsOptions): string | undefined {
  if (value === false) return undefined
  if (value !== true && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw invalidOption('securityHeaders.hsts', 'a boolean or { maxAge?, includeSubDomains?, preload? }', value)
  }
  const options: HstsOptions = value === true ? {} : value
  for (const key of Object.keys(options)) {
    if (key !== 'maxAge' && key !== 'includeSubDomains' && key !== 'preload') {
      throw invalidOption('securityHeaders.hsts', '{ maxAge?, includeSubDomains?, preload? }', options)
    }
  }
  const maxAge = options.maxAge ?? ONE_YEAR
  if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw invalidOption('securityHeaders.hsts.maxAge', 'a positive integer number of seconds', maxAge)
  }
  const includeSubDomains = options.includeSubDomains ?? true
  if (typeof includeSubDomains !== 'boolean') {
    throw invalidOption('securityHeaders.hsts.includeSubDomains', 'a boolean', includeSubDomains)
  }
  const preload = options.preload ?? false
  if (typeof preload !== 'boolean') throw invalidOption('securityHeaders.hsts.preload', 'a boolean', preload)
  if (preload && (!includeSubDomains || maxAge < ONE_YEAR)) {
    throw invalidOption(
      'securityHeaders.hsts',
      'includeSubDomains and a maxAge of at least 31536000 with preload',
      options,
      undefined,
      ['The HSTS preload list requires includeSubDomains and max-age >= 31536000'],
    )
  }
  return `max-age=${maxAge}${includeSubDomains ? '; includeSubDomains' : ''}${preload ? '; preload' : ''}`
}
