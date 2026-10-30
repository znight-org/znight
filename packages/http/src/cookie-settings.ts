/** Cookie settings of a plugin (defaults and signing key) and the operations using them (internal). */
import type { CookieSigner } from './cookie-signer.ts'

import {
  type CookieDefaults,
  DEFAULT_COOKIE_OPTIONS,
  decodeCookieValue,
  encodeCookieValue,
  type ResponseCookie,
  type SerializedCookie,
  serializeResponseCookie,
} from './cookies.ts'

/** The resolved plugin option `cookies`. */
export interface CookieSettings {
  /** Secure defaults merged with `cookies.defaults`. */
  readonly defaults: CookieDefaults
  /** `undefined` without `cookies.secrets` (signed cookies unavailable). */
  readonly signer: CookieSigner | undefined
}

/** Settings without plugin options: the secure defaults, no signing. */
export const DEFAULT_COOKIE_SETTINGS: CookieSettings = Object.freeze({
  defaults: DEFAULT_COOKIE_OPTIONS,
  signer: undefined,
})

/** The error of a signed cookie used without `cookies.secrets`. */
export function missingSecrets(action: string): Error {
  return new Error(
    `${action}: the HttpPlugin option cookies.secrets is not set (HttpPlugin.configure({ cookies: { secrets: [...] } }))`,
  )
}

/** Serialises a response cookie with the plugin settings (`signed: true` signs with the first secret). */
export function serializeWith(cookie: ResponseCookie, settings: CookieSettings): SerializedCookie {
  const signer = settings.signer
  if (cookie.value !== undefined && cookie.options.signed === true && signer === undefined) {
    throw missingSecrets(`Cannot sign the cookie "${cookie.name}"`)
  }
  return serializeResponseCookie(cookie, settings.defaults, (name, encoded) =>
    (signer as CookieSigner).sign(name, encoded),
  )
}

/**
 * The verified value of a signed request cookie (`value` as parsed, i.e. decoded), `undefined` when
 * absent, tampered or signed with an unknown key. The value is re-encoded canonically before the
 * MAC is checked (`encode(decode(w)) === w` for every value Znight signs).
 */
export function verifySigned(signer: CookieSigner, name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const dot = value.lastIndexOf('.')
  if (dot === -1) return undefined
  let encoded: string
  try {
    encoded = encodeCookieValue(value.slice(0, dot))
  } catch {
    return undefined
  }
  const verified = signer.verify(name, `${encoded}${value.slice(dot)}`)
  return verified === undefined ? undefined : decodeCookieValue(verified)
}

/** The signed wire value of `value` (encoded, then signed): what a client sends back. */
export function signValue(signer: CookieSigner, name: string, value: string): string {
  return signer.sign(name, encodeCookieValue(value))
}
