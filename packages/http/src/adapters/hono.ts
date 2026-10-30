/**
 * `@znight/http/hono`: serves Znight routes with [Hono](https://hono.dev) 4 (optional peer
 * dependency `hono`). On Bun the server is `Bun.serve()`; on Node.js it is `@hono/node-server`
 * (optional peer dependency, loaded on `listen()`). `inject()` uses `app.request()`.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type {
  AdapterCloseOptions,
  AdapterHandler,
  AdapterReply,
  AdapterRequest,
  AdapterRoute,
  FallbackHandler,
  HttpAdapter,
  HttpServerAddress,
  InjectRequest,
  InjectResponse,
  InjectStreamRequest,
  InjectStreamResponse,
} from '../adapter.ts'
import type { HeaderValue } from '../exceptions.ts'

import { type Context, Hono, type Next } from 'hono'

import { BadRequestException } from '../exceptions.ts'
import { toHonoPath } from '../path.ts'
import { discardStream } from '../stream.ts'
import { isBun } from '../utils.ts'
import { ConnectionTracker, closeServer, nodeBodyStream, onResponseAbort, readNodeBody } from './node-io.ts'
import {
  bufferInjectStream,
  exceedsDeclaredLength,
  injectFetchStream,
  payloadTooLarge,
  readWebStream,
  serverAddress,
  webBodyStream,
} from './shared.ts'

/** Options of {@link honoAdapter}. */
export interface HonoAdapterOptions {
  /**
   * An existing application: its middleware (`app.use(...)`) runs before the Znight routes. Znight
   * sets its `notFound` and `onError` handlers.
   */
  readonly app?: Hono
  /**
   * Options of `Bun.serve()` on Bun (`tls`, `idleTimeout`, `development`, `error`...); Znight sets
   * `port`, `hostname` and `fetch`. Ignored on Node.js.
   */
  readonly serveOptions?: HonoServeOptions
}

/**
 * Options of `Bun.serve()` (see the Bun documentation; Bun types are not required). Defaults set by
 * the adapter: `maxRequestBodySize` unlimited (Znight enforces `bodyLimit` / `@BodyLimit` itself)
 * and Bun's `idleTimeout` (10 s), lifted while a streamed response is sent.
 */
export interface HonoServeOptions {
  /** Seconds a connection may stay idle (`0`: never closed). Default: 10. */
  readonly idleTimeout?: number
  /** Request bodies above this size are refused by Bun (413). Default: unlimited. */
  readonly maxRequestBodySize?: number
  /** TLS options (`{ key, cert }`). */
  readonly tls?: unknown
  /** Any other `Bun.serve()` option. */
  readonly [option: string]: unknown
}

/** The Hono adapter. */
export interface HonoAdapter extends HttpAdapter {
  readonly name: 'hono'
  /** The Hono application. */
  readonly app: Hono
  /** Fetch handler of the application (`export default { fetch: adapter.fetch }` on edge runtimes). */
  readonly fetch: (request: Request, env?: unknown) => Response | Promise<Response>
}

/**
 * Creates a Hono adapter.
 *
 * ```ts
 * import { honoAdapter } from '@znight/http/hono'
 *
 * HttpPlugin.configure({ adapter: honoAdapter() })
 * ```
 */
export function honoAdapter(options: HonoAdapterOptions = {}): HonoAdapter {
  return new HonoHttpAdapter(options)
}

/** The parts of a Bun server used here (Bun types are not available to the package sources). */
interface BunServer {
  readonly port: number
  readonly hostname: string
  stop(closeActiveConnections?: boolean): Promise<void> | void
  requestIP?(request: Request): { readonly address: string } | null
  /** Idle timeout of one request, in seconds (`0`: none). */
  timeout?(request: Request, seconds: number): void
}

interface BunRuntime {
  serve(
    options: HonoServeOptions & {
      port: number
      hostname: string
      fetch: (request: Request, server: BunServer) => Response | Promise<Response>
    },
  ): BunServer
}

