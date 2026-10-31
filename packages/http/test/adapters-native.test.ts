/** Integration with existing framework instances (middleware, native routes) and custom servers. */
import { createServer } from 'node:http'
import express from 'express'
import Fastify from 'fastify'
import { Hono } from 'hono'

import { expressAdapter } from '../src/adapters/express.ts'
import { fastifyAdapter } from '../src/adapters/fastify.ts'
import { honoAdapter } from '../src/adapters/hono.ts'
import { nodeAdapter } from '../src/adapters/node.ts'
import { coerce, type HttpContext } from '../src/index.ts'
import { ADAPTERS, controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class ItemsController {
  get(id: number) {
    return { id }
  }
  echo(body: unknown) {
    return { body }
  }
}

function itemsMetadata() {
  return metadata({ [t('ItemsController')]: provider(ItemsController) }, [
    controller(t('ItemsController'), '/items', [
      route('get', '/:id', (c: ItemsController, ctx) => c.get(coerce.number(ctx.params['id'], 'param "id"'))),
      route('echo', '/echo', (c: ItemsController, ctx) => c.echo(ctx.body), {
        method: 'POST',
        params: [{ index: 0, source: 'body' }],
      }),
    ]),
  ])
}

describe('fastifyAdapter({ instance })', () => {
  it('registers Znight routes in an encapsulated context next to native routes', async () => {
    const instance = Fastify()
    instance.get('/native', () => ({ native: true }))
    instance.post('/native-json', request => ({ received: request.body }))
    const adapter = fastifyAdapter({ instance })
    expect(adapter.instance).toBe(instance)
    const app = await createApp(itemsMetadata(), { adapter }, { start: false })
    const send = app.http.inject.bind(app.http)
    expect((await send({ method: 'GET', url: '/items/1' })).json()).toEqual({ id: 1 })
    expect((await send({ method: 'POST', url: '/items/echo', body: 'text' })).json()).toEqual({ body: 'text' })
    expect((await send({ method: 'GET', url: '/native' })).json()).toEqual({ native: true })
    expect((await send({ method: 'POST', url: '/native-json', body: { a: 1 } })).json()).toEqual({ received: { a: 1 } })
    expect((await send({ method: 'GET', url: '/nope' })).json()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Cannot GET /nope',
    })
    await app.stop()
  })

  it('forwards server options', async () => {
    const adapter = fastifyAdapter({ options: { requestIdHeader: 'x-fastify-id' } })
    expect(adapter.instance.initialConfig.requestIdHeader).toBe('x-fastify-id')
    expect((adapter.instance.initialConfig as { exposeHeadRoutes?: boolean }).exposeHeadRoutes).toBe(false)
    await adapter.close()
  })
})

describe('expressAdapter({ app })', () => {
  it('runs the application middleware before Znight routes', async () => {
    const native = express()
    native.use((_req, res, next) => {
      res.setHeader('x-middleware', '1')
      next()
    })
    native.get('/native', (_req, res) => {
      res.json({ native: true })
    })
    const adapter = expressAdapter({ app: native })
    expect(adapter.app).toBe(native)
    const app = await createApp(itemsMetadata(), { adapter })
    const response = await fetch(`${String(app.http.address)}/items/3`)
    expect(response.headers.get('x-middleware')).toBe('1')
    expect(await response.json()).toEqual({ id: 3 })
    expect(await (await fetch(`${String(app.http.address)}/native`)).json()).toEqual({ native: true })
    const injected = await app.http.inject({ method: 'GET', url: '/items/4' })
    expect(injected.headers['x-middleware']).toBe('1')
    expect(adapter.server).toBeDefined()
    await app.stop()
  })
})

describe('expressAdapter({ server })', () => {
  it('listens with the given server', async () => {
    const server = createServer()
    const adapter = expressAdapter({ server })
    const app = await createApp(itemsMetadata(), { adapter })
    expect(adapter.server).toBe(server)
    expect(await (await fetch(`${String(app.http.address)}/items/9`)).json()).toEqual({ id: 9 })
    await app.stop()
    expect(server.listening).toBe(false)
  })
})

