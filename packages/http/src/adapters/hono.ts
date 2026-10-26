/**
 * `@znight/http/hono`: serves Znight routes with [Hono](https://hono.dev) 4 (optional peer
 * dependency `hono`). On Bun the server is `Bun.serve()`; on Node.js it is `@hono/node-server`
 * (optional peer dependency, loaded on `listen()`). `inject()` uses `app.request()`.
 */
import type { Server } from 'node:http'
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
} from '../adapter.ts'

import { type Context, Hono, type Next } from 'hono'

import { toHonoPath } from '../path.ts'
import { discardStream } from '../stream.ts'
import { isBun } from '../utils.ts'
import { ConnectionTracker, closeServer } from './node-io.ts'
import { injectFetch, readWebStream, serverAddress, webBodyStream } from './shared.ts'

/** Options of {@link honoAdapter}. */
export interface HonoAdapterOptions {
  /**
   * An existing application: its middleware (`app.use(...)`) runs before the Znight routes. Znight
   * sets its `notFound` and `onError` handlers.
   */
  readonly app?: Hono
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
}

interface BunRuntime {
  serve(options: {
    port: number
    hostname: string
    fetch: (request: Request, server: BunServer) => Response | Promise<Response>
  }): BunServer
}

/** Bindings of injected requests (the remote address the other adapters report for `inject()`). */
const INJECT_ENV = Object.freeze({ incoming: Object.freeze({ socket: Object.freeze({ remoteAddress: '127.0.0.1' }) }) })

type HonoMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

class HonoHttpAdapter implements HonoAdapter {
  readonly name = 'hono' as const
  readonly app: Hono
  #fallback: FallbackHandler | undefined
  #prepared = false
  #bun: BunServer | undefined
  #node: Server | undefined
  #tracker: ConnectionTracker | undefined
  #closing: Promise<void> | undefined

  constructor(options: HonoAdapterOptions) {
    this.app = options.app ?? new Hono()
  }

  readonly fetch = (request: Request, env?: unknown): Response | Promise<Response> => {
    this.#prepare()
    return this.app.fetch(request, env)
  }

  registerRoute(route: AdapterRoute): void {
    const handler = route.handler
    const path = toHonoPath(route.path)
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
    return toResponse(c, await handler(adapterRequest(c)))
  }

  async #serveFallback(c: Context, error: unknown): Promise<Response> {
    if (this.#fallback === undefined) throw error ?? new Error('No fallback handler')
    return toResponse(c, await this.#fallback(adapterRequest(c), error))
  }

  async listen(port: number, host: string): Promise<HttpServerAddress> {
    this.#prepare()
    this.#closing = undefined
    const bun = (globalThis as { Bun?: BunRuntime }).Bun
    if (isBun() && bun !== undefined) {
      const server = bun.serve({ port, hostname: host, fetch: (request, server) => this.app.fetch(request, server) })
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
    this.#prepare()
    return injectFetch(request => this.app.request(request, undefined, INJECT_ENV), request)
  }
}

function adapterRequest(c: Context): AdapterRequest {
  const request = c.req.raw
  const headers: Record<string, string> = {}
  for (const [name, value] of request.headers) headers[name] = value
  let body: Promise<Uint8Array> | undefined
  return {
    method: request.method,
    url: pathAndQuery(request.url),
    headers,
    ip: remoteAddress(c),
    raw: request,
    rawResponse: c,
    readBody: (limit: number): Promise<Uint8Array> => {
      body ??= readWebStream(() => request.body, limit, headers['content-length'])
      return body
    },
    streamBody: (limit: number): ReadableStream<Uint8Array> =>
      webBodyStream(() => request.body, limit, headers['content-length']),
    hasBody: (): boolean => request.body !== null,
  }
}

function pathAndQuery(url: string): string {
  const scheme = url.indexOf('://')
  const start = url.indexOf('/', scheme === -1 ? 0 : scheme + 3)
  return start === -1 ? '/' : url.slice(start)
}

function remoteAddress(c: Context): string | undefined {
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } }; requestIP?: BunServer['requestIP'] }
    | undefined
  if (env === undefined || env === null) return undefined
  if (typeof env.requestIP === 'function') return env.requestIP(c.req.raw)?.address ?? undefined
  return env.incoming?.socket?.remoteAddress
}

function toResponse(c: Context, reply: AdapterReply): Response {
  if (reply.raw === true) {
    discardStream(reply.body instanceof ReadableStream ? reply.body : null)
    return c.res
  }
  const headers = new Headers()
  for (const name of Object.keys(reply.headers)) {
    const value = reply.headers[name]
    if (typeof value === 'string') headers.set(name, value)
    else if (value !== undefined) for (const item of value) headers.append(name, item)
  }
  return new Response(reply.body, { status: reply.status, headers })
}
