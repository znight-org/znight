/** Exceptions of WebSocket handlers and their wire codes (RFC 0003 §5.3, §5.8). */

/** Built-in error codes of the wire protocol. */
export const WsErrorCode = {
  BadFrame: 'BAD_FRAME',
  UnsupportedFrame: 'UNSUPPORTED_FRAME',
  BadRequest: 'BAD_REQUEST',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  Unprocessable: 'UNPROCESSABLE',
  RateLimited: 'RATE_LIMITED',
  UnknownEvent: 'UNKNOWN_EVENT',
  Timeout: 'TIMEOUT',
  Internal: 'INTERNAL',
} as const

/** Close codes used by the runtime (RFC 0003 §5.8, normative). */
export const WsCloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  PolicyViolation: 1008,
  MessageTooBig: 1009,
  InternalError: 1011,
  TryAgainLater: 1013,
} as const

/** Options of {@link WsException}. */
export interface WsExceptionOptions {
  /** Close the connection with this code after replying. */
  readonly close?: number
  readonly cause?: unknown
}

/**
 * An error a handler or a message guard throws to answer the client: a reply with an `id`, an
 * `$error` event otherwise, then a close when `close` is set.
 *
 * ```ts
 * throw new WsException('FORBIDDEN', 'Join the room first')
 * ```
 */
export class WsException extends Error {
  readonly code: string
  readonly details: unknown
  readonly close: number | undefined

  constructor(code: string, message?: string, details?: unknown, options: WsExceptionOptions = {}) {
    super(message ?? code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WsException'
    this.code = code
    this.details = details
    this.close = options.close
  }
}

/** One issue of a {@link WsValidationException}. */
export interface WsValidationIssue {
  readonly path: string
  readonly message: string
}

/** A payload failed its schema: `BAD_REQUEST` with `details: [{ path, message }]`. */
export class WsValidationException extends WsException {
  readonly issues: readonly WsValidationIssue[]

  constructor(issues: readonly WsValidationIssue[], message = 'Invalid payload') {
    super(WsErrorCode.BadRequest, message, issues)
    this.name = 'WsValidationException'
    this.issues = issues
  }
}

const BY_STATUS: Readonly<Record<number, string>> = {
  400: WsErrorCode.BadRequest,
  401: WsErrorCode.Unauthorized,
  403: WsErrorCode.Forbidden,
  404: WsErrorCode.NotFound,
  409: WsErrorCode.Conflict,
  422: WsErrorCode.Unprocessable,
  429: WsErrorCode.RateLimited,
}

/**
 * The wire code of an HTTP status thrown by a service (`HttpException`): the table of RFC 0003
 * §5.8, `INTERNAL` for 5xx and unknown statuses.
 */
export function codeOfStatus(status: number): string {
  return BY_STATUS[status] ?? (status >= 400 && status < 500 ? WsErrorCode.BadRequest : WsErrorCode.Internal)
}
