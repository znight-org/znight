/** Helpers shared by the adapters (internal). */
import type { HttpServerAddress, InjectRequest, InjectResponse } from '../adapter.ts'

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
 * Applies the defaults of {@link InjectRequest}: query merged in the URL, body encoding and content
 * type (`FormData` → `multipart/form-data`, `Blob` → its type).
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

const DECODER = new TextDecoder()

/**
 * Builds an {@link InjectResponse}. Repeated header values are joined with `, `, except `set-cookie`
 * (one entry per cookie: an `Expires` attribute contains `, `).
 */
export function injectResponse(
  status: number,
  headers: Readonly<Record<string, string | number | readonly string[] | undefined>>,
  bytes: Uint8Array,
): InjectResponse {
  const normalized: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const key = name.toLowerCase()
    if (key === 'set-cookie') normalized[key] = typeof value === 'object' ? [...value] : [String(value)]
    else normalized[key] = typeof value === 'object' ? value.join(', ') : String(value)
  }
  const body = DECODER.decode(bytes)
  return {
    status,
    headers: normalized,
    body,
    bytes,
    json: <T = unknown>(): T => JSON.parse(body) as T,
  }
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
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** Minimal typing of `light-my-request` (optional peer dependency). */
export interface LightMyRequest {
  inject(
    dispatch: (req: never, res: never) => void,
    options: {
      method: string
      url: string
      headers: Record<string, string>
      payload?: string | Buffer
      remoteAddress?: string
    },
  ): PromiseLike<{
    statusCode: number
    headers: Record<string, string | number | string[] | undefined>
    rawPayload: Uint8Array
  }>
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

/** Runs a request through a Node.js request listener with `light-my-request`. */
export async function injectNode(
  adapter: string,
  dispatch: (req: never, res: never) => void,
  request: InjectRequest,
): Promise<InjectResponse> {
  const normalized = await normalizeInject(request)
  const { inject } = await loadLightMyRequest(adapter)
  const response = await inject(dispatch, {
    method: normalized.method,
    url: normalized.url,
    headers: normalized.headers,
    remoteAddress: '127.0.0.1',
    ...(normalized.payload === undefined ? {} : { payload: toBuffer(normalized.payload) }),
  })
  return injectResponse(response.statusCode, response.headers, response.rawPayload)
}

/** A `Buffer` view of bytes (tools such as light-my-request JSON-encode other objects). */
export function toBuffer(payload: string | Uint8Array): string | Buffer {
  return typeof payload === 'string' ? payload : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
}

/** Runs a request through a Fetch handler (`(request: Request) => Promise<Response>`). */
export async function injectFetch(
  fetch: (request: Request) => Response | Promise<Response>,
  request: InjectRequest,
): Promise<InjectResponse> {
  const normalized = await normalizeInject(request)
  const init: RequestInit = { method: normalized.method, headers: normalized.headers }
  if (normalized.payload !== undefined && normalized.method !== 'GET' && normalized.method !== 'HEAD') {
    init.body = normalized.payload
  }
  const response = await fetch(new Request(`http://localhost${normalized.url}`, init))
  const headers: Record<string, string | readonly string[]> = {}
  for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  return injectResponse(response.status, headers, new Uint8Array(await response.arrayBuffer()))
}
