/**
 * The docs routes behave the same on every adapter (node, Fastify, Express, Hono), in memory and
 * over a real socket (Hono listens with `Bun.serve()` on Bun).
 */
import type { ZnightMetadata } from '@znight/core'
import type { HttpAdapter, HttpPlugin } from '@znight/http'

import { silentLogger } from '@znight/core'
import { HttpPlugin as Http, nodeAdapter } from '@znight/http'
import { expressAdapter } from '@znight/http/express'
import { fastifyAdapter } from '@znight/http/fastify'
import { honoAdapter } from '@znight/http/hono'
import { TestApp } from '@znight/testing'

import { buildOpenApiDocument, OpenApiPlugin } from '../src/index.ts'
import { bookshelfMetadata, cleanupApps } from './support/apps.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const ADAPTERS: readonly { readonly name: string; readonly create: () => HttpAdapter }[] = [
  { name: 'node', create: () => nodeAdapter() },
  { name: 'fastify', create: () => fastifyAdapter() },
  { name: 'express', create: () => expressAdapter() },
  { name: 'hono', create: () => honoAdapter() },
]

let metadata: ZnightMetadata
let expected: string

beforeAll(async () => {
  metadata = await bookshelfMetadata()
  expected = (await buildOpenApiDocument(metadata, { prefix: '/api' })).json
})

afterAll(cleanupApps)

interface Reply {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly body: string
}

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} adapter`, () => {
    let app: TestApp
    let base: string

    beforeAll(async () => {
      app = await TestApp.create({
        metadata,
        plugins: [
          Http.configure({ adapter: adapter.create(), port: 0, host: '127.0.0.1', prefix: '/api' }),
          OpenApiPlugin.configure({ yaml: '/openapi.yaml' }),
        ],
        logger: silentLogger,
      })
      base = String(app.app.getPlugin<HttpPlugin>('http')?.address?.url).replace(/\/$/, '')
    })

    afterAll(async () => {
      await app?.close()
    })

    const transports: readonly {
      name: string
      send(method: string, url: string, headers?: Record<string, string>): Promise<Reply>
    }[] = [
      { name: 'inject', send: (method, url, headers = {}) => app.inject({ method, url, headers }) },
      {
        name: 'socket',
        send: async (method, url, headers = {}) => {
          const response = await fetch(`${base}${url}`, { method, headers })
          return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() }
        },
      },
    ]

    for (const transport of transports) {
      it(`serves the document, 304, HEAD, YAML and the UI (${transport.name})`, async () => {
        const json = await transport.send('GET', '/api/openapi.json')
        expect(json.status).toBe(200)
        expect(json.body).toBe(expected)
        expect(json.headers['content-type']).toBe('application/json; charset=utf-8')
        const etag = String(json.headers['etag'])
        expect((await transport.send('GET', '/api/openapi.json', { 'if-none-match': etag })).status).toBe(304)
        const head = await transport.send('HEAD', '/api/openapi.json')
        expect([head.status, head.body, head.headers['etag']]).toEqual([200, '', etag])
        const yaml = await transport.send('GET', '/api/openapi.yaml')
        expect([yaml.status, yaml.headers['content-type']]).toEqual([200, 'application/yaml'])
        const page = await transport.send('GET', '/api/docs')
        expect(page.status).toBe(200)
        expect(String(page.headers['content-security-policy'])).toContain(
          "script-src 'self' https://cdn.jsdelivr.net 'sha256-",
        )
        expect(page.body).toContain('"url":"/api/openapi.json"')
        expect((await transport.send('GET', '/api/docs/_assets/scalar@1.0.0/standalone.js')).status).toBe(404)
      })
    }
  })
}