/** Default `idleTimeout` of `Bun.serve()`, in seconds. */
const BUN_IDLE_TIMEOUT = 10

/**
 * A streamed response body built for a request of `Bun.serve()` (see `#bunStream`); with middleware,
 * pending until `#bunFetch` takes it or it ends.
 */
class BunBody {
  /** The `Blob` (file) the body reads. */
  readonly blob: Blob | undefined
  #settle: (() => void) | undefined
  #onEnd: (() => void) | undefined
  #ended = false

  /** `settle` is called once, when the body is taken by `#bunFetch` or ends, whichever comes first. */
  constructor(blob: Blob | undefined, settle: (() => void) | undefined) {
    this.blob = blob
    this.#settle = settle
  }

  /** Whether the body ended (read to its end, failed or cancelled). */
  get ended(): boolean {
    return this.#ended
  }

  /** The body is no longer pending (taken by `#bunFetch`). */
  settle(): void {
    const settle = this.#settle
    this.#settle = undefined
    settle?.()
  }

  /** Sets the function called when the body ends. */
  onEnd(callback: () => void): void {
    this.#onEnd = callback
  }

  /** The body ended (read to its end, failed or cancelled). */
  end(): void {
    if (this.#ended) return
    this.#ended = true
    this.settle()
    this.#onEnd?.()
  }
}

/** Response bodies built while serving with `Bun.serve()`, by body (Hono may copy a `Response`, not its body). */
const BUN_BODIES = new WeakMap<ReadableStream<Uint8Array>, BunBody>()

/** The Node.js request behind a request of `@hono/node-server`. */
interface NodeIncoming {
  readonly url?: string
  readonly socket?: { readonly encrypted?: unknown }
  readonly httpVersionMajor: number
  readonly stream?: { readonly endAfterHeaders?: boolean }
}

/** Bindings of injected requests (the remote address the other adapters report for `inject()`). */
const INJECT_ENV = Object.freeze({ incoming: Object.freeze({ socket: Object.freeze({ remoteAddress: '127.0.0.1' }) }) })

type HonoMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/** The handlers of the GET and HEAD routes of one path. */
interface ReadHandlers {
  get: AdapterHandler | undefined
  head: AdapterHandler | undefined
}

class HonoHttpAdapter implements HonoAdapter {
  readonly name = 'hono' as const
  readonly app: Hono
  readonly #serveOptions: HonoServeOptions
  /** Number of routes of `app` registered by the adapter (see {@link #middleware}). */
  #routes = 0
  /** The GET and HEAD handlers of each path, served by one route of `app` (see {@link registerRoute}). */
  readonly #reads = new Map<string, ReadHandlers>()
  #fallback: FallbackHandler | undefined
  #prepared = false
  #bun: BunServer | undefined
  /**
   * Streamed bodies of `Bun.serve()` replies (with middleware) neither taken by `#bunFetch` nor ended
   * (see {@link BunBody}): while there is none, `#bunFetch` returns responses untouched (reading
   * `response.body` would turn a text body into a stream that Bun then sends as one).
   */
  #pendingBodies = 0
  /** Idle timeout of the `Bun.serve()` server, in seconds (`0`: none). */
  #idleTimeout = BUN_IDLE_TIMEOUT
  #node: Server | undefined
  #tracker: ConnectionTracker | undefined
  #closing: Promise<void> | undefined

  constructor(options: HonoAdapterOptions) {
    this.app = options.app ?? new Hono()
    this.#serveOptions = options.serveOptions ?? {}
  }

  readonly fetch = (request: Request, env?: unknown): Response | Promise<Response> => {
    this.#prepare()
    return this.app.fetch(request, env)
  }

