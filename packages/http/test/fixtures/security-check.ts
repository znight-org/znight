/**
 * Security check executed by `test/security-runtime.test.ts` with Node.js
 * (`node --conditions=@znight/source`) and Bun: boots the security sample application (CORS,
 * security headers, trusted proxies, plugin routes) on every adapter, sends the same requests over
 * the network and in memory, and prints the observed responses as JSON.
 */
import type { InjectRequest, InjectResponse } from '../../src/index.ts'

import { Application, silentLogger } from '@znight/core'

import { expressAdapter } from '../../src/adapters/express.ts'
import { fastifyAdapter } from '../../src/adapters/fastify.ts'
import { honoAdapter } from '../../src/adapters/hono.ts'
import { nodeAdapter } from '../../src/adapters/node.ts'
import { HttpPlugin } from '../../src/index.ts'
import { viaFetch } from '../helpers.ts'
import { StatusPlugin, securityMetadata, securityOptions } from '../security-app.ts'

const APP = 'https://app.example.com'

const REQUESTS: readonly InjectRequest[] = [
  {
    method: 'OPTIONS',
    url: '/api/site',
    headers: { origin: APP, 'access-control-request-method': 'POST', 'access-control-request-headers': 'X-Api-Key' },
  },
  { method: 'OPTIONS', url: '/api/site/any', headers: { origin: APP, 'access-control-request-method': 'PUT' } },
  {
    method: 'OPTIONS',
    url: '/api/site',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
  },
  { method: 'OPTIONS', url: '/api/none', headers: { origin: APP, 'access-control-request-method': 'GET' } },
  { method: 'GET', url: '/api/site', headers: { origin: APP } },
  { method: 'GET', url: '/api/site/secret', headers: { origin: APP } },
  { method: 'GET', url: '/api/site/boom' },
  { method: 'DELETE', url: '/api/site' },
  { method: 'GET', url: '/api/site/headers', headers: { origin: APP } },
  {
    method: 'GET',
    url: '/api/site/client',
    headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' },
  },
  { method: 'GET', url: '/api/site/client' },
  { method: 'GET', url: '/api/status', headers: { origin: APP } },
  { method: 'POST', url: '/api/status/reset', headers: { 'x-api-key': 'secret' }, body: { all: true } },
]

/** Headers compared across adapters and runtimes. */
const HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'allow',
  'vary',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'www-authenticate',
]

interface Observed {
  readonly status: number
  readonly body: string
  readonly headers: Record<string, string>
}

function observe(response: InjectResponse): Observed {
  const headers: Record<string, string> = {}
  for (const name of HEADERS) {
    const value = response.headers[name]
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return { status: response.status, body: response.body, headers }
}

const ADAPTERS = { node: nodeAdapter, fastify: fastifyAdapter, express: expressAdapter, hono: honoAdapter }

const results: Record<string, { network: Observed[]; inject: Observed[] }> = {}
for (const [name, create] of Object.entries(ADAPTERS)) {
  const http = HttpPlugin.configure({ ...securityOptions(), adapter: create(), port: 0, host: '127.0.0.1' })
  const app = await Application.create({
    metadata: securityMetadata(),
    plugins: [http, new StatusPlugin()],
    logger: silentLogger,
    shutdown: { signals: false },
  })
  await app.start()
  const send = viaFetch(http)
  const network: Observed[] = []
  const inject: Observed[] = []
  for (const request of REQUESTS) {
    network.push(observe(await send(request)))
    inject.push(observe(await http.inject(request)))
  }
  await app.stop()
  results[name] = { network, inject }
}

process.stdout.write(JSON.stringify(results))
