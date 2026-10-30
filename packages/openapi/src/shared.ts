/**
 * Import-free helpers shared by the compiler extension and the runtime (the compiler entry may
 * only reach modules of the package that import nothing at runtime).
 */

/** Grammar of operation ids. */
export const OPERATION_ID: RegExp = /^[A-Za-z_][\w.-]*$/

/** Grammar of HTTP header names (RFC 9110 token). */
export const HEADER_NAME: RegExp = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** A media type or a range (`application/json`, `image/*`, `*\/*`), parameters allowed. */
export const MEDIA_TYPE: RegExp =
  /^(?:\*\/\*|[\w!#$&^.+-]+\/(?:\*|[\w!#$&^.+-]+))(?:\s*;\s*[\w!#$&^.+-]+=(?:[\w!#$&^.+-]+|"[^"]*"))*$/

/** OpenAPI methods, in document order. */
export const METHOD_ORDER: readonly string[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch']

/** Reserved names of the standard error components. */
export const ERROR_COMPONENTS: { readonly body: 'HttpErrorBody'; readonly validation: 'ValidationErrorBody' } =
  Object.freeze({ body: 'HttpErrorBody', validation: 'ValidationErrorBody' })

/** Standard responses referenced by operations (`#/components/responses/<name>`). */
export const ERROR_RESPONSES: {
  readonly badRequest: 'BadRequest'
  readonly payloadTooLarge: 'PayloadTooLarge'
  readonly unsupportedMediaType: 'UnsupportedMediaType'
} = Object.freeze({
  badRequest: 'BadRequest',
  payloadTooLarge: 'PayloadTooLarge',
  unsupportedMediaType: 'UnsupportedMediaType',
})

/** The OpenAPI version of the documents. */
export const OPENAPI_VERSION = '3.1.1'

/** A component name: `[A-Za-z0-9._-]`, other characters replaced with `_`. */
export function componentName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? '_' : cleaned
}

/** `#/components/schemas/<name>`. */
export function schemaRef(name: string): string {
  return `#/components/schemas/${name}`
}

/** Code-point comparison of strings (deterministic across runtimes and locales). */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Deep equality of JSON-like values (key order ignored). */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEquals(item, b[index]))
  }
  const keysA = Object.keys(a).filter(key => (a as Record<string, unknown>)[key] !== undefined)
  const keysB = Object.keys(b).filter(key => (b as Record<string, unknown>)[key] !== undefined)
  if (keysA.length !== keysB.length) return false
  return keysA.every(key => jsonEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** JSON text with sorted object keys (fingerprints). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== 'object' || value === null) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort(compareStrings)) {
    const item = (value as Record<string, unknown>)[key]
    if (item !== undefined) sorted[key] = sortKeys(item)
  }
  return sorted
}

/** Reason phrases of the statuses documented by default (`description` of responses). */
const REASONS: Readonly<Record<number, string>> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
}

/** Description of a response without one: its reason phrase (`'2XX'` → `Success`). */
export function reasonPhrase(status: string): string {
  if (status === 'default') return 'Unexpected response'
  const range = /^([1-5])XX$/.exec(status)
  if (range) {
    return { '1': 'Informational', '2': 'Success', '3': 'Redirection', '4': 'Client error', '5': 'Server error' }[
      range[1] as '1' | '2' | '3' | '4' | '5'
    ]
  }
  return REASONS[Number(status)] ?? `Status ${status}`
}

/** `200`-`599` codes, `1XX`-`5XX` ranges, or `default`. */
export function isResponseStatus(status: string): boolean {
  return status === 'default' || /^[1-5]XX$/.test(status) || (/^[1-5]\d\d$/.test(status) && Number(status) >= 100)
}
