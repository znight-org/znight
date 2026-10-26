import type { StandardSchemaV1Issue } from './standard-schema.ts'

import { isValidStatus, statusText } from './status.ts'

/** Response header values: a single value or several (`set-cookie`). */
export type HeaderValue = string | readonly string[]

/** Options of {@link HttpException}. */
export interface HttpExceptionOptions extends ErrorOptions {
  /** Headers added to the error response (`www-authenticate`, `retry-after`, `allow`...). */
  readonly headers?: Readonly<Record<string, HeaderValue>>
}

/** JSON body of an error response. */
export interface HttpErrorBody {
  readonly statusCode: number
  /** Reason phrase of the status (`Not Found`). */
  readonly error: string
  readonly message: string
  /** Structured details (validation issues...), omitted when absent. */
  readonly details?: unknown
}

/** One entry of the `details` of a validation error. */
export interface ValidationIssueDetail {
  /** Dotted path of the invalid value inside the validated input (`user.email`, `items.0`), `''` for the root. */
  readonly path: string
  readonly message: string
}

const NO_HEADERS: Readonly<Record<string, HeaderValue>> = Object.freeze({})

/**
 * An error carrying an HTTP status. Thrown from handlers, guards, interceptors or services, it is
 * rendered as `{ statusCode, error, message, details? }` with its status and headers.
 *
 * ```ts
 * throw new HttpException(409, 'Email already used', { field: 'email' })
 * throw new NotFoundException(`User ${id} not found`)
 * throw new UnauthorizedException('Token expired', undefined, { headers: { 'www-authenticate': 'Bearer' } })
 * ```
 *
 * Invalid statuses (not an integer in 100–599) become `500`.
 */
export class HttpException extends Error {
  /** HTTP status of the response. */
  readonly status: number
  /** Structured details rendered in the body (omitted when `undefined`). */
  readonly details: unknown
  /** Headers added to the response. */
  readonly headers: Readonly<Record<string, HeaderValue>>

  constructor(status: number, message?: string, details?: unknown, options: HttpExceptionOptions = {}) {
    const code = isValidStatus(status) ? status : 500
    super(message ?? statusText(code), options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HttpException'
    this.status = code
    this.details = details
    this.headers = options.headers ?? NO_HEADERS
  }

  /** The `statusCode` field of the body (alias of {@link status}). */
  get statusCode(): number {
    return this.status
  }

  /** Body of the error response. Override it in a subclass to change the shape. */
  toBody(): HttpErrorBody {
    const body: { statusCode: number; error: string; message: string; details?: unknown } = {
      statusCode: this.status,
      error: statusText(this.status),
      message: this.message,
    }
    if (this.details !== undefined) body.details = this.details
    return body
  }
}

/** Whether `value` is an {@link HttpException} (also across duplicated package copies). */
export function isHttpException(value: unknown): value is HttpException {
  return (
    value instanceof HttpException ||
    (value instanceof Error &&
      typeof (value as { status?: unknown }).status === 'number' &&
      typeof (value as { toBody?: unknown }).toBody === 'function')
  )
}

/** 400 Bad Request. */
export class BadRequestException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(400, message, details, options)
    this.name = 'BadRequestException'
  }
}

/**
 * 400 Bad Request raised when an input fails its schema (`@Body(schema)`, `@Query(schema)`...).
 * `details` lists the issues as `{ path, message }`; the raw Standard Schema issues are kept in
 * {@link issues} for exception mappers.
 */
export class ValidationException extends BadRequestException {
  /** What was validated: `body`, `query`, `query "page"`, `param "id"`... */
  readonly location: string
  readonly issues: readonly StandardSchemaV1Issue[]

  constructor(location: string, issues: readonly StandardSchemaV1Issue[], options?: HttpExceptionOptions) {
    super(`Invalid ${location}`, issues.map(toIssueDetail), options)
    this.name = 'ValidationException'
    this.location = location
    this.issues = issues
  }
}

/** Converts a Standard Schema issue to `{ path, message }` (`path` dotted, `''` for the root). */
export function toIssueDetail(issue: StandardSchemaV1Issue): ValidationIssueDetail {
  return { path: formatIssuePath(issue.path), message: issue.message }
}

function formatIssuePath(path: StandardSchemaV1Issue['path']): string {
  if (path === undefined || path.length === 0) return ''
  let result = ''
  for (const segment of path) {
    const key = typeof segment === 'object' && segment !== null ? segment.key : segment
    const text = typeof key === 'symbol' ? (key.description ?? 'symbol') : String(key)
    result = result === '' ? text : `${result}.${text}`
  }
  return result
}

/** 401 Unauthorized. */
export class UnauthorizedException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(401, message, details, options)
    this.name = 'UnauthorizedException'
  }
}

/** 403 Forbidden (also the response of a guard returning `false`). */
export class ForbiddenException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(403, message, details, options)
    this.name = 'ForbiddenException'
  }
}

/** 404 Not Found. */
export class NotFoundException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(404, message, details, options)
    this.name = 'NotFoundException'
  }
}

/** 405 Method Not Allowed (pass the `allow` header in `options.headers`). */
export class MethodNotAllowedException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(405, message, details, options)
    this.name = 'MethodNotAllowedException'
  }
}

/** 409 Conflict. */
export class ConflictException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(409, message, details, options)
    this.name = 'ConflictException'
  }
}

/** 410 Gone. */
export class GoneException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(410, message, details, options)
    this.name = 'GoneException'
  }
}

/** 413 Payload Too Large (request body above `bodyLimit`). */
export class PayloadTooLargeException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(413, message, details, options)
    this.name = 'PayloadTooLargeException'
  }
}

/** 415 Unsupported Media Type. */
export class UnsupportedMediaTypeException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(415, message, details, options)
    this.name = 'UnsupportedMediaTypeException'
  }
}

/** 422 Unprocessable Entity. */
export class UnprocessableEntityException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(422, message, details, options)
    this.name = 'UnprocessableEntityException'
  }
}

/** 429 Too Many Requests (pass `retry-after` in `options.headers`). */
export class TooManyRequestsException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(429, message, details, options)
    this.name = 'TooManyRequestsException'
  }
}

/** 500 Internal Server Error (its message is always sent, unlike unexpected errors). */
export class InternalServerErrorException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(500, message, details, options)
    this.name = 'InternalServerErrorException'
  }
}

/** 501 Not Implemented. */
export class NotImplementedException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(501, message, details, options)
    this.name = 'NotImplementedException'
  }
}

/** 502 Bad Gateway. */
export class BadGatewayException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(502, message, details, options)
    this.name = 'BadGatewayException'
  }
}

/** 503 Service Unavailable. */
export class ServiceUnavailableException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(503, message, details, options)
    this.name = 'ServiceUnavailableException'
  }
}

/** 504 Gateway Timeout. */
export class GatewayTimeoutException extends HttpException {
  constructor(message?: string, details?: unknown, options?: HttpExceptionOptions) {
    super(504, message, details, options)
    this.name = 'GatewayTimeoutException'
  }
}
