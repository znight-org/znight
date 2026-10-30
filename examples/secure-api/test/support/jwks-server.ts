import type { JSONWebKeySet } from 'jose'

import { createServer } from 'node:http'

/** A stand-in for the identity provider: serves the key set over real HTTP. */
export interface JwksServer {
  /** `http://127.0.0.1:<port>` */
  readonly url: string
  /** The key set, `200`. */
  readonly jwksUrl: string
  /** A failing identity provider: `500`. */
  readonly brokenUrl: string
  /** Requests received for a path (query string included). */
  hits(path: string): number
  close(): Promise<void>
}

/**
 * Starts the server on a free port of the loopback interface. `?<anything>` after `/jwks.json` gives
 * an application its own counter: `createRemoteJWKSet` caches the key set per application.
 */
export async function startJwksServer(jwks: JSONWebKeySet): Promise<JwksServer> {
  const hits = new Map<string, number>()
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    hits.set(url, (hits.get(url) ?? 0) + 1)
    if (new URL(url, 'http://localhost').pathname === '/jwks.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(jwks))
    } else {
      response.writeHead(500, { 'content-type': 'text/plain' }).end('identity provider down')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  server.unref() // never keeps the test process alive
  const { port } = server.address() as { port: number }
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    jwksUrl: `${url}/jwks.json`,
    brokenUrl: `${url}/broken.json`,
    hits: path => hits.get(path) ?? 0,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close(error => (error ? reject(error) : resolve()))
      }),
  }
}
