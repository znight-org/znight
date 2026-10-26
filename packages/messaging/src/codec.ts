import { MessageDecodeError } from './errors.ts'

/** An encoded body and its content type. */
export interface EncodedBody {
  readonly body: Uint8Array | string
  readonly contentType: string
}

/**
 * Converts payloads to bodies and back. The default {@link jsonCodec} handles JSON, text and binary
 * payloads; provide your own (MessagePack, Avro...) with `MessagingPlugin.configure({ codec })`.
 */
export interface MessageCodec {
  /**
   * Encodes a payload for publication. `contentType` is the one requested by the publisher, if any
   * (`publish(queue, payload, { contentType })`).
   */
  encode(payload: unknown, contentType: string | undefined): EncodedBody
  /**
   * Decodes a received body. Throw a {@link MessageDecodeError} (a `NonRetryableError`) for malformed
   * bodies: the message is dead-lettered with reason `decode`.
   */
  decode(body: Uint8Array | string, contentType: string | undefined): unknown
}

export const JSON_CONTENT_TYPE = 'application/json'
export const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8'
export const BINARY_CONTENT_TYPE = 'application/octet-stream'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

/** Body as text (UTF-8). */
export function bodyToText(body: Uint8Array | string): string {
  return typeof body === 'string' ? body : decoder.decode(body)
}

/** Body as bytes (UTF-8 for strings). */
export function bodyToBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === 'string' ? encoder.encode(body) : body
}

/** Lower-cased media type without parameters (`application/json; charset=utf-8` → `application/json`). */
export function mediaType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined
  const value = contentType.split(';', 1)[0]?.trim().toLowerCase()
  return value === '' ? undefined : value
}

function isJson(type: string): boolean {
  return type === JSON_CONTENT_TYPE || type.endsWith('+json')
}

/**
 * The default codec.
 *
 * - encode: `Uint8Array` → `application/octet-stream`; a `string` with an explicit text/binary
 *   `contentType` is sent as is; everything else is JSON (`application/json`), including strings.
 *   `undefined` is an empty JSON body.
 * - decode: JSON (`application/json`, `*+json`) is parsed (empty body → `undefined`; malformed →
 *   `MessageDecodeError`); `text/*` → string; other declared types → `Uint8Array`. Without content
 *   type, JSON is attempted and the text is returned when it is not valid JSON.
 */
export const jsonCodec: MessageCodec = Object.freeze({
  encode(payload: unknown, contentType: string | undefined): EncodedBody {
    const type = mediaType(contentType)
    if (payload instanceof Uint8Array) return { body: payload, contentType: contentType ?? BINARY_CONTENT_TYPE }
    if (typeof payload === 'string' && type !== undefined && !isJson(type))
      return { body: payload, contentType: contentType as string }
    if (payload === undefined) return { body: '', contentType: contentType ?? JSON_CONTENT_TYPE }
    const json = JSON.stringify(payload)
    if (json === undefined) throw new TypeError(`[znight] Cannot encode a ${typeof payload} payload as JSON`)
    return { body: json, contentType: contentType ?? JSON_CONTENT_TYPE }
  },
  decode(body: Uint8Array | string, contentType: string | undefined): unknown {
    const type = mediaType(contentType)
    if (type === undefined) {
      const text = bodyToText(body)
      if (text === '') return undefined
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    if (isJson(type)) {
      const text = bodyToText(body)
      if (text.trim() === '') return undefined
      try {
        return JSON.parse(text)
      } catch (error) {
        throw new MessageDecodeError(`Malformed JSON body: ${(error as Error).message}`, { cause: error })
      }
    }
    if (type.startsWith('text/')) return bodyToText(body)
    return bodyToBytes(body)
  },
})