  registerRoute(route: AdapterRoute): void {
    const handler = route.handler
    const path = toHonoPath(route.path)
    if (route.method === 'GET' || route.method === 'HEAD') {
      // Hono routes HEAD requests to GET handlers: one GET handler per path serves both methods (the
      // plugin registers HEAD routes first), so that a request matches a single handler and Hono
      // skips its middleware composition
      const existing = this.#reads.get(path)
      if (existing !== undefined) {
        if (route.method === 'GET') existing.get = handler
        else existing.head = handler
        return
      }
      const reads: ReadHandlers =
        route.method === 'GET' ? { get: handler, head: undefined } : { get: undefined, head: handler }
      this.#reads.set(path, reads)
      this.#routes++
      this.app.get(path, (c: Context, next: Next) => {
        const read = c.req.raw.method === 'HEAD' ? reads.head : reads.get
        return read === undefined ? next().then(() => c.res) : this.#serve(c, read)
      })
      return
    }
    this.#routes++
    this.app.on(route.method as HonoMethod, path, (c: Context) => this.#serve(c, handler))
  }

  setFallbackHandler(handler: FallbackHandler): void {
    this.#fallback = handler
  }

  #prepare(): void {
    if (this.#prepared) return
    this.#prepared = true
    this.app.notFound(c => this.#serveFallback(c, undefined))
    this.app.onError((error, c) => this.#serveFallback(c, error))
  }

  async #serve(c: Context, handler: AdapterHandler): Promise<Response> {
    const request = this.#request(c)
    // Hono routes the WHATWG-normalised URL (`/a/../b` → `/b`, `%2e%2e` resolved): when the raw
    // target differs (Node.js; on Bun only the normalised URL is known), let the plugin route the raw
    // path, like on the other adapters
    const reply =
      this.#fallback !== undefined && request.rawTarget && pathOf(request.url) !== pathOf(pathAndQuery(c.req.raw.url))
        ? await this.#fallback(request)
        : await handler(request)
    return this.#toResponse(c, reply)
  }

  async #serveFallback(c: Context, error: unknown): Promise<Response> {
    if (this.#fallback === undefined) throw error ?? new Error('No fallback handler')
    return this.#toResponse(c, await this.#fallback(this.#request(c), error))
  }

  #request(c: Context): HonoAdapterRequest {
    return new HonoAdapterRequest(c, this.#servedByBun(c) ? this.#bun : undefined)
  }

  /** Whether the request of `c` was received by the `Bun.serve()` server of the adapter. */
  #servedByBun(c: Context): boolean {
    return this.#bun !== undefined && c.env === this.#bun
  }

  /**
   * Whether `app` has routes the adapter did not register (middleware, other routes): only they can
   * set headers on the context or read the response.
   */
  #middleware(): boolean {
    return this.app.routes.length !== this.#routes
  }

  #toResponse(c: Context, reply: AdapterReply): Response {
    const middleware = this.#middleware()
    if (this.#servedByBun(c)) {
      return reply.body instanceof ReadableStream
        ? this.#bunStream(c, reply, middleware)
        : toResponse(c, reply, middleware)
    }
    const outgoing = nodeOutgoing(c)
    if (outgoing !== undefined) {
      const body = reply.body instanceof ReadableStream ? reply.body : null
      if (outgoing.destroyed) {
        // @hono/node-server: the client left before the reply was ready (an async pre-flight). The
        // server would neither read nor cancel the body: release it (event source, request scope)
        discardStream(body)
        return toResponse(c, { ...reply, body: null }, middleware)
      }
      if (body !== null) {
        // the client may leave before @hono/node-server reads the body (its own listener then comes
        // too late): a body nobody locked is cancelled when the response closes unfinished
        outgoing.once('close', () => {
          if (!outgoing.writableFinished) discardStream(body)
        })
      }
      // a quiet event stream must outlive a socket timeout
      if (reply.eventStream === true && typeof outgoing.setTimeout === 'function') outgoing.setTimeout(0)
    }
    return toResponse(c, reply, middleware)
  }

