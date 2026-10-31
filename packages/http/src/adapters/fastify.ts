/**
 * `@znight/http/fastify`: serves Znight routes with [Fastify](https://fastify.dev) 5 (optional
 * peer dependency `fastify`). Routing uses Fastify's router; body parsing, validation and
 * serialisation stay Znight's, so responses are identical to the other adapters.
 */

import type { OutgoingHttpHeaders } from 'node:http'
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

import { tracingChannel } from 'node:diagnostics_channel'
import { Readable } from 'node:stream'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  type HookHandlerDoneFunction,
  type RouteOptions,
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

/**
 * Fastify's tracing channel of route handlers: while it has subscribers (an APM), every request runs
 * Fastify's whole lifecycle, so that the handler is traced.
 */
const HANDLER_CHANNEL = tracingChannel('fastify.request.handler')

/** The `config` key marking a Znight route that may be served from the `onRequest` hook (see `#onRoute`). */
const DIRECT = Symbol('znight.direct')

/** The hooks that run between `onRequest` and the route handler. */
const HANDLER_HOOKS = ['onRequest', 'preParsing', 'preValidation', 'preHandler'] as const

/** What `#onRoute` records about a Znight route (in its `config`). */
interface DirectRoute {
  readonly handler: AdapterHandler
  /** No route-level `onSend` or `onResponse` hook. */
  readonly bare: boolean
}

/**
 * How the requests of a Fastify route context are served, decided on its first request (see
 * `#lane`): `handler` from the `onRequest` hook, and `raw` when a text reply may be written on the
 * raw response.
 */
interface Lane {
  readonly handler: AdapterHandler
  readonly raw: boolean
}

/**
 * The fields of Fastify's route context (`request[Symbol('fastify.context')]`) read by the adapter.
 * They are internal: the adapter only skips Fastify's lifecycle when they have the expected shape.
 */
interface RouteContext {
  readonly config?: Readonly<Record<PropertyKey, unknown>>
  readonly preParsing?: unknown
  readonly preValidation?: unknown
  readonly preHandler?: unknown
  readonly onSend?: unknown
  readonly onResponse?: unknown
}

/** The keys of Fastify's internal request and reply state read by the adapter (`null`: not found). */
interface InternalKeys {
  /** The route context of a request. */
  readonly context: symbol | null
  /** The headers set with `reply.header()`. */
  readonly headers: symbol | null
  /** The trailers set with `reply.trailer()`. */
  readonly trailers: symbol | null
  /** The serializer set with `reply.serializer()` (`null` when none). */
  readonly serializer: symbol | null
}

