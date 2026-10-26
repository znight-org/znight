import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MetricsRegistry } from './registry.ts'

import { createServer } from 'node:http'

import { errorMessage, invalidOption } from '../internal/errors.ts'

/** Default port of the metrics server (the OpenTelemetry Prometheus exporter's). */
export const DEFAULT_METRICS_PORT = 9464

/** Options of {@link MetricsServer}. */
export interface MetricsServerOptions {
  /** Port (`0` picks a free one). Default: 9464. */
  readonly port?: number
  /** Interface to bind. Default: every interface. */
  readonly host?: string
  /** Path serving the metrics. Default: `/metrics`. */
  readonly path?: string
}

/**
 * Dedicated HTTP server exposing a {@link MetricsRegistry} for Prometheus scraping, separate from
 * the application's HTTP server (no auth, middleware or routing interference, not exposed through
 * the public load balancer). Uses `node:http`: works on Node.js and Bun.
 */
export class MetricsServer {
  readonly #registry: MetricsRegistry
  readonly #port: number
  readonly #host: string | undefined
  readonly #path: string
  #server: Server | undefined
  #closing: Promise<void> | undefined

  constructor(registry: MetricsRegistry, options: MetricsServerOptions = {}) {
    const port = options.port ?? DEFAULT_METRICS_PORT
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw invalidOption('metrics server port', `expected an integer between 0 and 65535, got ${port}`)
    }
    const path = options.path ?? '/metrics'
    if (!path.startsWith('/'))
      throw invalidOption('metrics server path', `expected a path starting with "/", got "${path}"`)
    this.#registry = registry
    this.#port = port
    this.#host = options.host
    this.#path = path
  }

  /** Whether the server is listening. */
  get listening(): boolean {
    return this.#server?.listening === true
  }

  /** Port the server is bound to (the actual one when configured with `0`), once listening. */
  get port(): number | undefined {
    const address = this.#server?.address()
    return typeof address === 'object' && address !== null ? (address as AddressInfo).port : undefined
  }

  /** Path serving the metrics. */
  get path(): string {
    return this.#path
  }

  /** URL of the metrics endpoint, once listening. */
  get url(): string | undefined {
    const port = this.port
    if (port === undefined) return undefined
    const host = this.#host === undefined || this.#host === '0.0.0.0' || this.#host === '::' ? 'localhost' : this.#host
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}${this.#path}`
  }

  /** Starts listening. Idempotent. */
  async listen(): Promise<void> {
    if (this.#server !== undefined) return
    await this.#closing
    const server = createServer((request, response) => this.#handle(request, response))
    this.#server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.#port, this.#host, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.#server = undefined
      const where = `${this.#host ?? '*'}:${this.#port}`
      const code = (error as { code?: unknown } | null)?.code
      const detail = typeof code === 'string' && !errorMessage(error).includes(code) ? ` (${code})` : ''
      throw new Error(`Cannot start the metrics server on ${where}: ${errorMessage(error)}${detail}`, { cause: error })
    }
    server.unref()
  }

  /** Stops listening and closes open connections. Idempotent. */
  close(): Promise<void> {
    const server = this.#server
    if (server === undefined) return this.#closing ?? Promise.resolve()
    this.#server = undefined
    this.#closing = new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
    }).finally(() => {
      this.#closing = undefined
    })
    return this.#closing
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const url = request.url ?? '/'
    const query = url.indexOf('?')
    const path = query === -1 ? url : url.slice(0, query)
    if (path !== this.#path) {
      reply(response, 404, 'Not Found\n')
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD')
      reply(response, 405, 'Method Not Allowed\n')
      return
    }
    this.#registry.metrics().then(
      body => {
        response.writeHead(200, {
          'content-type': this.#registry.contentType,
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        })
        response.end(request.method === 'HEAD' ? undefined : body)
      },
      (error: unknown) => reply(response, 500, `Failed to collect metrics: ${errorMessage(error)}\n`),
    )
  }
}

function reply(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}
