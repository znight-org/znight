/** Helpers shared by the adapters (internal). */
import type { Readable } from 'node:stream'
import type {
  HttpServerAddress,
  InjectRequest,
  InjectResponse,
  InjectStreamRequest,
  InjectStreamResponse,
} from '../adapter.ts'

import { encodeCookieValue, parseSetCookies } from '../cookies.ts'
import { BadRequestException, PayloadTooLargeException } from '../exceptions.ts'
import { failedStream } from '../stream.ts'

/** An inject request normalised for the underlying tools. */
export interface NormalizedInject {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly payload: string | Uint8Array | undefined
}

/**
 * Applies the defaults of {@link InjectRequest}: query merged in the URL, cookies appended to the
 * `cookie` header (encoded values joined with `; `), body encoding and content type (`FormData` →
 * `multipart/form-data`, `Blob` → its type).
 */
export async function normalizeInject(request: InjectRequest): Promise<NormalizedInject> {
  if (request === null || typeof request !== 'object') throw new TypeError('inject() expects a request object')
  if (typeof request.url !== 'string' || !request.url.startsWith('/')) {
    throw new TypeError(`inject() expects a url starting with "/" (received ${JSON.stringify(request.url)})`)
  }
  const method = (request.method ?? 'GET').toUpperCase()
  let url = request.url
  if (request.query !== undefined) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(request.query)) {
      if (typeof value === 'string') search.append(key, value)
      else for (const item of value) search.append(key, item)
    }
    const query = search.toString()
    if (query !== '') url += `${url.includes('?') ? '&' : '?'}${query}`
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers ?? {})) headers[name.toLowerCase()] = value
  if (request.signedCookies !== undefined) {
    throw new TypeError('inject(): signedCookies are signed by HttpPlugin.inject() (adapters only accept cookies)')
  }
  const cookie = cookieHeader(request.cookies)
  if (cookie !== '') headers['cookie'] = headers['cookie'] === undefined ? cookie : `${headers['cookie']}; ${cookie}`
  const body = request.body
  let payload: string | Uint8Array | undefined
  if (body === undefined) {
    payload = undefined
  } else if (typeof body === 'string') {
    payload = body
    headers['content-type'] ??= 'text/plain; charset=utf-8'
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    payload = body instanceof Uint8Array ? body : new Uint8Array(body)
    headers['content-type'] ??= 'application/octet-stream'
  } else if (body instanceof FormData) {
    // the Fetch API encodes forms (the boundary of the generated content type must be used)
    const encoded = new Response(body)
    // read the generated content type (with its boundary) before consuming the body (Bun sets it lazily)
    const type = encoded.headers.get('content-type')
    payload = new Uint8Array(await encoded.arrayBuffer())
    headers['content-type'] = type ?? encoded.headers.get('content-type') ?? 'multipart/form-data'
  } else if (body instanceof Blob) {
    payload = new Uint8Array(await body.arrayBuffer())
    headers['content-type'] ??= body.type === '' ? 'application/octet-stream' : body.type
  } else {
    payload = JSON.stringify(body)
    headers['content-type'] ??= 'application/json'
  }
  return { method, url, headers, payload }
}

/** The `cookie` header of inject cookies: `name=encoded` pairs joined with `; `. */
function cookieHeader(cookies: Readonly<Record<string, string>> | undefined): string {
  if (cookies === undefined) return ''
  if (cookies === null || typeof cookies !== 'object') throw new TypeError('inject(): cookies must be an object')
  const pairs: string[] = []
  for (const name of Object.keys(cookies)) {
    if (!isRequestCookieName(name)) {
      throw new TypeError(
        `inject(): invalid cookie name ${JSON.stringify(name)} (empty, or with ";", "=", spaces or controls)`,
      )
    }
    const value = cookies[name]
    if (typeof value !== 'string') throw new TypeError(`inject(): the value of the cookie "${name}" must be a string`)
    pairs.push(`${name}=${encodeCookieValue(value)}`)
  }
  return pairs.join('; ')
}

/** A name a `cookie` header can carry: no `;`, `=`, whitespace or controls, Latin-1. */
function isRequestCookieName(name: string): boolean {
  if (name === '') return false
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index)
    if (code <= 0x20 || code === 0x3b || code === 0x3d || code === 0x7f || code > 0xff) return false
  }
  return true
}