class FastifyHttpAdapter implements FastifyAdapter {
  readonly name = 'fastify' as const
  readonly instance: FastifyInstance
  readonly #routes: AdapterRoute[] = []
  readonly #tracker: ConnectionTracker
  /** The Fastify handler of each Znight route (before Fastify binds it). */
  readonly #handlers = new Map<unknown, AdapterHandler>()
  /** By Fastify route context: how its requests are served (`null`: through Fastify's lifecycle). */
  readonly #lanes = new WeakMap<object, Lane | null>()
  #keys: InternalKeys | undefined
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
      // Znight reads and parses bodies itself: accept every content type without consuming it. The
      // RegExp parser matches every content type like '*' does, but Fastify caches what a RegExp
      // matched (it parses the content type again on every request to find the '*' parser)
      child.removeAllContentTypeParsers()
      child.addContentTypeParser('*', ignoreBody)
      child.addContentTypeParser(/^/, ignoreBody)
      child.addHook('onRequest', this.#onRequest)
      // added last: sees the route options once every other `onRoute` hook changed them
      child.addHook('onRoute', this.#onRoute)
      for (const route of routes) {
        const handler = route.handler
        const fastifyHandler = (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
          this.#reply(reply, handler(adapterRequest(request, reply)))
        this.#handlers.set(fastifyHandler, handler)
        child.route({
          method: route.method,
          url: toFastifyPath(route.path),
          exposeHeadRoute: false,
          handler: fastifyHandler,
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

  /**
   * Records in the `config` of a Znight route whether it may be served from the `onRequest` hook:
   * its handler is still the adapter's (no `onRoute` hook wrapped it) and no route-level hook or
   * schema runs between `onRequest` and the handler. The hooks of the instance are checked on the
   * first request (see `#lane`).
   */
  readonly #onRoute = (options: RouteOptions): void => {
    const handler = this.#handlers.get(options.handler)
    if (handler === undefined || options.schema !== undefined) return
    if (HANDLER_HOOKS.some(hook => hasHooks(options[hook]))) return
    const route: DirectRoute = { handler, bare: !hasHooks(options.onSend) && !hasHooks(options.onResponse) }
    options.config = { ...options.config, [DIRECT]: route }
  }

  /**
   * The `onRequest` hook of the Znight context. A route request that no later hook, schema or
   * tracing subscriber needs (see `#lane`) is served from here: Fastify skips its content type
   * parsing and the steps between this hook and the handler, which do nothing for Znight routes.
   * Otherwise the request goes on through Fastify's lifecycle.
   */
  readonly #onRequest = (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    const lane = this.#lane(request, reply)
    if (lane !== null && !HANDLER_CHANNEL.hasSubscribers) {
      this.#serve(lane, request, reply)
      return
    }
    // Fastify answers 415 to a content type it cannot parse (`foo`, an empty one) before the route
    // runs: hide such a header from Fastify (Znight reads it, and parses the body as bytes)
    const contentType = request.headers['content-type']
    if (contentType !== undefined && request.mediaType === undefined) {
      HIDDEN_CONTENT_TYPES.set(request.raw, contentType)
      delete request.raw.headers['content-type']
    }
    done()
  }

  /**
   * How the requests of the route of `request` are served, decided once per route context: from the
   * `onRequest` hook when `#onRoute` marked the route and the instance has no `preParsing`,
   * `preValidation` or `preHandler` hook (the `onRequest` hook of the Znight context is then the
   * last one); with a text reply written on the raw response when no `onSend` or `onResponse` hook
   * runs either (see `#writeRaw`). `null`: through Fastify's lifecycle (404s, hooks, a Fastify
   * version whose route context differs).
   */
  #lane(request: FastifyRequest, reply: FastifyReply): Lane | null {
    this.#keys ??= {
      context: ownSymbol(request, 'fastify.context'),
      headers: ownSymbol(reply, 'fastify.reply.headers'),
      trailers: ownSymbol(reply, 'fastify.reply.trailers'),
      serializer: ownSymbol(reply, 'fastify.reply.serializer'),
    }
    const key = this.#keys.context
    const context = key === null ? undefined : (request as unknown as Record<symbol, unknown>)[key]
    if (typeof context !== 'object' || context === null) return null
    let lane = this.#lanes.get(context)
    if (lane === undefined) {
      lane = laneOf(context as RouteContext, this.#keys)
      this.#lanes.set(context, lane)
    }
    return lane
  }

  /** Serves a route request from the `onRequest` hook (see `#lane`). */
  #serve(lane: Lane, request: FastifyRequest, reply: FastifyReply): void {
    let pending: Promise<AdapterReply>
    try {
      pending = lane.handler(new FastifyAdapterRequest(request, reply, reply))
    } catch (error) {
      // what Fastify does when a route handler throws
      reply.send(asError(error))
      return
    }
    pending.then(
      result => this.#settle(lane, reply, result),
      () => this.#settle(lane, reply, internalError()),
    )
  }

  /** Writes the reply of a request served from the `onRequest` hook; a failure is handled like Fastify does. */
  #settle(lane: Lane, reply: FastifyReply, result: AdapterReply): void {
    try {
      if (!lane.raw || !this.#writeRaw(reply, result)) this.#write(reply, result)
    } catch (error) {
      // what Fastify does when the promise of a route handler rejects
      if (reply.sent) reply.log.error({ err: error }, 'Promise errored, but reply.sent = true was set')
      else reply.send(asError(error))
    }
  }

  /**
   * Writes a text reply on the raw response, as `reply.send(text)` would without `onSend` hook: one
   * `writeHead()` with the same headers in the same order, then the text. Only when nothing set
   * reply headers or trailers before (an `onRequest` hook) and Fastify would send the headers and
   * text unchanged (content type, exact `content-length`). Returns whether it wrote the reply.
   */
  #writeRaw(reply: FastifyReply, result: AdapterReply): boolean {
    const text = result.text
    const body = result.body
    if (text === undefined || !(body instanceof Uint8Array) || result.raw === true) return false
    const headers = result.headers
    const length = headers['content-length']
    if (typeof length !== 'string' || Number(length) !== body.byteLength) return false
    // a content type Fastify cannot parse is replaced by `reply.send()` (text/plain)
    const type = headers['content-type']
    if (!sendsTextAsIs(type) || (type !== JSON_TYPE && !MEDIA_TYPE.test(type as string))) return false
    const response = reply.raw
    if (reply.sent || response.destroyed || response.headersSent || reply.request.raw.httpVersionMajor !== 1) {
      return false
    }
    const keys = this.#keys as InternalKeys
    const state = reply as unknown as Record<symbol, unknown>
    if (keys.headers === null || keys.trailers === null || state[keys.trailers] !== null) return false
    // a serializer set by a hook transforms text sent with `reply.send()`
    if (keys.serializer === null || state[keys.serializer] !== null) return false
    if (!isEmptyRecord(state[keys.headers])) return false
    response.writeHead(result.status, headers as OutgoingHttpHeaders)
    response.end(text)
    return true
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
      result = internalError()
    }
    this.#write(reply, result)
    return reply
  }

