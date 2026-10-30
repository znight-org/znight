/** Node.js `IncomingMessage` / `ServerResponse` helpers shared by the Node and Express adapters (internal). */
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { AdapterReply, AdapterRequest } from '../adapter.ts'
import type { HeaderValue } from '../exceptions.ts'

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { BadRequestException } from '../exceptions.ts'
import { discardStream, failedStream } from '../stream.ts'
import { concat, exceedsDeclaredLength, payloadTooLarge } from './shared.ts'

/** Bytes buffered by a request body stream before the request is paused. */
const BODY_HIGH_WATER_MARK = 64 * 1024

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

/**
 * Whether the body was already read by someone else: an Express body parser (`express.json()`...)
 * marks the request with `_body`; otherwise a declared body that already ended.
 */
function consumedElsewhere(request: IncomingMessage): boolean {
  if ((request as { _body?: unknown })._body === true) return true
  if (!request.readableEnded) return false
  const length = request.headers['content-length']
  return request.headers['transfer-encoding'] !== undefined || (length !== undefined && length.trim() !== '0')
}

/** The error of a body consumed before Znight read it (an empty body would be silently wrong). */
function consumedError(): Error {
  return new Error(
    'The request body was already read by a middleware (an Express body parser such as express.json()?): ' +
      'Znight reads the bodies of its routes itself, do not register body parsers for them',
  )
}

/** Reads a Node.js request body, enforcing `limit` (on `content-length`, then while streaming). */
export function readNodeBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  if (exceedsDeclaredLength(request.headers['content-length'], limit)) {
    request.resume()
    return Promise.reject(payloadTooLarge(limit))
  }
  // a read in progress (the adapters read a body once: not expected)
  const reading = (request as ReadingRequest)[BODY_READ]
  if (reading != null) return reading.promise
  if (consumedElsewhere(request)) return Promise.reject(consumedError())
  if (request.readableEnded) return Promise.resolve(new Uint8Array(0))
  if (request.destroyed) return Promise.reject(new BadRequestException('The request was aborted'))
  let resolve!: (bytes: Uint8Array) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Uint8Array>((onRead, onError) => {
    resolve = onRead
    reject = onError
  })
  ;(request as ReadingRequest)[BODY_READ] = { limit, chunks: [], size: 0, resolve, reject, promise }
  if (reading === undefined) {
    request.on('data', onBodyData)
    request.on('end', onBodyEnd)
    request.on('error', onBodyError)
    request.on('close', onBodyClose)
  }
  return promise
}

/**
 * The state of the body read by {@link readNodeBody}, on its request: `null` once it is over (the
 * listeners stay), `undefined` before.
 */
const BODY_READ = Symbol('znight.bodyRead')

interface BodyRead {
  readonly limit: number
  readonly chunks: Uint8Array[]
  size: number
  readonly resolve: (bytes: Uint8Array) => void
  readonly reject: (error: unknown) => void
  readonly promise: Promise<Uint8Array>
}

type ReadingRequest = IncomingMessage & { [BODY_READ]?: BodyRead | null }

// The listeners of readNodeBody: shared functions (`this` is the request), no closure per request.
// They stay attached once the read is over (removing them costs a lot more than leaving them): they
// then do nothing. Node.js emits `error` on a destroyed request only when it has listeners, so the
// `error` listener left behind changes nothing either.

/** Stops reading: returns the state of the read (`undefined` when it is already over). */
function stopBodyRead(request: ReadingRequest): BodyRead | undefined {
  const read = request[BODY_READ]
  if (read == null) return undefined
  request[BODY_READ] = null
  return read
}

function onBodyData(this: ReadingRequest, chunk: Uint8Array | string): void {
  const read = this[BODY_READ]
  if (read == null) return
  const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
  read.size += bytes.byteLength
  if (read.size > read.limit) {
    stopBodyRead(this)
    this.resume() // discard the rest; the 413 response closes the connection
    read.reject(payloadTooLarge(read.limit))
    return
  }
  read.chunks.push(bytes)
}

function onBodyEnd(this: ReadingRequest): void {
  const read = stopBodyRead(this)
  read?.resolve(concat(read.chunks, read.size))
}

function onBodyError(this: ReadingRequest, error: Error): void {
  stopBodyRead(this)?.reject(new BadRequestException('Failed to read the request body', undefined, { cause: error }))
}

function onBodyClose(this: ReadingRequest): void {
  if (this.complete) return
  stopBodyRead(this)?.reject(new BadRequestException('The request was aborted'))
}

/**
 * A Node.js request body as a Web stream (see `AdapterRequest.streamBody`): the request is paused
 * while the consumer does not read (backpressure); past `limit` bytes the stream errors with 413 and
 * the rest of the body is discarded (`request.resume()`), like when the consumer cancels the stream,
 * so the response can still be written (it carries `connection: close`).
 */