describe('honoAdapter({ app })', () => {
  it('runs the application middleware around Znight routes', async () => {
    const native = new Hono()
    native.use('*', async (c, next) => {
      await next()
      c.res.headers.set('x-middleware', '1')
    })
    native.get('/native', c => c.json({ native: true }))
    const adapter = honoAdapter({ app: native })
    expect(adapter.app).toBe(native)
    const app = await createApp(itemsMetadata(), { adapter }, { start: false })
    const response = await app.http.inject({ method: 'GET', url: '/items/5' })
    expect(response.headers['x-middleware']).toBe('1')
    expect(response.json()).toEqual({ id: 5 })
    expect((await app.http.inject({ method: 'GET', url: '/native' })).json()).toEqual({ native: true })
    const fetched = await adapter.fetch(new Request('http://localhost/items/6'))
    expect(await fetched.json()).toEqual({ id: 6 })
    await app.stop()
  })

  class ReadsController {
    get(ctx: HttpContext) {
      return { get: ctx.params }
    }
    head(ctx: HttpContext) {
      ctx.setHeader('x-head', 'explicit')
      return undefined
    }
    rest(ctx: HttpContext) {
      return { rest: ctx.params['*'] }
    }
    other(ctx: HttpContext) {
      return { other: { ...ctx.params } }
    }
  }

  function readsMetadata() {
    const context = { params: [{ index: 0, source: 'context' as const }] }
    return metadata({ [t('ReadsController')]: provider(ReadsController) }, [
      controller(t('ReadsController'), '/', [
        // a HEAD route without GET route
        route('head', '/head-only', (c: ReadsController, ctx) => c.head(ctx), { method: 'HEAD', ...context }),
        // the HEAD and GET routes of one shape, with other parameter names (two Hono paths)
        route('head', '/named/:a', (c: ReadsController, ctx) => c.head(ctx), { method: 'HEAD', ...context }),
        route('get', '/named/:b', (c: ReadsController, ctx) => c.get(ctx), context),
        // a GET route less specific than /named/:b, without HEAD route of its own shape before it
        route('other', '/:section/:key', (c: ReadsController, ctx) => c.other(ctx), context),
        // a static path, a parameter and a wildcard matching the same requests
        route('get', '/files/readme', (c: ReadsController, ctx) => c.get(ctx), context),
        route('get', '/files/:name', (c: ReadsController, ctx) => c.get(ctx), context),
        route('rest', '/files/*', (c: ReadsController, ctx) => c.rest(ctx), context),
      ]),
    ])
  }

  for (const middleware of [false, true]) {
    it(`serves the GET and HEAD routes of a path from one Hono route (${middleware ? 'with' : 'without'} middleware)`, async () => {
      const native = new Hono()
      if (middleware) native.use('*', (_c, next) => next())
      const adapter = honoAdapter({ app: native })
      const app = await createApp(readsMetadata(), { adapter }, { start: false })
      const send = (method: string, url: string) => app.http.inject({ method, url })
      const headOnly = await send('GET', '/head-only')
      expect(headOnly.status).toBe(405)
      expect(headOnly.headers['allow']).toBe('HEAD, OPTIONS')
      expect((await send('HEAD', '/head-only')).headers['x-head']).toBe('explicit')
      expect((await send('GET', '/named/1')).json()).toEqual({ get: { b: '1' } })
      expect((await send('GET', '/other/1')).json()).toEqual({ other: { section: 'other', key: '1' } })
      const head = await send('HEAD', '/named/1')
      expect(head.headers['x-head']).toBe('explicit')
      expect(head.body).toBe('')
      expect((await send('GET', '/files/readme')).json()).toEqual({ get: {} })
      expect((await send('GET', '/files/a')).json()).toEqual({ get: { name: 'a' } })
      expect((await send('GET', '/files/a/b')).json()).toEqual({ rest: 'a/b' })
      const files = await send('HEAD', '/files/a/b')
      expect(files.status).toBe(200)
      expect(files.headers['content-length']).toBe(String('{"rest":"a/b"}'.length))
      expect(files.body).toBe('')
      // one Hono route per path shape for GET and HEAD
      const routes = native.routes.filter(entry => entry.method === 'GET').map(entry => entry.path)
      expect(routes.filter(path => path === '/named/:a' || path === '/named/:b')).toEqual(['/named/:a'])
      expect(new Set(routes).size).toBe(routes.length)
      await app.stop()
    })
  }
})

describe('nodeAdapter', () => {
  it('exposes a request listener to mount in your own server', async () => {
    const adapter = nodeAdapter()
    const app = await createApp(itemsMetadata(), { adapter }, { start: false })
    const server = createServer(adapter.handler)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    expect(await (await fetch(`http://127.0.0.1:${port}/items/7`)).json()).toEqual({ id: 7 })
    await new Promise(resolve => server.close(resolve))
    expect(adapter.server).toBeUndefined()
    await app.stop()
  })

  it('listens on a server given in the options', async () => {
    const server = createServer()
    const adapter = nodeAdapter({ server })
    expect(adapter.server).toBe(server)
    const app = await createApp(itemsMetadata(), { adapter })
    expect(server.listening).toBe(true)
    expect(await (await fetch(`${String(app.http.address)}/items/8`)).json()).toEqual({ id: 8 })
    await app.stop()
    expect(server.listening).toBe(false)
  })

  it('rejects duplicate registrations', () => {
    const adapter = nodeAdapter()
    const path = {
      path: '/a',
      segments: [{ kind: 'static' as const, value: 'a' }],
      params: [],
      wildcard: false,
      shape: '/a',
    }
    const handler = () => Promise.reject(new Error('unused'))
    adapter.registerRoute({ method: 'GET', path, handler })
    expect(() => adapter.registerRoute({ method: 'GET', path, handler })).toThrow('Duplicate route GET /a')
  })
})

describe('streamed request bodies', () => {
  for (const { name, create } of ADAPTERS) {
    it(`enforces bodyLimit while reading chunked bodies (${name})`, async () => {
      const app = await createApp(itemsMetadata(), { adapter: create(), bodyLimit: 1024 })
      const chunk = new TextEncoder().encode('x'.repeat(512))
      const body = (chunks: number) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < chunks; index++) controller.enqueue(chunk)
            controller.close()
          },
        })
      const send = (chunks: number) =>
        fetch(`${String(app.http.address)}/items/echo`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: body(chunks),
          duplex: 'half',
        } as RequestInit)
      const small = await send(2)
      expect(small.status).toBe(201)
      expect(((await small.json()) as { body: string }).body).toHaveLength(1024)
      const large = await send(4)
      expect(large.status).toBe(413)
      expect(await large.json()).toEqual({
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'Request body exceeds the limit of 1024 bytes',
      })
      await app.stop()
    })
  }
})
