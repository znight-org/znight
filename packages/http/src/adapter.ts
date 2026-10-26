/**
 * Contract between the HTTP plugin and the server adapters (`@znight/http/node`, `/fastify`,
 * `/express`, `/hono`). Adapters only route requests to handlers (with their native router) and
 * translate I/O; everything else (parameters, query and body parsing, guards, serialisation, errors)
 * is done by the plugin so that every adapter behaves the same.
 */
import type { HeaderValue } from './exceptions.ts'
import type { HttpMethod } from './metadata.ts'
import type { RoutePath } from './path.ts'

/** A request, as seen by the plugin. */
export interface AdapterRequest {
  /** Upper-case method. */
  readonly method: string
  /** Raw request target: path and query string, percent-encoded (`/users/a%20b?page=2`). */
  readonly url: string
  /** Request headers with lower-case names (repeated headers joined with `, `). */
  readonly headers: Readonly<Record<string, string | undefined>>
  /** Remote address, when known. */
  readonly ip: string | undefined
  /** Native request object (`@Req()`). */
  readonly raw: unknown
  /** Native response object (`@Res()`). */
  readonly rawResponse: unknown
  /**
   * Reads the whole body (once). Rejects with a `PayloadTooLargeException` when it exceeds `limit`
   * bytes (checked on `content-length` first, then while reading).
   */
  readBody(limit: number): Promise<Uint8Array>
  /** Status written by a handler that took over the response with `@Res()`, when known. */
  rawStatus?(): number | undefined
}

/** Body of a reply: bytes, a stream, or nothing. */
export type ReplyBody = Uint8Array | ReadableStream<Uint8Array> | null

/** A response computed by the plugin, written by the adapter. */
export interface AdapterReply {
  readonly status: number
  /** Response headers, lower-case names. */
  readonly headers: Readonly<Record<string, HeaderValue>>
  /** `null` for HEAD requests and bodyless statuses (headers such as `content-length` are kept). */
  readonly body: ReplyBody
  /** The handler wrote the response itself through `@Res()`: write nothing. */
  readonly raw?: boolean
}

/** Handles one request. Never rejects: errors are already mapped to a reply. */
export type AdapterHandler = (request: AdapterRequest) => Promise<AdapterReply>

/**
 * Handles requests no route matched (`404`/`405`, automatic `OPTIONS`) and errors raised by the
 * server framework before a route handler ran (`error`, e.g. a malformed URL). Never rejects.
 */
export type FallbackHandler = (request: AdapterRequest, error?: unknown) => Promise<AdapterReply>

/** A concrete route to register (the plugin expands `ALL` and adds `HEAD` for `GET` routes). */
export interface AdapterRoute {
  readonly method: Exclude<HttpMethod, 'ALL'>
  /** Parsed full path (plugin prefix included). Translate it with the helpers of `@znight/http/path`. */
  readonly path: RoutePath
  readonly handler: AdapterHandler
}

/** Address of a listening server. Converts to its URL (`String(address)`). */
export interface HttpServerAddress {
  /** Host the server is bound to (`0.0.0.0`, `::`, `127.0.0.1`...). */
  readonly host: string
  readonly port: number
  /** `IPv4` or `IPv6`. */
  readonly family: string
  /** Base URL usable by clients (`http://127.0.0.1:3000`; wildcard hosts become loopback addresses). */
  readonly url: string
  toString(): string
}

/** A request for {@link HttpAdapter.inject} (in-memory, no network). */
export interface InjectRequest {
  readonly method: string
  /** Path and optional query string (`/users?page=2`). */
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Request body: a string or bytes are sent as is (`text/plain` / `application/octet-stream` when
   * no `content-type` is given), anything else is sent as JSON (`application/json`).
   */
  readonly body?: unknown
  /** Query parameters appended to `url`. */
  readonly query?: Readonly<Record<string, string | readonly string[]>>
}

/** The response of {@link HttpAdapter.inject}. */
export interface InjectResponse {
  readonly status: number
  /** Lower-case header names; repeated headers are joined with `, `. */
  readonly headers: Record<string, string>
  /** Body decoded as UTF-8. */
  readonly body: string
  /** `JSON.parse(body)`. */
  json<T = unknown>(): T
}

/** Options of {@link HttpAdapter.close}. */
export interface AdapterCloseOptions {
  /** Destroy open connections instead of waiting for in-flight requests. */
  readonly force?: boolean
}

/**
 * A server implementation. Create one with `nodeAdapter()` (default), `fastifyAdapter()`,
 * `expressAdapter()` or `honoAdapter()`. An adapter instance serves one plugin.
 */
export interface HttpAdapter {
  /** `node`, `fastify`, `express`, `hono`... (exposed as `ctx.adapter`). */
  readonly name: string
  /** Registers a route. Called during `onBootstrap`, before `listen`/`inject`. */
  registerRoute(route: AdapterRoute): void
  /** Sets the handler of unmatched requests and framework errors. Called once, before `listen`/`inject`. */
  setFallbackHandler(handler: FallbackHandler): void
  /** Starts listening. `port` 0 picks a free port. */
  listen(port: number, host: string): Promise<HttpServerAddress>
  /**
   * Stops accepting connections, closes idle ones and resolves once in-flight requests completed and
   * every connection is closed (`force`: destroys them). Idempotent; also releases what the adapter
   * created when it never listened.
   */
  close(options?: AdapterCloseOptions): Promise<void>
  /** Sends a request in memory (no socket), through the same routing and pipeline. */
  inject(request: InjectRequest): Promise<InjectResponse>
}
