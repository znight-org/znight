import type { ReplyBody } from './adapter.ts'
import type { ResponseCookie } from './cookies.ts'
import type { HeaderValue, HttpErrorBody } from './exceptions.ts'
import type { ResolvedFile } from './files.ts'
import type { HttpResponse } from './response.ts'
import type { SseSession } from './sse.ts'

import { Readable } from 'node:stream'

import { isFileBody } from './files.ts'
import { isHttpResponse } from './response.ts'
import { isSseBody } from './sse.ts'
import { isBodylessStatus } from './status.ts'
import { discardStream, isByteStream, toByteStream } from './stream.ts'
import { emptyRecord } from './utils.ts'

const ENCODER = new TextEncoder()

/** Content types set by the serialiser. */
export const ContentType: {
  readonly json: string
  readonly text: string
  readonly bytes: string
  readonly eventStream: string
} = Object.freeze({
  json: 'application/json; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  bytes: 'application/octet-stream',
  eventStream: 'text/event-stream; charset=utf-8',
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
  /** Cookies of the `HttpResponse` (`withCookie`), applied by the pipeline over those of the context. */
  readonly cookies?: readonly ResponseCookie[]
  /** The event stream of the body (`@Sse`, `HttpResponse.sse()`). */
  readonly sse?: SseSession
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
  let cookies: readonly ResponseCookie[] | undefined
  if (isHttpResponse(result)) {
    payload = result.body
    status = result.status
    extra = result.headers
    cookies = cookiesOf(result)
  }
  const finalStatus = options.status ?? status ?? defaultStatus(options.routeMethod, payload)
  const headers = emptyRecord<HeaderValue>()
  const body = encode(payload, headers)
  if (options.headers !== undefined) assignHeaders(headers, options.headers)
  if (options.context !== undefined) assignHeaders(headers, options.context)
  if (extra !== undefined) assignHeaders(headers, extra)
  return withCookies(finish(finalStatus, headers, body, options.method), cookies)
}

/**
 * Serialises an event stream (`@Sse` result, `HttpResponse.sse()`): status 200 unless `@HttpCode`
 * or `HttpResponse.status` say otherwise; `cache-control: no-cache, no-transform` and
 * `x-accel-buffering: no` under `@Header`, `ctx.setHeader()` and the `HttpResponse` headers;
 * `content-type: text/event-stream; charset=utf-8` last; never `content-length` or
 * `transfer-encoding`. A `HEAD` request or a bodyless status cancels the stream before its first read.
 */
export function serializeSseReply(
  session: SseSession,
  response: HttpResponse | undefined,
  options: SerializeOptions,
): SerializedReply {
  const status = options.status ?? response?.status ?? 200
  const headers = emptyRecord<HeaderValue>()
  headers['cache-control'] = 'no-cache, no-transform'
  headers['x-accel-buffering'] = 'no'
  if (options.headers !== undefined) assignHeaders(headers, options.headers)
  if (options.context !== undefined) assignHeaders(headers, options.context)
  if (response !== undefined) assignHeaders(headers, response.headers)
  headers['content-type'] = ContentType.eventStream
  delete headers['content-length']
  delete headers['transfer-encoding']
  const reply = finish(status, headers, session.stream, options.method)
  return withCookies(reply.body === null ? reply : { ...reply, sse: session }, response && cookiesOf(response))
}

/** The cookies of an `HttpResponse` (none for a copy of the class from an older package version). */
function cookiesOf(response: HttpResponse): readonly ResponseCookie[] | undefined {
  const cookies = (response as { cookies?: readonly ResponseCookie[] }).cookies
  return Array.isArray(cookies) && cookies.length > 0 ? cookies : undefined
}

function withCookies(reply: SerializedReply, cookies: readonly ResponseCookie[] | undefined): SerializedReply {
  return cookies === undefined ? reply : { ...reply, cookies }
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
  return withCookies(finish(status, headers, file.body, options.method), cookiesOf(response))
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
    // adapters get bytes (`ReplyBody`): string / ArrayBuffer chunks of a returned stream are converted
    return isByteStream(payload) ? (payload as ReadableStream<Uint8Array>) : toByteStream(payload)
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
  if (isSseBody(payload)) throw new TypeError('An event stream (HttpResponse.sse()) cannot be serialised here')
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