const DECODER = new TextDecoder()

/**
 * Normalises response headers: lower-case names, repeated values joined with `, `, except
 * `set-cookie` (one entry per cookie: an `Expires` attribute contains `, `).
 */
export function injectHeaders(
  headers: Readonly<Record<string, string | number | readonly string[] | undefined>>,
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const key = name.toLowerCase()
    if (key === 'set-cookie') normalized[key] = typeof value === 'object' ? [...value] : [String(value)]
    else normalized[key] = typeof value === 'object' ? value.join(', ') : String(value)
  }
  return normalized
}

/** Builds an {@link InjectResponse} (headers normalised by {@link injectHeaders}, cookies parsed). */
export function injectResponse(
  status: number,
  headers: Readonly<Record<string, string | number | readonly string[] | undefined>>,
  bytes: Uint8Array,
): InjectResponse {
  const normalized = injectHeaders(headers)
  const body = DECODER.decode(bytes)
  return {
    status,
    headers: normalized,
    body,
    bytes,
    cookies: parseSetCookies(normalized['set-cookie']),
    json: <T = unknown>(): T => JSON.parse(body) as T,
  }
}

/** Whether a `content-type` is `text/event-stream`. */
export function isEventStreamType(contentType: string | string[] | undefined): boolean {
  if (typeof contentType !== 'string') return false
  const semicolon = contentType.indexOf(';')
  return (semicolon === -1 ? contentType : contentType.slice(0, semicolon)).trim().toLowerCase() === 'text/event-stream'
}

/**
 * `inject()` on top of `injectStream()`: reads the body to its end, except for an event stream
 * (which would never end): its body is cancelled (the server sees a disconnect) and the call
 * rejects with a hint.
 */
export async function bufferInjectStream(
  injectStream: (request: InjectStreamRequest) => Promise<InjectStreamResponse>,
  request: InjectRequest,
): Promise<InjectResponse> {
  const response = await injectStream(request)
  const method = (request.method ?? 'GET').toUpperCase()
  if (method !== 'HEAD' && isEventStreamType(response.headers['content-type'])) {
    await response.body.cancel().catch(() => undefined)
    throw new TypeError(
      `inject(): ${method} ${request.url} answered an event stream (text/event-stream): use injectSse() or injectStream()`,
    )
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    chunks.push(value)
  }
  const bytes = concat(chunks, size)
  const body = DECODER.decode(bytes)
  return {
    status: response.status,
    headers: response.headers,
    body,
    bytes,
    cookies: response.cookies,
    json: <T = unknown>(): T => JSON.parse(body) as T,
  }
}

/** Builds an {@link InjectStreamResponse}. */
export function injectStreamResponse(
  status: number,
  headers: Readonly<Record<string, string | number | readonly string[] | undefined>>,
  body: ReadableStream<Uint8Array>,
): InjectStreamResponse {
  const normalized = injectHeaders(headers)
  return { status, headers: normalized, cookies: parseSetCookies(normalized['set-cookie']), body }
}

/** Builds an {@link HttpServerAddress} from a bound address. */
export function serverAddress(address: string, port: number, family?: string | number): HttpServerAddress {
  const ipv6 = family === 'IPv6' || family === 6 || address.includes(':')
  let client = address
  if (address === '0.0.0.0') client = '127.0.0.1'
  else if (address === '::') client = '::1'
  const url = `http://${client.includes(':') ? `[${client}]` : client}:${port}`
  return Object.freeze({
    host: address,
    port,
    family: ipv6 ? 'IPv6' : 'IPv4',
    url,
    toString: () => url,
  })
}

/** The 413 error of a body above `limit` bytes. */
export function payloadTooLarge(limit: number): PayloadTooLargeException {
  return new PayloadTooLargeException(`Request body exceeds the limit of ${limit} bytes`, undefined, {
    headers: { connection: 'close' },
  })
}

/** Rejects early when `content-length` announces more than `limit` bytes. */
export function exceedsDeclaredLength(contentLength: string | undefined, limit: number): boolean {
  if (contentLength === undefined) return false
  const length = Number(contentLength)
  return Number.isFinite(length) && length > limit
}

