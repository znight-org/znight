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

import { toHonoPath } from '../path.ts'
import { discardStream } from '../stream.ts'
import { isBun } from '../utils.ts'
import { ConnectionTracker, closeServer, nodeBodyStream, onResponseAbort, readNodeBody } from './node-io.ts'
import { bufferInjectStream, injectFetchStream, readWebStream, serverAddress, webBodyStream } from './shared.ts'

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

/** A response body built while serving with `Bun.serve()` (see `#bunFetch`). */
interface BunBody {
  /** The `Blob` (file) the body reads. */
  readonly blob: Blob | undefined
  /** Sets the function called when the body ends (read to its end, failed or cancelled). */
  onEnd(callback: () => void): void
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

class HonoHttpAdapter implements HonoAdapter {
  readonly name = 'hono' as const
  readonly app: Hono
  readonly #serveOptions: HonoServeOptions
  /** Number of routes of `app` registered by the adapter (see {@link #middleware}). */
  #routes = 0
  #fallback: FallbackHandler | undefined
  #prepared = false
  #bun: BunServer | undefined
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
    this.#routes++
    if (route.method === 'HEAD') {
      // Hono routes HEAD requests to GET handlers: serve them from a GET handler that only answers HEAD
      this.app.get(path, (c: Context, next: Next) =>
        c.req.raw.method === 'HEAD' ? this.#serve(c, handler) : next().then(() => c.res),
      )
      return
    }
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
    const request = adapterRequest(c)
    // Hono routes the WHATWG-normalised URL (`/a/../b` → `/b`, `%2e%2e` resolved): when the raw
    // target differs (Node.js), let the plugin route the raw path, like on the other adapters
    const reply =
      this.#fallback !== undefined && pathOf(request.url) !== pathOf(pathAndQuery(c.req.raw.url))
        ? await this.#fallback(request)
        : await handler(request)
    return this.#toResponse(c, reply)
  }

  async #serveFallback(c: Context, error: unknown): Promise<Response> {
    if (this.#fallback === undefined) throw error ?? new Error('No fallback handler')
    return this.#toResponse(c, await this.#fallback(adapterRequest(c), error))
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
    if (this.#bun === undefined || !(reply.body instanceof ReadableStream)) return toResponse(c, reply, middleware)
    // served by Bun.serve(): observe the end of the body (idle timeout, native blob: see #bunFetch)
    const reader = reply.body.getReader()
    let ended = false
    let onEnd = (): void => undefined
    const end = (): void => {
      if (ended) return
      ended = true
      onEnd()
    }
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          let result: Awaited<ReturnType<typeof reader.read>>
          try {
            result = await reader.read()
          } catch (error) {
            end()
            throw error
          }
          if (result.done) {
            end() // before closing: Bun ignores timeout() once the response is complete
            controller.close()
            return
          }
          controller.enqueue(result.value)
        },
        cancel(reason) {
          end()
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    )
    BUN_BODIES.set(body, {
      blob: reply.blob,
      onEnd: callback => {
        onEnd = callback
      },
    })
    return toResponse(c, { ...reply, body }, middleware)
  }

  /** The fetch handler given to `Bun.serve()`. */
  async #bunFetch(request: Request, server: BunServer, idleTimeout: number): Promise<Response> {
    const response = await this.app.fetch(request, server)
    const body = response.body
    const served = body === null ? undefined : BUN_BODIES.get(body)
    if (body === null || served === undefined) return response
    BUN_BODIES.delete(body)
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
    if (idleTimeout > 0 && typeof server.timeout === 'function') {
      // the idle timeout of Bun.serve() also cuts a response whose stream pauses (SSE, slow producers):
      // lift it while the stream is sent, then restore it for the keep-alive connection
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
      const idleTimeout = typeof options.idleTimeout === 'number' ? options.idleTimeout : BUN_IDLE_TIMEOUT
      const server = bun.serve({
        // Znight enforces the body limits (route @BodyLimit, plugin bodyLimit): not Bun's 128 MiB default
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        ...options,
        port,
        hostname: host,
        fetch: (request, server) => this.#bunFetch(request, server, idleTimeout),
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

function adapterRequest(c: Context): AdapterRequest {
  return new HonoAdapterRequest(c)
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
  /** The Node.js request of `@hono/node-server`, absent on Bun and for `inject()`. */
  readonly #incoming: NodeIncoming | undefined
  /**
   * The same request over HTTP/1.1, read directly (Node.js streams): no Fetch `Request` and body
   * stream are built for it.
   */
  readonly #http1: IncomingMessage | undefined
  #body: Promise<Uint8Array> | undefined

  constructor(c: Context) {
    const request = c.req.raw
    const incoming = nodeIncoming(c)
    const http1 = incoming !== undefined && incoming.httpVersionMajor < 2 ? (incoming as IncomingMessage) : undefined
    const address = remoteAddress(c)
    this.method = request.method
    // the raw target on Node.js; on Bun only the normalised URL is known
    this.url = pathAndQuery(typeof incoming?.url === 'string' && incoming.url !== '' ? incoming.url : request.url)
    this.headers = (http1 === undefined ? undefined : distinctHeaders(http1)) ?? fetchHeaders(request.headers)
    this.ip = address
    this.remoteAddress = address
    this.encrypted = incoming === undefined ? request.url.startsWith('https:') : incoming.socket?.encrypted === true
    this.raw = request
    this.rawResponse = c
    this.#incoming = incoming
    this.#http1 = http1
  }

  readBody(limit: number): Promise<Uint8Array> {
    if (this.#body === undefined) {
      const http1 = this.#http1
      this.#body =
        http1 === undefined
          ? readWebStream(() => this.raw.body, limit, this.headers['content-length'])
          : readNodeBody(http1, limit)
    }
    return this.#body
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
    const outgoing = nodeOutgoing(this.rawResponse)
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
  for (const [name, value] of source) headers[name] = value
  return headers
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
  for (const name in headers) if (typeof headers[name] !== 'string') return false
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
