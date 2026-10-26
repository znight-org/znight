import type { ReplyBody } from './adapter.ts'
import type { HeaderValue, HttpErrorBody } from './exceptions.ts'
import type { ResolvedFile } from './files.ts'
import type { HttpResponse } from './response.ts'

import { Readable } from 'node:stream'

import { isFileBody } from './files.ts'
import { isHttpResponse } from './response.ts'
import { isBodylessStatus } from './status.ts'
import { discardStream, toByteStream } from './stream.ts'
import { emptyRecord } from './utils.ts'

const ENCODER = new TextEncoder()

/** Content types set by the serialiser. */
export const ContentType: {
  readonly json: string
  readonly text: string
  readonly bytes: string
} = Object.freeze({
  json: 'application/json; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  bytes: 'application/octet-stream',
})

/** How a handler result is turned into a response. */
export interface SerializeOptions {
  /** Request method (`HEAD` responses have no body). */
  readonly method: string
  /** Method of the route definition (`POST` routes default to 201). */
  readonly routeMethod: string
  /** `@HttpCode` status (wins over everything but a Web `Response`). */
  readonly status: number | undefined
  /** `@Header` entries. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** Headers set on the context (`ctx.setHeader`), applied after `@Header`. */
  readonly context?: Readonly<Record<string, HeaderValue>> | undefined
}

/** A serialised response (mutable headers, merged by the pipeline). */
export interface SerializedReply {
  readonly status: number
  readonly headers: Record<string, HeaderValue>
  readonly body: ReplyBody
}

/**
 * Serialises a handler result:
 *
 * - Web `Response` → sent as is (status, headers, body); `@HttpCode` / `@Header` do not apply;
 * - `HttpResponse` → its body with its status and headers;
 * - `undefined` → empty body, `204` (`201` for POST routes);
 * - `string` → `text/plain`; `Uint8Array`/`ArrayBuffer`/views → `application/octet-stream`;
 * - `ReadableStream`, Node.js `Readable`, `Blob` → streamed (`application/octet-stream` or the blob type);
 * - anything else (objects, arrays, numbers, booleans, `null`) → JSON.
 *
 * Status precedence: `@HttpCode` > `HttpResponse.status` > default (`201` for POST routes,
 * `204` without body, `200`). Header precedence: content type < `@Header` < `ctx.setHeader()` <
 * `HttpResponse.headers` (a Web `Response` keeps its own headers).
 */
export function serializeResult(result: unknown, options: SerializeOptions): SerializedReply {
  if (result instanceof Response) {
    const reply = fromWebResponse(result, options.method)
    if (options.context !== undefined) addMissingHeaders(reply.headers, options.context)
    return reply
  }
  let payload = result
  let status: number | undefined
  let extra: Readonly<Record<string, HeaderValue>> | undefined
  if (isHttpResponse(result)) {
    payload = result.body
    status = result.status
    extra = result.headers
  }
  const finalStatus = options.status ?? status ?? defaultStatus(options.routeMethod, payload)
  const headers = emptyRecord<HeaderValue>()
  const body = encode(payload, headers)
  if (options.headers !== undefined) assignHeaders(headers, options.headers)
  if (options.context !== undefined) assignHeaders(headers, options.context)
  if (extra !== undefined) assignHeaders(headers, extra)
  return finish(finalStatus, headers, body, options.method)
}

/**
 * Serialises a resolved file response (`HttpResponse.file()`): the file headers, then `@Header`,
 * `ctx.setHeader()` and the `HttpResponse` headers. 206 / 304 keep their status; a 200 follows the
 * usual precedence (`@HttpCode` > `HttpResponse.status` > 200).
 */
export function serializeFileReply(
  file: ResolvedFile,
  response: HttpResponse,
  options: SerializeOptions,
): SerializedReply {
  const status = file.status === 200 ? (options.status ?? response.status ?? 200) : file.status
  const headers = emptyRecord<HeaderValue>()
  assignHeaders(headers, file.headers)
  if (options.headers !== undefined) assignHeaders(headers, options.headers)
  if (options.context !== undefined) assignHeaders(headers, options.context)
  assignHeaders(headers, response.headers)
  return finish(status, headers, file.body, options.method)
}