/** Bytes read (and discarded) from an abandoned Web request body before it is cancelled. */
const MAX_DISCARD_BYTES = 64 * 1024 * 1024

/**
 * The body of a Web request as a pull-based stream enforcing `limit` (see
 * `AdapterRequest.streamBody`). `body` is only read when needed (a Node.js-backed request body
 * starts buffering once accessed). On overflow or cancellation the rest of the body is read and
 * discarded in the background (up to 64 MiB, then cancelled), so the server can write the response
 * and keep the connection usable instead of resetting it.
 */
export function webBodyStream(
  body: () => ReadableStream<Uint8Array> | null,
  limit: number,
  contentLength: string | undefined,
): ReadableStream<Uint8Array> {
  if (exceedsDeclaredLength(contentLength, limit)) return failedStream(payloadTooLarge(limit))
  const source = body()
  if (source === null) return new ReadableStream<Uint8Array>({ start: controller => controller.close() })
  const reader = source.getReader()
  let size = 0
  let abandoned = false
  const abandon = (): void => {
    if (abandoned) return
    abandoned = true
    discardReader(reader)
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let result: Awaited<ReturnType<typeof reader.read>>
        try {
          result = await reader.read()
        } catch (error) {
          abandoned = true
          throw new BadRequestException('Failed to read the request body', undefined, { cause: error })
        }
        if (result.done) {
          abandoned = true
          controller.close()
          return
        }
        size += result.value.byteLength
        if (size > limit) {
          abandon()
          throw payloadTooLarge(limit)
        }
        controller.enqueue(result.value)
      },
      cancel: abandon,
    },
    { highWaterMark: 0 },
  )
}

/** The part of a stream reader used to discard a body. */
interface BodyReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>
  cancel(): Promise<void>
}

/** Reads and drops the rest of a request body in the background, cancelling it past 64 MiB. */
function discardReader(reader: BodyReader): void {
  let discarded = 0
  const next = (): void => {
    reader.read().then(
      result => {
        if (result.done) return
        discarded += result.value?.byteLength ?? 0
        if (discarded > MAX_DISCARD_BYTES) reader.cancel().catch(() => undefined)
        else next()
      },
      () => undefined,
    )
  }
  next()
}

/** Reads a Web request body fully, enforcing `limit` (see {@link webBodyStream}). */
export async function readWebStream(
  body: () => ReadableStream<Uint8Array> | null,
  limit: number,
  contentLength: string | undefined,
): Promise<Uint8Array> {
  const reader = webBodyStream(body, limit, contentLength).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    chunks.push(value)
  }
  return concat(chunks, size)
}

/** Concatenates chunks (no copy for a single chunk). */
export function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** The light-my-request response of a streaming inject (`payloadAsStream: true`). */
interface LightStreamResponse {
  readonly statusCode: number
  readonly headers: Record<string, string | number | string[] | undefined>
  stream(): Readable
  readonly raw: { readonly res: { destroy(error?: Error): void } }
}

/** Minimal typing of `light-my-request` (optional peer dependency). */
export interface LightMyRequest {
  inject(dispatch: (req: never, res: never) => void, options: LightInjectOptions): PromiseLike<LightStreamResponse>
}

/** Options of a streaming light-my-request inject (also `fastify.inject()`). */
export interface LightInjectOptions {
  method: string
  url: string
  headers: Record<string, string>
  payload?: string | Buffer
  remoteAddress?: string
  payloadAsStream: true
}

let lightMyRequest: Promise<LightMyRequest> | undefined

/** Loads `light-my-request`, with an actionable error when it is not installed. */
export function loadLightMyRequest(adapter: string): Promise<LightMyRequest> {
  lightMyRequest ??= import('light-my-request').then(
    module => {
      const loaded = module as unknown as { default?: LightMyRequest } & LightMyRequest
      return loaded.default ?? loaded
    },
    (error: unknown) => {
      lightMyRequest = undefined
      throw new Error(
        `inject() with the ${adapter} adapter requires the optional peer dependency "light-my-request" ` +
          '(bun add -d light-my-request / npm i -D light-my-request)',
        { cause: error },
      )
    },
  )
  return lightMyRequest
}

