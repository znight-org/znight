/**
 * `@znight/http/node`: the built-in, zero-dependency adapter on `node:http` (default adapter of
 * `HttpPlugin`). Works on Node.js and Bun. `inject()` uses the optional peer `light-my-request`.
 */
import type {
  AdapterCloseOptions,
  AdapterHandler,
  AdapterRoute,
  FallbackHandler,
  HttpAdapter,
  HttpServerAddress,
  InjectRequest,
  InjectResponse,
} from '../adapter.ts'

import { createServer, type IncomingMessage, type Server, type ServerOptions, type ServerResponse } from 'node:http'

import { RouteTable } from '../router.ts'
import { ConnectionTracker, closeServer, nodeAdapterRequest, writeNodeFailure, writeNodeReply } from './node-io.ts'
import { injectNode, serverAddress } from './shared.ts'

/** Options of {@link nodeAdapter}. */
export interface NodeAdapterOptions {
  /** Options of `http.createServer()` (timeouts, `maxHeaderSize`...). Ignored with {@link server}. */
  readonly serverOptions?: ServerOptions
  /**
   * An existing server (e.g. `https.createServer({ key, cert })`). The adapter adds its `request`
   * listener on `listen()` and closes the server on shutdown.
   */
  readonly server?: Server
}

/** The built-in Node.js adapter. */
export interface NodeAdapter extends HttpAdapter {
  readonly name: 'node'
  /** Request listener serving the routes, to mount the application in a server you manage. */
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void
  /** The server, once listening (or the one given in the options). */
  readonly server: Server | undefined
}

/**
 * Creates the built-in `node:http` adapter: a segment-trie router (static > `:param` > `*`, with
 * backtracking), zero dependencies.
 *
 * ```ts
 * HttpPlugin.configure({ adapter: nodeAdapter({ serverOptions: { requestTimeout: 30_000 } }) })
 * ```
 */
export function nodeAdapter(options: NodeAdapterOptions = {}): NodeAdapter {
  return new NodeHttpAdapter(options)
}

class NodeHttpAdapter implements NodeAdapter {
  readonly name = 'node' as const
  readonly #routes = new RouteTable<AdapterHandler>()
  readonly #options: NodeAdapterOptions
  #fallback: FallbackHandler | undefined
  #server: Server | undefined
  #tracker: ConnectionTracker | undefined
  #closing: Promise<void> | undefined

  constructor(options: NodeAdapterOptions) {
    this.#options = options
    this.#server = options.server
  }

  get server(): Server | undefined {
    return this.#server
  }

  registerRoute(route: AdapterRoute): void {
    if (this.#routes.add(route.method, route.path, route.handler) !== undefined) {
      throw new Error(`Duplicate route ${route.method} ${route.path.path}`)
    }
  }

  setFallbackHandler(handler: FallbackHandler): void {
    this.#fallback = handler
  }

  readonly handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = request.url ?? '/'
    const query = url.indexOf('?')
    const handler = this.#routes.find(request.method ?? 'GET', query === -1 ? url : url.slice(0, query))
    const adapterRequest = nodeAdapterRequest(request, response)
    let reply: ReturnType<AdapterHandler>
    if (handler !== undefined) reply = handler(adapterRequest)
    else if (this.#fallback === undefined) {
      writeNodeFailure(response)
      return
    } else reply = this.#fallback(adapterRequest)
    reply.then(
      result => writeNodeReply(response, result),
      () => writeNodeFailure(response),
    )
  }

  async listen(port: number, host: string): Promise<HttpServerAddress> {
    const server = this.#server ?? createServer(this.#options.serverOptions ?? {})
    this.#server = server
    this.#tracker ??= new ConnectionTracker(server)
    this.#closing = undefined
    if (!server.listeners('request').includes(this.handler)) server.on('request', this.handler)
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
    return injectNode('node', this.handler as (req: never, res: never) => void, request)
  }
}