  /**
   * The response of a streamed reply to a request of `Bun.serve()`: the end of its body is observed
   * (idle timeout, native blob: see {@link #bunSend}).
   */
  #bunStream(c: Context, reply: AdapterReply, middleware: boolean): Response {
    const reader = (reply.body as ReadableStream<Uint8Array>).getReader()
    const served = new BunBody(
      reply.blob,
      middleware
        ? () => {
            this.#pendingBodies--
          }
        : undefined,
    )
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          let result: Awaited<ReturnType<typeof reader.read>>
          try {
            result = await reader.read()
          } catch (error) {
            served.end()
            throw error
          }
          if (result.done) {
            served.end() // before closing: Bun ignores timeout() once the response is complete
            controller.close()
            return
          }
          controller.enqueue(result.value)
        },
        cancel(reason) {
          served.end()
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    )
    const response = toResponse(c, { ...reply, body }, middleware)
    if (!middleware) {
      // nothing else handles the request (see the fetch handler given to Bun.serve()): Bun sends this
      // response, unless it does not carry the body (an invalid header: the body was discarded)
      return served.ended ? response : this.#bunSend(response, body, served, c.req.raw)
    }
    // middleware may copy the response (not its body) or replace it: #bunFetch finds the body
    this.#pendingBodies++
    BUN_BODIES.set(body, served)
    return response
  }

  /** The fetch handler given to `Bun.serve()` when `app` has middleware (see {@link #bunStream}). */
  async #bunFetch(request: Request, server: BunServer): Promise<Response> {
    const response = await this.app.fetch(request, server)
    // only a streamed reply needs more: leave the other responses untouched (see #pendingBodies)
    if (this.#pendingBodies === 0) return response
    const body = response.body
    const served = body === null ? undefined : BUN_BODIES.get(body)
    if (body === null || served === undefined) return response
    BUN_BODIES.delete(body)
    served.settle()
    return this.#bunSend(response, body, served, request)
  }

  /**
   * The response Bun sends for a streamed reply, once final: a file `Blob` is sent natively, a
   * stream with the idle timeout of the connection lifted.
   */
  #bunSend(response: Response, body: ReadableStream<Uint8Array>, served: BunBody, request: Request): Response {
    if (served.blob !== undefined && !body.locked) {
      // a Blob is sent by Bun itself (sendfile, exact Content-Length; a stream would be chunked). Bun
      // opens its file as soon as it takes the response: release the stream (and with it the request
      // scope, which may delete the file) right after
      const native = new Response(served.blob, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      setImmediate(() => discardStream(body))
      return native
    }
    const server = this.#bun
    const idleTimeout = this.#idleTimeout
    if (idleTimeout > 0 && !served.ended && typeof server?.timeout === 'function') {
      // the idle timeout of Bun.serve() also cuts a response whose stream pauses (SSE, slow producers):
      // lift it while the stream is sent, then restore it for the keep-alive connection (a body that
      // already ended would never restore it)
      server.timeout(request, 0)
      served.onEnd(() => {
        try {
          server.timeout?.(request, idleTimeout)
        } catch {
          // the connection is gone
        }
      })
    }
    return response
  }

  async listen(port: number, host: string): Promise<HttpServerAddress> {
    this.#prepare()
    this.#closing = undefined
    const bun = (globalThis as { Bun?: BunRuntime }).Bun
    if (isBun() && bun !== undefined) {
      const options = this.#serveOptions
      this.#idleTimeout = typeof options.idleTimeout === 'number' ? options.idleTimeout : BUN_IDLE_TIMEOUT
      const server = bun.serve({
        // Znight enforces the body limits (route @BodyLimit, plugin bodyLimit): not Bun's 128 MiB default
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        ...options,
        port,
        hostname: host,
        // without middleware, the response of a Znight route is the one Bun sends (no wrapper needed)
        fetch: (request, server) =>
          this.#middleware() ? this.#bunFetch(request, server) : this.app.fetch(request, server),
      })
      this.#bun = server
      return serverAddress(server.hostname, server.port)
    }
    let nodeServer: typeof import('@hono/node-server')
    try {
      nodeServer = await import('@hono/node-server')
    } catch (error) {
      throw new Error(
        'honoAdapter on Node.js requires the optional peer dependency "@hono/node-server" (npm i @hono/node-server)',
        { cause: error },
      )
    }
    const server = nodeServer.createAdaptorServer({ fetch: this.app.fetch }) as Server
    this.#node = server
    this.#tracker = new ConnectionTracker(server)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') return serverAddress(host, port)
    return serverAddress(address.address, address.port, address.family)
  }

  close(options: AdapterCloseOptions = {}): Promise<void> {
    const bun = this.#bun
    if (bun !== undefined) {
      if (options.force === true) {
        this.#closing = Promise.resolve(bun.stop(true))
      } else {
        this.#closing ??= Promise.resolve(bun.stop(false))
      }
      return this.#closing
    }
    const server = this.#node
    const tracker = this.#tracker
    if (server === undefined || tracker === undefined) return Promise.resolve()
    this.#closing = closeServer(server, tracker, this.#closing, options.force === true)
    return this.#closing
  }

  inject(request: InjectRequest): Promise<InjectResponse> {
    return bufferInjectStream(stream => this.injectStream(stream), request)
  }

  injectStream(request: InjectStreamRequest): Promise<InjectStreamResponse> {
    this.#prepare()
    return injectFetchStream(request => this.app.request(request, undefined, INJECT_ENV), request)
  }
}

