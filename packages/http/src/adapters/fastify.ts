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
  InjectStreamRequest,
  InjectStreamResponse,
} from '../adapter.ts'
import type { HeaderValue } from '../exceptions.ts'

import { Readable } from 'node:stream'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'

import { toFastifyPath } from '../path.ts'
import { discardStream } from '../stream.ts'
import {
  ConnectionTracker,
  isEncrypted,
  nodeBodyStream,
  normalizeNodeHeaders,
  onResponseAbort,
  readNodeBody,
  withNativeCookies,
  writeNodeReply,
} from './node-io.ts'
import {
  bufferInjectStream,
  type LightInjectOptions,
  lightInjectOptions,
  lightStreamResponse,
  serverAddress,
} from './shared.ts'

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

/** `content-type` headers hidden from Fastify (see `#register`), by request. */
const HIDDEN_CONTENT_TYPES = new WeakMap<object, string>()

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
          this.#reply(reply, this.#dispatchFallback(request, reply, error)).catch(() => undefined)
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
      // Fastify answers 415 to a content type it cannot parse (`foo`, an empty one) before the route
      // runs: hide such a header from Fastify (Znight reads it, and parses the body as bytes)
      child.addHook('onRequest', (request, _reply, done) => {
        const contentType = request.headers['content-type']
        if (contentType !== undefined && request.mediaType === undefined) {
          HIDDEN_CONTENT_TYPES.set(request.raw, contentType)
          delete request.raw.headers['content-type']
        }
        done()
      })
      for (const route of routes) {
        const handler = route.handler
        child.route({
          method: route.method,
          url: toFastifyPath(route.path),
          exposeHeadRoute: false,
          handler: (request, reply) => this.#reply(reply, handler(adapterRequest(request, reply))),
        })
      }
      child.setNotFoundHandler((request, reply) =>
        this.#reply(reply, this.#dispatchFallback(request, reply, undefined)),
      )
      child.setErrorHandler((error, request, reply) =>
        this.#reply(reply, this.#dispatchFallback(request, reply, error)),
      )
      done()
    })
    await this.instance.ready()
  }

  #dispatchFallback(request: FastifyRequest, reply: FastifyReply, error: unknown): Promise<AdapterReply> {
    if (this.#fallback === undefined) return Promise.reject(error ?? new Error('No fallback handler'))
    return this.#fallback(adapterRequest(request, undefined, reply), error)
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
    if (result.eventStream === true) {
      // no onSend hook (compression, ETag...) may rewrite an event stream: write it on the raw
      // response, with the headers Fastify hooks already set (`onRequest`...) under the plugin's,
      // and their cookies before the plugin's (as reply.header('set-cookie') does on the other path)
      const native = lowerCaseHeaders(reply.getHeaders())
      const headers = { ...native, ...withNativeCookies(native['set-cookie'], result.headers) }
      reply.hijack()
      writeNodeReply(reply.raw, { ...result, headers })
      return reply
    }
    reply.code(result.status)
    for (const name of Object.keys(result.headers)) reply.header(name, result.headers[name])
    const body = result.body
    if (body === null) return reply.send()
    if (body instanceof Uint8Array) {
      // a string is written with the headers at once (bytes take a second write)
      if (result.text !== undefined && sendsTextAsIs(result.headers['content-type'])) return reply.send(result.text)
      return reply.send(Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength))
    }
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

  inject(request: InjectRequest): Promise<InjectResponse> {
    return bufferInjectStream(stream => this.injectStream(stream), request)
  }

  async injectStream(request: InjectStreamRequest): Promise<InjectStreamResponse> {
    await this.#prepare()
    const options: LightInjectOptions = await lightInjectOptions(request)
    // Fastify forwards the options to light-my-request (`payloadAsStream`)
    const inject = this.instance.inject as unknown as (options: LightInjectOptions) => Promise<unknown>
    const response = await inject.call(this.instance, options)
    return lightStreamResponse(response as Parameters<typeof lightStreamResponse>[0], request.signal)
  }
}

/** The JSON content type of the plugin (with a charset). */
const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * Whether Fastify sends a string with this content type unchanged: it adds a charset to a JSON
 * type without one, and a content type to a string without one.
 */
function sendsTextAsIs(type: HeaderValue | undefined): boolean {
  if (typeof type !== 'string') return false
  if (type === JSON_TYPE) return true
  const semicolon = type.indexOf(';')
  return !(semicolon === -1 ? type : type.slice(0, semicolon)).toLowerCase().includes('json')
}

function lowerCaseHeaders(
  headers: Readonly<Record<string, string | number | readonly string[] | undefined>>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name.toLowerCase()] = typeof value === 'object' ? [...value] : String(value)
  }
  return result
}

function adapterRequest(
  request: FastifyRequest,
  reply: FastifyReply | undefined,
  response: FastifyReply | undefined = reply,
): AdapterRequest {
  const hidden = HIDDEN_CONTENT_TYPES.get(request.raw)
  if (hidden !== undefined) {
    // Fastify is done with the content type: restore it (for Znight and `@Req()`)
    HIDDEN_CONTENT_TYPES.delete(request.raw)
    request.raw.headers['content-type'] = hidden
  }
  return new FastifyAdapterRequest(request, reply, response)
}

/** A Fastify request as an {@link AdapterRequest} (a class: no closure per request). */
class FastifyAdapterRequest implements AdapterRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly ip: string | undefined
  readonly remoteAddress: string | undefined
  readonly encrypted: boolean
  readonly raw: FastifyRequest
  /** `@Res()`: the reply of a route, `undefined` for the fallback handler. */
  readonly rawResponse: FastifyReply | undefined
  /** The reply whose disconnection aborts the request. */
  readonly #response: FastifyReply | undefined
  #body: Promise<Uint8Array> | undefined

  constructor(request: FastifyRequest, reply: FastifyReply | undefined, response: FastifyReply | undefined) {
    this.method = request.raw.method ?? request.method
    this.url = request.raw.url ?? request.url
    this.headers = normalizeNodeHeaders(request.headers)
    this.ip = request.ip
    this.remoteAddress = request.raw.socket?.remoteAddress
    this.encrypted = isEncrypted(request.raw)
    this.raw = request
    this.rawResponse = reply
    this.#response = response
  }

  readBody(limit: number): Promise<Uint8Array> {
    this.#body ??= readNodeBody(this.raw.raw, limit)
    return this.#body
  }

  streamBody(limit: number): ReadableStream<Uint8Array> {
    return nodeBodyStream(this.raw.raw, limit)
  }

  rawStatus(): number | undefined {
    return this.rawResponse?.statusCode
  }

  onAbort(listener: () => void): void {
    if (this.#response !== undefined) onResponseAbort(this.#response.raw, listener)
  }
}