export function nodeBodyStream(request: IncomingMessage, limit: number): ReadableStream<Uint8Array> {
  if (exceedsDeclaredLength(request.headers['content-length'], limit)) {
    request.resume()
    return failedStream(payloadTooLarge(limit))
  }
  if (consumedElsewhere(request)) return failedStream(consumedError())
  if (request.readableEnded) return new ReadableStream<Uint8Array>({ start: controller => controller.close() })
  if (request.destroyed) return failedStream(new BadRequestException('The request was aborted'))
  let size = 0
  let cleanup = (): void => undefined
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const onData = (chunk: Uint8Array | string): void => {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          size += bytes.byteLength
          if (size > limit) {
            cleanup()
            request.resume() // discard the rest; the 413 response closes the connection
            controller.error(payloadTooLarge(limit))
            return
          }
          controller.enqueue(bytes)
          if ((controller.desiredSize ?? 0) <= 0) request.pause()
        }
        const onEnd = (): void => {
          cleanup()
          controller.close()
        }
        const onError = (error: Error): void => {
          cleanup()
          controller.error(new BadRequestException('Failed to read the request body', undefined, { cause: error }))
        }
        const onClose = (): void => {
          if (request.complete) return
          cleanup()
          controller.error(new BadRequestException('The request was aborted'))
        }
        cleanup = (): void => {
          request.off('data', onData)
          request.off('end', onEnd)
          request.off('error', onError)
          request.off('close', onClose)
        }
        request.on('data', onData)
        request.on('end', onEnd)
        request.on('error', onError)
        request.on('close', onClose)
      },
      pull() {
        if (request.isPaused()) request.resume()
      },
      cancel() {
        cleanup()
        request.resume() // discard the rest of the body
      },
    },
    { highWaterMark: BODY_HIGH_WATER_MARK, size: (chunk: Uint8Array | undefined) => chunk?.byteLength ?? 0 },
  )
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
  options: NodeRequestOptions = NO_OPTIONS,
): AdapterRequest {
  return new NodeAdapterRequest(request, response, options)
}

const NO_OPTIONS: NodeRequestOptions = Object.freeze({})

