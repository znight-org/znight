/**
 * `@znight/http/express`: serves Znight routes with [Express](https://expressjs.com) 5 (optional
 * peer dependency `express`). Routes are mounted on a dedicated router, after the middleware of the
 * application you pass. `inject()` uses the optional peer `light-my-request`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AdapterCloseOptions,
  AdapterRoute,
  FallbackHandler,
  HttpAdapter,
  HttpServerAddress,
  InjectRequest,
  InjectResponse,
  InjectStreamRequest,
  InjectStreamResponse,
} from '../adapter.ts'

import { createServer, type Server } from 'node:http'
import express, { type Express, type NextFunction, type Request, type Response, type Router } from 'express'

import { toRegExpSource } from '../path.ts'
import { ConnectionTracker, closeServer, nodeAdapterRequest, writeNodeFailure, writeNodeReply } from './node-io.ts'
import { bufferInjectStream, injectNodeStream, serverAddress } from './shared.ts'

/** Options of {@link expressAdapter}. */
export interface ExpressAdapterOptions {
  /**
   * An existing application: its middleware (CORS, helmet, sessions...) runs before the Znight
   * routes. Do not add body parsers for Znight routes: Znight reads bodies itself.
   */
  readonly app?: Express
  /**
   * The server to listen with (e.g. `https.createServer({ key, cert })`): the adapter adds its
   * `request` listener. Default: a new `http.createServer()`.
   */
  readonly server?: Server
}

/** The Express adapter. */
export interface ExpressAdapter extends HttpAdapter {
  readonly name: 'express'
  /** The Express application. */
  readonly app: Express
  /** The router holding the Znight routes (mounted on {@link app}). */
  readonly router: Router
  /** The HTTP server, once listening. */
  readonly server: Server | undefined
}

/**
 * Creates an Express adapter.
 *
 * ```ts
 * import { expressAdapter } from '@znight/http/express'
 *
 * const app = express()
 * app.use(cors())
 * HttpPlugin.configure({ adapter: expressAdapter({ app }) })
 * ```
 */
export function expressAdapter(options: ExpressAdapterOptions = {}): ExpressAdapter {
  return new ExpressHttpAdapter(options)
}

type Method = 'get' | 'head' | 'post' | 'put' | 'patch' | 'delete' | 'options'

class ExpressHttpAdapter implements ExpressAdapter {
  readonly name = 'express' as const
  readonly app: Express
  readonly router: Router
  #fallback: FallbackHandler | undefined
  #mounted = false
  #server: Server | undefined
  #tracker: ConnectionTracker | undefined
  #closing: Promise<void> | undefined

  readonly #givenServer: Server | undefined

  constructor(options: ExpressAdapterOptions) {
    this.#givenServer = options.server
    if (options.app === undefined) {
      this.app = express()
      this.app.disable('x-powered-by')
    } else {
      this.app = options.app
    }
    this.router = express.Router({ caseSensitive: true, strict: true })
  }

  get server(): Server | undefined {
    return this.#server
  }

  registerRoute(route: AdapterRoute): void {
    const handler = route.handler
    // anchored regular expressions without capture groups: Express decodes nothing, Znight extracts parameters
    this.router[route.method.toLowerCase() as Method](new RegExp(toRegExpSource(route.path)), (request, response) => {
      handler(adapterRequest(request, response)).then(
        reply => writeNodeReply(response, reply),
        () => writeNodeFailure(response),
      )
    })
  }

  setFallbackHandler(handler: FallbackHandler): void {
    this.#fallback = handler
  }

  #mount(): void {
    if (this.#mounted) return
    this.#mounted = true
    // Express answers unmatched OPTIONS requests itself (200): route them to the Znight fallback
    this.router.options(/^.*$/, (request: Request, response: Response) =>
      this.#dispatchFallback(request, response, undefined),
    )
    this.app.use(this.router)
    this.app.use((request: Request, response: Response) => this.#dispatchFallback(request, response, undefined))
    this.app.use((error: unknown, request: Request, response: Response, _next: NextFunction) =>
      this.#dispatchFallback(request, response, error),
    )
  }

  #dispatchFallback(request: Request, response: Response, error: unknown): void {
    if (this.#fallback === undefined) {
      writeNodeFailure(response)
      return
    }
    this.#fallback(adapterRequest(request, response), error).then(
      reply => writeNodeReply(response, reply),
      () => writeNodeFailure(response),
    )
  }

  readonly #listener = (request: IncomingMessage, response: ServerResponse): void => {
    // the listening server's connections (an injected request is ignored)
    this.#tracker?.track(request, response)
    this.app(request as Request, response as Response)
  }

  async listen(port: number, host: string): Promise<HttpServerAddress> {
    this.#mount()
    const server = this.#givenServer ?? createServer()
    if (!server.listeners('request').includes(this.#listener)) server.on('request', this.#listener)
    this.#server = server
    // `#listener` counts the requests
    this.#tracker ??= new ConnectionTracker(server, { requests: false })
    this.#closing = undefined
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
    const server = this.#server
    const tracker = this.#tracker
    if (server === undefined || tracker === undefined) return Promise.resolve()
    this.#closing = closeServer(server, tracker, this.#closing, options.force === true)
    return this.#closing
  }

  inject(request: InjectRequest): Promise<InjectResponse> {
    return bufferInjectStream(stream => this.injectStream(stream), request)
  }

  injectStream(request: InjectStreamRequest): Promise<InjectStreamResponse> {
    this.#mount()
    return injectNodeStream('express', this.#injectListener as (req: never, res: never) => void, request)
  }

  /**
   * Express replaces the prototype of `req`/`res` with its own, which drops the overrides of the
   * light-my-request fakes (payload capture, body streaming): pin them as own properties first.
   */
  readonly #injectListener = (request: IncomingMessage, response: ServerResponse): void => {
    pinPrototype(request)
    pinPrototype(response)
    this.#listener(request, response)
  }
}

function pinPrototype(target: object): void {
  const prototype: unknown = Object.getPrototypeOf(target)
  if (prototype === null || typeof prototype !== 'object') return
  for (const key of Object.getOwnPropertyNames(prototype)) {
    if (key === 'constructor' || Object.hasOwn(target, key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
    if (typeof descriptor?.value === 'function') {
      Object.defineProperty(target, key, { value: descriptor.value, writable: true, configurable: true })
    }
  }
}

function adapterRequest(request: Request, response: Response): ReturnType<typeof nodeAdapterRequest> {
  return nodeAdapterRequest(request, response, { url: request.originalUrl ?? request.url, ip: request.ip })
}
