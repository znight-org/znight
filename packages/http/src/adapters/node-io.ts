/** Node.js `IncomingMessage` / `ServerResponse` helpers shared by the Node and Express adapters (internal). */
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { AdapterReply, AdapterRequest } from '../adapter.ts'

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { BadRequestException } from '../exceptions.ts'
import { concat, exceedsDeclaredLength, payloadTooLarge } from './shared.ts'

/** Request headers with array values (only `set-cookie` in Node.js) joined with `, `. */
export function normalizeNodeHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  for (const name in headers) {
    if (typeof headers[name] !== 'string') return copyHeaders(headers)
  }
  return headers as Record<string, string | undefined>
}

function copyHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const name in headers) {
    const value = headers[name]
    result[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return result
}

/** Reads a Node.js request body, enforcing `limit` (on `content-length`, then while streaming). */
export function readNodeBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  if (exceedsDeclaredLength(request.headers['content-length'], limit)) {
    request.resume()
    return Promise.reject(payloadTooLarge(limit))
  }
  if (request.readableEnded) return Promise.resolve(new Uint8Array(0))
  if (request.destroyed) return Promise.reject(new BadRequestException('The request was aborted'))
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    const cleanup = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('close', onClose)
    }
    const onData = (chunk: Uint8Array | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += bytes.byteLength
      if (size > limit) {
        cleanup()
        request.resume() // discard the rest; the 413 response closes the connection
        reject(payloadTooLarge(limit))
        return
      }
      chunks.push(bytes)
    }
    const onEnd = (): void => {
      cleanup()
      resolve(concat(chunks, size))
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(new BadRequestException('Failed to read the request body', undefined, { cause: error }))
    }
    const onClose = (): void => {
      if (request.complete) return
      cleanup()
      reject(new BadRequestException('The request was aborted'))
    }
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
    request.on('close', onClose)
  })
}

/** Options of {@link nodeAdapterRequest}. */
export interface NodeRequestOptions {
  /** Request target (default: `request.url`). */
  readonly url?: string
  /** `@Req()` value (default: the `IncomingMessage`). */
  readonly raw?: unknown
  /** `@Res()` value (default: the `ServerResponse`). */
  readonly rawResponse?: unknown
  readonly ip?: string | undefined
}

/** Wraps a Node.js request/response pair as an {@link AdapterRequest}. */
export function nodeAdapterRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: NodeRequestOptions = {},
): AdapterRequest {
  let body: Promise<Uint8Array> | undefined
  return {
    method: request.method ?? 'GET',
    url: options.url ?? request.url ?? '/',
    headers: normalizeNodeHeaders(request.headers),
    ip: options.ip ?? request.socket?.remoteAddress,
    raw: options.raw ?? request,
    rawResponse: options.rawResponse ?? response,
    readBody: (limit: number): Promise<Uint8Array> => {
      body ??= readNodeBody(request, limit)
      return body
    },
    rawStatus: (): number => response.statusCode,
  }
}

/**
 * Writes a reply to a `ServerResponse`. Resolves when the response is complete (streams included);
 * never rejects (a failing stream destroys the response).
 */
export async function writeNodeReply(response: ServerResponse, reply: AdapterReply): Promise<void> {
  if (reply.raw === true) return
  if (response.headersSent) {
    if (!response.writableEnded) response.end()
    return
  }
  try {
    // one call (merged over headers set earlier with setHeader(), e.g. by Express middleware)
    response.writeHead(reply.status, reply.headers as OutgoingHttpHeaders)
  } catch {
    // invalid header name or value set by user code
    if (!response.headersSent) {
      for (const name of response.getHeaderNames()) response.removeHeader(name)
      response.statusCode = 500
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end('{"statusCode":500,"error":"Internal Server Error"}')
    }
    return
  }
  const body = reply.body
  if (body === null) {
    response.end()
    return
  }
  if (body instanceof Uint8Array) {
    response.end(body)
    return
  }
  try {
    await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream), response)
  } catch {
    if (!response.destroyed) response.destroy()
  }
}

/** Last-resort 500 when a handler promise rejected (should not happen: the pipeline maps errors). */
export function writeNodeFailure(response: ServerResponse): void {
  if (response.headersSent) {
    if (!response.writableEnded) response.destroy()
    return
  }
  response.statusCode = 500
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end('{"statusCode":500,"error":"Internal Server Error"}')
}

/**
 * Tracks the connections of a `node:http` server to close them on shutdown: idle keep-alive
 * connections first (graceful), every connection when forced. `server.closeIdleConnections()` /
 * `closeAllConnections()` are not reliable on every runtime (Bun), so sockets are tracked here.
 */
export class ConnectionTracker {
  /** Socket → number of requests in progress. */
  readonly #sockets = new Map<Socket, number>()
  #closing = false

  constructor(server: Server) {
    server.on('connection', (socket: Socket) => {
      this.#sockets.set(socket, 0)
      socket.once('close', () => this.#sockets.delete(socket))
    })
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      const socket = request.socket
      if (!this.#sockets.has(socket)) return
      this.#sockets.set(socket, (this.#sockets.get(socket) ?? 0) + 1)
      response.once('close', () => {
        const active = this.#sockets.get(socket)
        if (active === undefined) return
        this.#sockets.set(socket, active - 1)
        if (active - 1 === 0 && this.#closing) socket.end()
      })
    })
  }

  /** Ends idle connections now and the others once their requests completed. */
  closeIdle(): void {
    this.#closing = true
    for (const [socket, active] of this.#sockets) if (active === 0) socket.end()
  }

  /** Destroys every connection. */
  destroyAll(): void {
    this.#closing = true
    for (const socket of this.#sockets.keys()) socket.destroy()
  }
}

/** Closes a `node:http` server: graceful (idle connections ended), then forced when asked. */
export function closeServer(
  server: Server,
  tracker: ConnectionTracker,
  closing: Promise<void> | undefined,
  force: boolean,
): Promise<void> {
  const promise =
    closing ??
    new Promise<void>(resolve => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
      server.closeIdleConnections?.()
      tracker.closeIdle()
    })
  if (force) {
    server.closeAllConnections?.()
    tracker.destroyAll()
  }
  return promise
}
