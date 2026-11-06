/** The envelope of `events` gateways (RFC 0003 §5.3): decoding inbound frames, encoding outbound ones. */
import { WsErrorCode } from './exceptions.ts'

/** Event names: `^[A-Za-z][\w.:/-]{0,127}$`; names starting with `$` are reserved. */
export const EVENT_NAME: RegExp = /^[A-Za-z][\w.:/-]{0,127}$/

/** A message id: a string of at most 64 characters or a safe integer, chosen by the client. */
export type MessageId = string | number

/** A decoded inbound message. */
export interface InboundMessage {
  readonly event: string
  readonly data: unknown
  /** Present when the client expects exactly one reply. */
  readonly id: MessageId | undefined
}

/** A frame that could not be decoded: answered with `$error` (or a reply when the id was readable). */
export interface InboundFailure {
  readonly error: string
  readonly message: string
  readonly id: MessageId | undefined
}

/** The wire error of a reply or of an `$error` event. */
export interface WireError {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

/** Whether `value` is a valid message id. */
export function isMessageId(value: unknown): value is MessageId {
  return (typeof value === 'string' && value.length <= 64) || Number.isSafeInteger(value)
}

/**
 * Decodes an inbound frame of an `events` gateway with the JSON codec: a binary frame is
 * `UNSUPPORTED_FRAME`, anything but a JSON object with a string `event` is `BAD_FRAME`. Unknown
 * fields are ignored.
 */
export function decodeFrame(frame: string | Uint8Array): InboundMessage | InboundFailure {
  if (typeof frame !== 'string') {
    return { error: WsErrorCode.UnsupportedFrame, message: 'Binary frames are not supported', id: undefined }
  }
  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch {
    return { error: WsErrorCode.BadFrame, message: 'The frame is not valid JSON', id: undefined }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: WsErrorCode.BadFrame, message: 'The frame must be a JSON object', id: undefined }
  }
  const record = value as Record<string, unknown>
  const rawId = record['id']
  const id = isMessageId(rawId) ? rawId : undefined
  if (rawId !== undefined && id === undefined) {
    return { error: WsErrorCode.BadFrame, message: 'Invalid message id', id: undefined }
  }
  const event = record['event']
  if (typeof event !== 'string') return { error: WsErrorCode.BadFrame, message: 'Missing event name', id }
  return { event, data: record['data'], id }
}

/** Whether a decoded frame is a failure. */
export function isFailure(decoded: InboundMessage | InboundFailure): decoded is InboundFailure {
  return 'error' in decoded
}

/** A success reply: `{ id, data }`, `data` omitted when `undefined`. */
export function encodeReply(id: MessageId, data: unknown): string {
  return data === undefined ? JSON.stringify({ id }) : JSON.stringify({ id, data })
}

/** A failure reply: `{ id, error }`. */
export function encodeErrorReply(id: MessageId, error: WireError): string {
  return JSON.stringify({ id, error: wireError(error) })
}

/** A server event: `{ event, data }`. */
export function encodeEvent(event: string, data: unknown): string {
  return data === undefined ? JSON.stringify({ event }) : JSON.stringify({ event, data })
}

/** The failure of a message without id: `{ event: '$error', data: { event, code, message, details? } }`. */
export function encodeErrorEvent(event: string | undefined, error: WireError): string {
  return JSON.stringify({ event: '$error', data: { ...(event === undefined ? {} : { event }), ...wireError(error) } })
}

function wireError(error: WireError): WireError {
  return error.details === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, details: error.details }
}