/**
 * The light-my-request options of a normalised inject request (streaming mode). The signal is
 * handled by {@link lightStreamResponse} (light-my-request would destroy its fake request with an
 * unhandled error); an already aborted signal rejects at once, like `fetch()`.
 */
export async function lightInjectOptions(request: InjectStreamRequest): Promise<LightInjectOptions> {
  request.signal?.throwIfAborted()
  const normalized = await normalizeInject(request)
  return {
    method: normalized.method,
    url: normalized.url,
    headers: normalized.headers,
    remoteAddress: '127.0.0.1',
    payloadAsStream: true,
    ...(normalized.payload === undefined ? {} : { payload: toBuffer(normalized.payload) }),
  }
}

/** Runs a request through a Node.js request listener with `light-my-request`, streaming the body. */
export async function injectNodeStream(
  adapter: string,
  dispatch: (req: never, res: never) => void,
  request: InjectStreamRequest,
): Promise<InjectStreamResponse> {
  const options = await lightInjectOptions(request)
  const { inject } = await loadLightMyRequest(adapter)
  return lightStreamResponse(await inject(dispatch, options), request.signal)
}

/**
 * An {@link InjectStreamResponse} of a light-my-request streaming response. Cancelling the body
 * (or aborting `signal`) destroys the server response: the server sees a client disconnect.
 */
export function lightStreamResponse(response: LightStreamResponse, signal?: AbortSignal): InjectStreamResponse {
  const readable = response.stream()
  const disconnect = (): void => {
    response.raw.res.destroy()
    readable.destroy()
  }
  let finished = false
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        readable.on('data', (chunk: Buffer) => {
          if (finished) return
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          if ((controller.desiredSize ?? 0) <= 0) readable.pause()
        })
        readable.once('end', () => {
          if (finished) return
          finished = true
          controller.close()
        })
        readable.once('error', error => {
          if (finished) return
          finished = true
          controller.error(error)
        })
      },
      pull() {
        if (readable.isPaused()) readable.resume()
      },
      cancel() {
        finished = true
        disconnect()
      },
    },
    { highWaterMark: 0 },
  )
  if (signal !== undefined) {
    if (signal.aborted) disconnect()
    else signal.addEventListener('abort', disconnect, { once: true })
  }
  return injectStreamResponse(response.statusCode, response.headers, body)
}

/** A `Buffer` view of bytes (tools such as light-my-request JSON-encode other objects). */
export function toBuffer(payload: string | Uint8Array): string | Buffer {
  return typeof payload === 'string' ? payload : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
}

/**
 * Runs a request through a Fetch handler (`(request: Request) => Promise<Response>`), streaming
 * the body. Cancelling the body (or aborting `signal`) aborts the request signal and cancels the
 * response body.
 */
export async function injectFetchStream(
  fetch: (request: Request) => Response | Promise<Response>,
  request: InjectStreamRequest,
): Promise<InjectStreamResponse> {
  const signal = request.signal
  signal?.throwIfAborted()
  const normalized = await normalizeInject(request)
  const abort = new AbortController()
  signal?.addEventListener('abort', () => abort.abort(signal.reason), { once: true })
  const init: RequestInit = { method: normalized.method, headers: normalized.headers, signal: abort.signal }
  if (normalized.payload !== undefined && normalized.method !== 'GET' && normalized.method !== 'HEAD') {
    init.body = normalized.payload
  }
  const response = await fetch(new Request(`http://localhost${normalized.url}`, init))
  const headers: Record<string, string | readonly string[]> = {}
  for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  const source = response.body
  const reader = source?.getReader()
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (reader === undefined) {
          controller.close()
          return
        }
        const result = await reader.read()
        if (result.done) controller.close()
        else controller.enqueue(result.value)
      },
      async cancel(reason) {
        abort.abort(reason)
        await reader?.cancel(reason).catch(() => undefined)
      },
    },
    { highWaterMark: 0 },
  )
  abort.signal.addEventListener('abort', () => reader?.cancel(abort.signal.reason).catch(() => undefined), {
    once: true,
  })
  return injectStreamResponse(response.status, headers, body)
}