/** `201` for POST routes, otherwise `204` without payload and `200` with one. */
function defaultStatus(routeMethod: string, payload: unknown): number {
  if (routeMethod === 'POST') return 201
  return payload === undefined ? 204 : 200
}

/** Serialises an error body as JSON. */
export function serializeError(status: number, body: HttpErrorBody | unknown, method: string): SerializedReply {
  const headers = emptyRecord<HeaderValue>()
  const encoded = encode(body, headers)
  return finish(status, headers, encoded, method)
}

/** Copies headers with lower-case names (later values win). */
export function assignHeaders(
  target: Record<string, HeaderValue>,
  source: Readonly<Record<string, HeaderValue>>,
): void {
  for (const name of Object.keys(source)) {
    const value = source[name]
    if (value !== undefined) target[name.toLowerCase()] = typeof value === 'string' ? value : [...value]
  }
}

/** Adds headers that are not already present (case-insensitive). */
export function addMissingHeaders(
  target: Record<string, HeaderValue>,
  source: Readonly<Record<string, HeaderValue>>,
): void {
  for (const name of Object.keys(source)) {
    const key = name.toLowerCase()
    const value = source[name]
    if (value !== undefined && target[key] === undefined) target[key] = typeof value === 'string' ? value : [...value]
  }
}

function finish(
  status: number,
  headers: Record<string, HeaderValue>,
  body: ReplyBody,
  method: string,
): SerializedReply {
  if (isBodylessStatus(status)) {
    discard(body)
    delete headers['content-type']
    delete headers['content-length']
    return { status, headers, body: null }
  }
  if (method === 'HEAD') {
    discard(body)
    return { status, headers, body: null }
  }
  return { status, headers, body }
}

function discard(body: ReplyBody): void {
  if (body instanceof ReadableStream) discardStream(body)
}

function encode(payload: unknown, headers: Record<string, HeaderValue>): ReplyBody {
  if (payload === undefined) return null
  if (typeof payload === 'string') return bytes(ENCODER.encode(payload), headers, ContentType.text)
  if (payload instanceof Uint8Array) return bytes(payload, headers, ContentType.bytes)
  if (payload instanceof ArrayBuffer) return bytes(new Uint8Array(payload), headers, ContentType.bytes)
  if (ArrayBuffer.isView(payload)) {
    return bytes(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), headers, ContentType.bytes)
  }
  if (payload instanceof ReadableStream) {
    headers['content-type'] = ContentType.bytes
    return payload as ReadableStream<Uint8Array>
  }
  if (payload instanceof Blob) {
    headers['content-type'] = payload.type === '' ? ContentType.bytes : payload.type
    headers['content-length'] = String(payload.size)
    return payload
  }
  if (isNodeReadable(payload)) {
    headers['content-type'] = ContentType.bytes
    return toByteStream(payload)
  }
  if (isFileBody(payload)) throw new TypeError('A file body (HttpResponse.file()) cannot be serialised here')
  const json = JSON.stringify(payload)
  if (json === undefined) throw new TypeError(`Cannot serialise a ${typeof payload} as a response body`)
  return bytes(ENCODER.encode(json), headers, ContentType.json)
}

function bytes(data: Uint8Array, headers: Record<string, HeaderValue>, type: string): Uint8Array {
  headers['content-type'] = type
  headers['content-length'] = String(data.byteLength)
  return data
}

function isNodeReadable(value: unknown): value is Readable {
  return (
    value instanceof Readable ||
    (value !== null &&
      typeof value === 'object' &&
      typeof (value as { pipe?: unknown }).pipe === 'function' &&
      typeof (value as { on?: unknown }).on === 'function' &&
      typeof (value as { read?: unknown }).read === 'function')
  )
}

function fromWebResponse(response: Response, method: string): SerializedReply {
  const headers = emptyRecord<HeaderValue>()
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') headers[name] = value
  }
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  return finish(response.status, headers, response.body, method)
}