/** A Hono request as an {@link AdapterRequest} (a class: no closure per request). */
class HonoAdapterRequest implements AdapterRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly ip: string | undefined
  readonly remoteAddress: string | undefined
  readonly encrypted: boolean
  readonly raw: Request
  readonly rawResponse: Context
  /** `url` is the raw request target (Node.js), not the WHATWG-normalised URL of `raw`. */
  readonly rawTarget: boolean
  /** The Node.js request of `@hono/node-server`, absent on Bun and for `inject()`. */
  readonly #incoming: NodeIncoming | undefined
  /**
   * The same request over HTTP/1.1, read directly (Node.js streams): no Fetch `Request` and body
   * stream are built for it.
   */
  readonly #http1: IncomingMessage | undefined
  /** Received by the `Bun.serve()` server of the adapter: its body is framed by the HTTP parser. */
  readonly #bun: boolean
  #body: Promise<Uint8Array> | undefined

  constructor(c: Context, bun: BunServer | undefined) {
    const request = c.req.raw
    this.method = request.method
    this.raw = request
    this.rawResponse = c
    this.#bun = bun !== undefined
    if (bun !== undefined) {
      // Bun.serve(): only the normalised URL is known; the address is asked now (Bun no longer knows
      // it once the response is sent)
      const url = request.url
      const address = bun.requestIP?.(request)?.address ?? undefined
      this.url = pathAndQuery(url)
      this.rawTarget = false
      this.headers = fetchHeaders(request.headers)
      this.ip = address
      this.remoteAddress = address
      this.encrypted = url.startsWith('https:')
      this.#incoming = undefined
      this.#http1 = undefined
      return
    }
    const incoming = nodeIncoming(c)
    const http1 = incoming !== undefined && incoming.httpVersionMajor < 2 ? (incoming as IncomingMessage) : undefined
    const address = remoteAddress(c)
    const target = incoming?.url
    // the raw target on Node.js; for a Web request only the normalised URL is known
    this.rawTarget = typeof target === 'string' && target !== ''
    this.url = pathAndQuery(this.rawTarget ? (target as string) : request.url)
    this.headers = (http1 === undefined ? undefined : distinctHeaders(http1)) ?? fetchHeaders(request.headers)
    this.ip = address
    this.remoteAddress = address
    this.encrypted = incoming === undefined ? request.url.startsWith('https:') : incoming.socket?.encrypted === true
    this.#incoming = incoming
    this.#http1 = http1
  }

  readBody(limit: number): Promise<Uint8Array> {
    if (this.#body === undefined) {
      const http1 = this.#http1
      if (http1 !== undefined) this.#body = readNodeBody(http1, limit)
      else if (this.#bun && this.#framed()) this.#body = readFramedBody(this.raw, limit, this.headers['content-length'])
      else this.#body = readWebStream(() => this.raw.body, limit, this.headers['content-length'])
    }
    return this.#body
  }

  /**
   * Whether the whole body can be read at once from `Bun.serve()`: its length is declared (the
   * HTTP parser then reads no more) and nothing read it yet.
   */
  #framed(): boolean {
    const headers = this.headers
    return headers['content-length'] !== undefined && headers['transfer-encoding'] === undefined && !this.raw.bodyUsed
  }

  streamBody(limit: number): ReadableStream<Uint8Array> {
    const http1 = this.#http1
    if (http1 !== undefined) return nodeBodyStream(http1, limit)
    return webBodyStream(() => this.raw.body, limit, this.headers['content-length'])
  }

  // asked only without content-length / transfer-encoding: a request read from an HTTP/1.1
  // connection then has no body (`@hono/node-server` still gives every POST a body stream), an
  // HTTP/2 one unless its HEADERS frame ended the stream; a Web `Request` (Bun, inject) says it
  hasBody(): boolean {
    const incoming = this.#incoming
    return incoming === undefined
      ? this.raw.body !== null
      : incoming.httpVersionMajor >= 2 && incoming.stream?.endAfterHeaders === false
  }

  onAbort(listener: () => void): void {
    const outgoing = this.#bun ? undefined : nodeOutgoing(this.rawResponse)
    if (outgoing !== undefined) {
      onResponseAbort(outgoing as unknown as ServerResponse, listener)
      return
    }
    // Bun.serve() and inject(): the request signal aborts when the client leaves
    const signal = this.raw.signal
    if (signal.aborted) queueMicrotask(listener)
    else signal.addEventListener('abort', listener, { once: true })
  }
}