  /** Writes a reply through Fastify (`reply.send()`: `onSend` hooks...). */
  #write(reply: FastifyReply, result: AdapterReply): void {
    if (result.raw === true || reply.sent || reply.raw.destroyed) {
      discardStream(result.body instanceof ReadableStream ? result.body : null)
      return
    }
    if (result.eventStream === true) {
      // no onSend hook (compression, ETag...) may rewrite an event stream: write it on the raw
      // response, with the headers Fastify hooks already set (`onRequest`...) under the plugin's,
      // and their cookies before the plugin's (as reply.header('set-cookie') does on the other path)
      const native = lowerCaseHeaders(reply.getHeaders())
      const headers = { ...native, ...withNativeCookies(native['set-cookie'], result.headers) }
      reply.hijack()
      writeNodeReply(reply.raw, { ...result, headers })
      return
    }
    reply.code(result.status)
    const headers = result.headers
    for (const name of Object.keys(headers)) reply.header(name, headers[name])
    const body = result.body
    if (body === null) {
      reply.send()
      return
    }
    if (body instanceof Uint8Array) {
      // a string is written with the headers at once (bytes take a second write)
      if (result.text !== undefined && sendsTextAsIs(headers['content-type'])) reply.send(result.text)
      else reply.send(Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength))
      return
    }
    const stream = body instanceof Blob ? body.stream() : body
    reply.send(Readable.fromWeb(stream as import('node:stream/web').ReadableStream))
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

/**
 * The lane of a route context (see `FastifyHttpAdapter.#lane`). Once the instance is ready, every
 * lifecycle hook list of a context is `null` or a non-empty array.
 */
function laneOf(context: RouteContext, keys: InternalKeys): Lane | null {
  const route = context.config?.[DIRECT] as DirectRoute | undefined
  if (route === undefined) return null
  if (context.preParsing !== null || context.preValidation !== null || context.preHandler !== null) return null
  const raw = route.bare && context.onSend === null && context.onResponse === null
  return { handler: route.handler, raw: raw && keys.headers !== null && keys.trailers !== null }
}

/** The content type parser of the Znight context: the body is left unread (Znight reads it). */
function ignoreBody(_request: FastifyRequest, _payload: unknown, done: (error: null, body: undefined) => void): void {
  done(null, undefined)
}

/** Whether a route option holds hooks (a function or a non-empty array). */
function hasHooks(value: unknown): boolean {
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)
}

/** An own symbol-keyed property of a Fastify object, by the symbol's description (internal state). */
function ownSymbol(target: object, description: string): symbol | null {
  for (const symbol of Object.getOwnPropertySymbols(target)) if (symbol.description === description) return symbol
  return null
}

function isEmptyRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  for (const _key in value) return false
  return true
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error })
}

/** The last-resort 500 of a handler promise that rejected (the pipeline maps errors: should not happen). */
function internalError(): AdapterReply {
  return {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: new TextEncoder().encode('{"statusCode":500,"error":"Internal Server Error"}'),
  }
}

/** The JSON content type of the plugin (with a charset). */
const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * Whether Fastify sends a string with this content type unchanged: it adds a charset to a JSON
 * type without one, and a content type to a string without one.
 */
/** A `type/subtype` media type, optionally followed by parameters: what Fastify's `ContentType` accepts. */
const MEDIA_TYPE = /^\s*[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+\s*(?:;|$)/

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