/** A Node.js request/response pair as an {@link AdapterRequest} (a class: no closure per request). */
class NodeAdapterRequest implements AdapterRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly ip: string | undefined
  readonly remoteAddress: string | undefined
  readonly encrypted: boolean
  readonly raw: unknown
  readonly rawResponse: unknown
  readonly #request: IncomingMessage
  readonly #response: ServerResponse
  #body: Promise<Uint8Array> | undefined

  constructor(request: IncomingMessage, response: ServerResponse, options: NodeRequestOptions) {
    const remoteAddress = request.socket?.remoteAddress
    this.method = request.method ?? 'GET'
    this.url = options.url ?? request.url ?? '/'
    this.headers = normalizeNodeHeaders(request.headers)
    this.ip = options.ip ?? remoteAddress
    this.remoteAddress = remoteAddress
    this.encrypted = isEncrypted(request)
    this.raw = options.raw ?? request
    this.rawResponse = options.rawResponse ?? response
    this.#request = request
    this.#response = response
  }

  readBody(limit: number): Promise<Uint8Array> {
    this.#body ??= readNodeBody(this.#request, limit)
    return this.#body
  }

  streamBody(limit: number): ReadableStream<Uint8Array> {
    return nodeBodyStream(this.#request, limit)
  }

  rawStatus(): number {
    return this.#response.statusCode
  }

  onAbort(listener: () => void): void {
    onResponseAbort(this.#response, listener)
  }
}

/**
 * Calls `listener` once when `response` closes before it was fully written (the client left): on
 * the next microtask when it is already destroyed, never after a complete response.
 */
export function onResponseAbort(response: ServerResponse, listener: () => void): void {
  if (response.writableFinished) return
  if (response.destroyed) {
    queueMicrotask(listener)
    return
  }
  response.once('close', () => {
    if (!response.writableFinished) listener()
  })
}

/** Whether the request came over TLS (`node:https`, `node:http2` secure servers). */
export function isEncrypted(request: IncomingMessage): boolean {
  return (request.socket as { readonly encrypted?: unknown } | undefined)?.encrypted === true
}

/**
 * Writes a reply to a `ServerResponse`, piping a stream body (a failing stream destroys the
 * response). Never throws.
 */
export function writeNodeReply(response: ServerResponse, reply: AdapterReply): void {
  if (reply.raw === true) {
    discardStream(reply.body instanceof ReadableStream ? reply.body : null)
    return
  }
  if (response.headersSent || response.destroyed) {
    discardStream(reply.body instanceof ReadableStream ? reply.body : null)
    if (!response.writableEnded && !response.destroyed) response.end()
    return
  }
  try {
    // one call (merged over headers set earlier with setHeader(), e.g. by Express middleware); the
    // cookies set earlier are kept before the reply's own (writeHead would replace them)
    const headers =
      reply.headers['set-cookie'] === undefined
        ? reply.headers
        : withNativeCookies(response.getHeader('set-cookie'), reply.headers)
    response.writeHead(reply.status, headers as OutgoingHttpHeaders)
  } catch {
    // invalid header name or value set by user code
    discardStream(reply.body instanceof ReadableStream ? reply.body : null)
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
  // an event stream may stay quiet longer than a socket timeout (`server.timeout`, Bun's emulation)
  if (reply.eventStream === true && (response as { isLightMyRequest?: boolean }).isLightMyRequest !== true) {
    response.setTimeout(0)
  }
  if (body instanceof Uint8Array) {
    // a string is written with the headers at once (bytes take a second write)
    response.end(reply.text ?? body)
    return
  }
  const fail = (): void => {
    if (!response.destroyed) response.destroy()
  }
  try {
    const stream = body instanceof Blob ? body.stream() : body
    pipeline(Readable.fromWeb(stream as import('node:stream/web').ReadableStream), response).catch(fail)
  } catch {
    fail()
  }
}

/**
 * `headers` with the `set-cookie` lines already set on the native response (Express middleware
 * `res.cookie()`, Fastify hooks `reply.header('set-cookie', ...)`) before its own: `headers`
 * unchanged when either side has none.
 */
export function withNativeCookies(
  native: number | string | readonly string[] | undefined,
  headers: Readonly<Record<string, HeaderValue>>,
): Readonly<Record<string, HeaderValue>> {
  const own = headers['set-cookie']
  if (own === undefined || native === undefined || typeof native === 'number') return headers
  const before = typeof native === 'string' ? [native] : native
  if (before.length === 0) return headers
  return { ...headers, 'set-cookie': [...before, ...(typeof own === 'string' ? [own] : own)] }
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

/** The tracker of a socket (see {@link ConnectionTracker}). */
const TRACKER = Symbol('znight.tracker')
/** The number of requests in progress on a tracked socket. */
const ACTIVE = Symbol('znight.active')

interface TrackedSocket extends Socket {
  [TRACKER]?: ConnectionTracker
  [ACTIVE]?: number
}

/**
 * Tracks the connections of a `node:http` server to close them on shutdown: idle keep-alive
 * connections first (graceful), every connection when forced. `server.closeIdleConnections()` /
 * `closeAllConnections()` are not reliable on every runtime (Bun), so sockets are tracked here. The
 * count of requests in progress lives on the socket, and one shared `close` listener per response
 * decrements it (no closure, no map lookup per request).
 */
export class ConnectionTracker {
  readonly #sockets = new Set<TrackedSocket>()
  #closing = false

  /**
   * `requests: false` when the caller's own `request` listener calls {@link track} for every request
   * of the server (one listener less to call per request).
   */
  constructor(server: Server, options: { readonly requests?: boolean } = {}) {
    server.on('connection', (socket: TrackedSocket) => {
      socket[TRACKER] = this
      socket[ACTIVE] = 0
      this.#sockets.add(socket)
      socket.once('close', () => this.#sockets.delete(socket))
    })
    if (options.requests !== false) {
      server.on('request', (request: IncomingMessage, response: ServerResponse) => this.track(request, response))
    }
  }

  /** Counts a request in progress on its connection, until its response closes (other servers' requests are ignored). */
  track(request: IncomingMessage, response: ServerResponse): void {
    const socket = request.socket as TrackedSocket | null
    if (socket?.[TRACKER] !== this) return
    socket[ACTIVE] = (socket[ACTIVE] ?? 0) + 1
    response.on('close', ConnectionTracker.#onResponseClose)
  }

  /** A response closed (`this`): one request less on its socket, ended when idle while closing. */
  static readonly #onResponseClose = function (this: ServerResponse): void {
    // the socket of a finished response is detached: reach it through its request
    const socket = (this.req as IncomingMessage | undefined)?.socket as TrackedSocket | null | undefined
    const tracker = socket?.[TRACKER]
    if (socket == null || tracker === undefined) return
    const active = (socket[ACTIVE] ?? 1) - 1
    socket[ACTIVE] = active
    if (active === 0 && tracker.#closing) socket.end()
  }

  /** Ends idle connections now and the others once their requests completed. */
  closeIdle(): void {
    this.#closing = true
    for (const socket of this.#sockets) if (socket[ACTIVE] === 0) socket.end()
  }

  /** Destroys every connection. */
  destroyAll(): void {
    this.#closing = true
    for (const socket of this.#sockets) socket.destroy()
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
