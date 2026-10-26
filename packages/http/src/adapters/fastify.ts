/**
 * `@znight/http/fastify`: serves Znight routes with [Fastify](https://fastify.dev) 5 (optional
 * peer dependency `fastify`). Routing uses Fastify's router; body parsing, validation and
 * serialisation stay Znight's, so responses are identical to the other adapters.
 */
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

import { Readable } from 'node:stream'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'

import { toFastifyPath } from '../path.ts'
import { discardStream } from '../stream.ts'
import { ConnectionTracker, nodeBodyStream, normalizeNodeHeaders, readNodeBody } from './node-io.ts'
import { injectResponse, normalizeInject, serverAddress, toBuffer } from './shared.ts'

/** Options of {@link fastifyAdapter}. */
export interface FastifyAdapterOptions {
  /**
   * An existing instance (with your plugins and hooks). Znight registers its routes in an
   * encapsulated child context (its own body handling and 404 handler) and closes the instance on
   * shutdown. Malformed URLs are then answered by Fastify's `frameworkErrors` handler.
   */
  readonly instance?: FastifyInstance
  /**
   * Options of the instance created when `instance` is absent. Znight sets `exposeHeadRoutes: false`
   * (HEAD is served by Znight), a `maxParamLength` of 8 KiB and a `frameworkErrors` handler.
   */
  readonly options?: FastifyServerOptions
}

/** The Fastify adapter. */
export interface FastifyAdapter extends HttpAdapter {
  readonly name: 'fastify'
  /** The Fastify instance. */
  readonly instance: FastifyInstance
}

/**
 * Creates a Fastify adapter.
 *
 * ```ts
 * import { fastifyAdapter } from '@znight/http/fastify'
 *
 * HttpPlugin.configure({ adapter: fastifyAdapter({ options: { trustProxy: true } }) })
 * ```
 */
export function fastifyAdapter(options: FastifyAdapterOptions = {}): FastifyAdapter {
  return new FastifyHttpAdapter(options)
}

const MAX_PARAM_LENGTH = 8192

class FastifyHttpAdapter implements FastifyAdapter {
  readonly name = 'fastify' as const
  readonly instance: FastifyInstance
  readonly #routes: AdapterRoute[] = []
  readonly #tracker: ConnectionTracker
  #fallback: FallbackHandler | undefined
  #ready: Promise<void> | undefined
  #closing: Promise<void> | undefined

  constructor(options: FastifyAdapterOptions) {
    if (options.instance === undefined) {
      const serverOptions = options.options ?? {}
      this.instance = Fastify({
        exposeHeadRoutes: false,
        frameworkErrors: (error, request, reply) => {
          this.#reply(reply, this.#dispatchFallback(request, error)).catch(() => undefined)
        },
        ...serverOptions,
        routerOptions: { maxParamLength: MAX_PARAM_LENGTH, ...serverOptions.routerOptions },
      })
    } else {
      this.instance = options.instance
    }
    this.#tracker = new ConnectionTracker(this.instance.server)
  }

  registerRoute(route: AdapterRoute): void {
    if (this.#ready !== undefined) throw new Error('fastifyAdapter: routes must be registered before listen()/inject()')
    this.#routes.push(route)
  }

  setFallbackHandler(handler: FallbackHandler): void {
    this.#fallback = handler
  }

  #prepare(): Promise<void> {
    this.#ready ??= this.#register()
    return this.#ready
  }

  async #register(): Promise<void> {
    const routes = this.#routes
    await this.instance.register((child, _options, done) => {
      // Znight reads and parses bodies itself: accept every content type without consuming it
      child.removeAllContentTypeParsers()
      child.addContentTypeParser('*', (_request, _payload, done) => done(null, undefined))
      for (const route of routes) {
        const handler = route.handler
        child.route({
          method: route.method,
          url: toFastifyPath(route.path),
          exposeHeadRoute: false,
          handler: (request, reply) => this.#reply(reply, handler(adapterRequest(request, reply))),
        })
      }
      child.setNotFoundHandler((request, reply) => this.#reply(reply, this.#dispatchFallback(request, undefined)))
      child.setErrorHandler((error, request, reply) => this.#reply(reply, this.#dispatchFallback(request, error)))
      done()
    })
    await this.instance.ready()
  }

  #dispatchFallback(request: FastifyRequest, error: unknown): Promise<AdapterReply> {
    if (this.#fallback === undefined) return Promise.reject(error ?? new Error('No fallback handler'))
    return this.#fallback(adapterRequest(request, undefined), error)
  }

  async #reply(reply: FastifyReply, pending: ReturnType<AdapterHandler>): Promise<FastifyReply> {
    let result: AdapterReply
    try {
      result = await pending
    } catch {
      result = {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: new TextEncoder().encode('{"statusCode":500,"error":"Internal Server Error"}'),
      }
    }
    if (result.raw === true || reply.sent || reply.raw.destroyed) {
      discardStream(result.body instanceof ReadableStream ? result.body : null)
      return reply
    }
    reply.code(result.status)
    for (const name of Object.keys(result.headers)) reply.header(name, result.headers[name])
    const body = result.body
    if (body === null) return reply.send()
    if (body instanceof Uint8Array) return reply.send(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
    const stream = body instanceof Blob ? body.stream() : body
    return reply.send(Readable.fromWeb(stream as import('node:stream/web').ReadableStream))
  }

  async listen(port: number, host: string): Promise<HttpServerAddress> {
    await this.#prepare()
    this.#closing = undefined
    await this.instance.listen({ port, host })
    const address = this.instance.server.address()
    if (address === null || typeof address === 'string') return serverAddress(host, port)
    return serverAddress(address.address, address.port, address.family)
  }

  close(options: AdapterCloseOptions = {}): Promise<void> {
    if (this.#closing === undefined) {
      this.#tracker.closeIdle()
      this.#closing = this.instance.close()
    }
    if (options.force === true) {
      this.instance.server.closeAllConnections?.()
      this.#tracker.destroyAll()
    }
    return this.#closing
  }

  async inject(request: InjectRequest): Promise<InjectResponse> {
    await this.#prepare()
    const normalized = await normalizeInject(request)
    const response = await this.instance.inject({
      method: normalized.method as 'GET',
      url: normalized.url,
      headers: normalized.headers,
      remoteAddress: '127.0.0.1',
      ...(normalized.payload === undefined ? {} : { payload: toBuffer(normalized.payload) }),
    })
    return injectResponse(response.statusCode, response.headers, response.rawPayload)
  }
}

function adapterRequest(request: FastifyRequest, reply: FastifyReply | undefined): AdapterRequest {
  let body: Promise<Uint8Array> | undefined
  return {
    method: request.raw.method ?? request.method,
    url: request.raw.url ?? request.url,
    headers: normalizeNodeHeaders(request.headers),
    ip: request.ip,
    raw: request,
    rawResponse: reply,
    readBody: (limit: number): Promise<Uint8Array> => {
      body ??= readNodeBody(request.raw, limit)
      return body
    },
    streamBody: (limit: number): ReadableStream<Uint8Array> => nodeBodyStream(request.raw, limit),
    rawStatus: (): number | undefined => reply?.statusCode,
  }
}
