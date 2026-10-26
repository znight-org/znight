/** Helpers shared by the adapters (internal). */
import type { HttpServerAddress, InjectRequest, InjectResponse } from '../adapter.ts'

import { PayloadTooLargeException } from '../exceptions.ts'

/** An inject request normalised for the underlying tools. */
export interface NormalizedInject {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly payload: string | Uint8Array | undefined
}

/** Applies the defaults of {@link InjectRequest}: query merged in the URL, body encoding and content type. */
export function normalizeInject(request: InjectRequest): NormalizedInject {
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
  } else {
    payload = JSON.stringify(body)
    headers['content-type'] ??= 'application/json'
  }
  return { method, url, headers, payload }
}

/** Builds an {@link InjectResponse}. Header values are joined with `, `. */
export function injectResponse(
  status: number,
  headers: Readonly<Record<string, string | number | readonly string[] | undefined>>,
  body: string,
): InjectResponse {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    normalized[name.toLowerCase()] = typeof value === 'object' ? value.join(', ') : String(value)
  }
  return {
    status,
    headers: normalized,
    body,
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

/** Reads a Web stream fully, enforcing `limit`. */
export async function readWebStream(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  contentLength: string | undefined,
): Promise<Uint8Array> {
  if (exceedsDeclaredLength(contentLength, limit)) {
    await stream?.cancel().catch(() => undefined)
    throw payloadTooLarge(limit)
  }
  if (stream === null) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw payloadTooLarge(limit)
    }
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
    payload: string
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
  const normalized = normalizeInject(request)
  const { inject } = await loadLightMyRequest(adapter)
  const response = await inject(dispatch, {
    method: normalized.method,
    url: normalized.url,
    headers: normalized.headers,
    remoteAddress: '127.0.0.1',
    ...(normalized.payload === undefined ? {} : { payload: toBuffer(normalized.payload) }),
  })
  return injectResponse(response.statusCode, response.headers, response.payload)
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
  const normalized = normalizeInject(request)
  const init: RequestInit = { method: normalized.method, headers: normalized.headers }
  if (normalized.payload !== undefined && normalized.method !== 'GET' && normalized.method !== 'HEAD') {
    init.body = normalized.payload
  }
  const response = await fetch(new Request(`http://localhost${normalized.url}`, init))
  const headers: Record<string, string | readonly string[]> = {}
  for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  return injectResponse(response.status, headers, await response.text())
}