/** The headers of a Fetch request: lower-case names, repeated headers joined (`Headers` semantics). */
function fetchHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {}
  // forEach: no iterator nor entry array per header
  source.forEach((value, name) => {
    headers[name] = value
  })
  return headers
}

/**
 * Reads at once (`request.bytes()`, no stream) the body of a request received by `Bun.serve()`
 * whose `content-length` is declared: Bun reads exactly that many bytes, so checking the declared
 * length enforces `limit`. Failures are those of {@link readWebStream}: 413 above `limit`, 400 when
 * the client aborts.
 */
async function readFramedBody(request: Request, limit: number, contentLength: string | undefined): Promise<Uint8Array> {
  if (exceedsDeclaredLength(contentLength, limit)) throw payloadTooLarge(limit)
  let bytes: Uint8Array
  try {
    bytes = await request.bytes()
  } catch (error) {
    throw new BadRequestException('Failed to read the request body', undefined, { cause: error })
  }
  if (bytes.byteLength > limit) throw payloadTooLarge(limit)
  return bytes
}

/**
 * The headers of a Node.js request when none is repeated: then they hold the values of its Fetch
 * `Headers` (Node.js keeps the first of some repeated headers where `Headers` join them all).
 */
function distinctHeaders(request: IncomingMessage): Record<string, string | undefined> | undefined {
  const headers = request.headers
  let count = 0
  for (const name in headers) {
    if (typeof headers[name] !== 'string') return undefined
    count++
  }
  return count * 2 === request.rawHeaders.length ? (headers as Record<string, string | undefined>) : undefined
}

/** The part of a Node.js `ServerResponse` used here. */
interface NodeOutgoing {
  readonly writableFinished: boolean
  readonly destroyed: boolean
  once(event: 'close', listener: () => void): unknown
  setTimeout?(ms: number): unknown
}

/** The Node.js response of `@hono/node-server` (`c.env.outgoing`), absent on Bun and for `inject()`. */
function nodeOutgoing(c: Context): NodeOutgoing | undefined {
  const outgoing = (c.env as { outgoing?: Partial<NodeOutgoing> } | undefined)?.outgoing
  return typeof outgoing?.once === 'function' ? (outgoing as NodeOutgoing) : undefined
}

/** The Node.js request of `@hono/node-server` (`c.env.incoming`), absent on Bun and for `inject()`. */
function nodeIncoming(c: Context): NodeIncoming | undefined {
  const incoming = (c.env as { incoming?: Partial<NodeIncoming> } | undefined)?.incoming
  return typeof incoming?.httpVersionMajor === 'number' ? (incoming as NodeIncoming) : undefined
}

function pathAndQuery(url: string): string {
  if (url.startsWith('/')) return url
  const scheme = url.indexOf('://')
  const start = url.indexOf('/', scheme === -1 ? 0 : scheme + 3)
  return start === -1 ? '/' : url.slice(start)
}

function pathOf(url: string): string {
  const query = url.indexOf('?')
  return query === -1 ? url : url.slice(0, query)
}

function remoteAddress(c: Context): string | undefined {
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } }; requestIP?: BunServer['requestIP'] }
    | undefined
  if (env === undefined || env === null) return undefined
  if (typeof env.requestIP === 'function') return env.requestIP(c.req.raw)?.address ?? undefined
  return env.incoming?.socket?.remoteAddress
}

/**
 * The `Response` of a reply. Without `middleware` (see `#middleware`), nothing set headers on the
 * context and nothing reads the response: headers given as a record of strings are sent as is by
 * `@hono/node-server` (no `Headers` object), and a text body as a string.
 */
function toResponse(c: Context, reply: AdapterReply, middleware: boolean): Response {
  if (reply.raw === true) {
    discardStream(reply.body instanceof ReadableStream ? reply.body : null)
    return c.res
  }
  if (!middleware && isStringRecord(reply.headers)) {
    return new Response(reply.text ?? reply.body, {
      status: reply.status,
      headers: reply.headers as Readonly<Record<string, string>>,
    })
  }
  const headers = new Headers()
  try {
    for (const name of Object.keys(reply.headers)) {
      const value = reply.headers[name]
      if (typeof value === 'string') headers.set(name, value)
      else if (value !== undefined) for (const item of value) headers.append(name, item)
    }
  } catch {
    // a header Headers refuses (the plugin validates them): never rethrow into Hono's onError, which
    // would run the pipeline again; release the body and answer a plain 500, like writeNodeReply
    discardStream(reply.body instanceof ReadableStream ? reply.body : null)
    return new Response('{"statusCode":500,"error":"Internal Server Error"}', {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  if (middleware) keepContextCookies(c, headers)
  return new Response(reply.text ?? reply.body, { status: reply.status, headers })
}

/** Whether every header has a single value (a record of strings is a valid `HeadersInit`). */
function isStringRecord(headers: Readonly<Record<string, HeaderValue>>): boolean {
  // Object.keys: faster than for...in on the null-prototype records of the pipeline (V8)
  const names = Object.keys(headers)
  for (let index = 0; index < names.length; index++) {
    if (typeof headers[names[index] as string] !== 'string') return false
  }
  return true
}

/**
 * Keeps the cookies Hono middleware set before the Znight route (`setCookie(c, ...)`,
 * `c.header('set-cookie', ..., { append: true })`) before the reply's own, like the other adapters.
 * Hono drops the headers of the context when a handler returns its own `Response` (or, when a
 * middleware read `c.res`, replaces the response's cookies with the context's): the reply's cookies
 * are added to the context too, so that both ways end with every cookie, in order.
 */
function keepContextCookies(c: Context, headers: Headers): void {
  let context: string[]
  try {
    // the headers of the context without changing it (`c.res` would create the context response)
    context = c.newResponse(null).headers.getSetCookie()
  } catch {
    return // a status a bodyless Response refuses (`c.status(101)`): nothing to keep
  }
  if (context.length === 0) return
  const own = headers.getSetCookie()
  for (const line of own) c.header('set-cookie', line, { append: true })
  headers.delete('set-cookie')
  for (const line of context) headers.append('set-cookie', line)
  for (const line of own) headers.append('set-cookie', line)
}
