/**
 * `fastifyAdapter({ instance })` next to an instance that owns its 404 handler: in Fastify 5, an
 * encapsulated context without a prefix shares the root's 404 level, so only one of them can call
 * `setNotFoundHandler()` (the second one throws "Not found handler already set").
 */
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify'

import Fastify from 'fastify'

import { fastifyAdapter } from '../src/adapters/fastify.ts'
import { BadRequestException, coerce } from '../src/index.ts'
import { caught, controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class ItemsController {
  get(id: number) {
    return { id }
  }
  echo(body: unknown) {
    return { body }
  }
  fail(): never {
    throw new BadRequestException('Nope')
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
      route('fail', '/fail', (c: ItemsController) => c.fail()),
    ]),
  ])
}

/** The application's own 404 handler (a rate-limited one in a real application). */
function legacyNotFound(request: FastifyRequest, reply: FastifyReply): void {
  reply.code(404).header('x-legacy-404', '1').send({ legacy: true, url: request.url })
}

/** A plugin registered at the root level, like one wrapped with `fastify-plugin`. */
function rootPlugin(plugin: FastifyPluginCallback): FastifyPluginCallback {
  Object.defineProperty(plugin, Symbol.for('skip-override'), { value: true })
  return plugin
}

const notFoundPlugin = rootPlugin((app, _options, done) => {
  try {
    app.setNotFoundHandler(legacyNotFound)
  } catch (error) {
    done(error as Error)
    return
  }
  done()
})

/** An instance with a root hook, a native route and its own 404 handler, set in the given way. */
function legacyInstance(setup: (instance: FastifyInstance) => void): FastifyInstance {
  const instance = Fastify()
  instance.addHook('onRequest', (_request, reply, done) => {
    reply.header('x-root-hook', '1')
    done()
  })
  instance.get('/native', () => ({ native: true }))
  setup(instance)
  return instance
}

const ORIGIN = 'https://app.example.com'

describe('fastifyAdapter({ instance }) with an instance that owns its 404 handler', () => {
  for (const [name, setup] of [
    ['set with setNotFoundHandler()', (instance: FastifyInstance) => instance.setNotFoundHandler(legacyNotFound)],
    ['set by a root plugin', (instance: FastifyInstance) => instance.register(notFoundPlugin)],
  ] as const) {
    it(`answers unknown URLs with the instance handler (${name} before the application starts)`, async () => {
      const instance = legacyInstance(setup)
      const adapter = fastifyAdapter({ instance })
      const app = await createApp(itemsMetadata(), { adapter, cors: { origin: ORIGIN } }, { start: false })
      const send = app.http.inject.bind(app.http)

      const unknown = await send({ method: 'GET', url: '/nope?x=1' })
      expect(unknown.status).toBe(404)
      expect(unknown.headers['x-legacy-404']).toBe('1')
      expect(unknown.json()).toEqual({ legacy: true, url: '/nope?x=1' })
      expect((await send({ method: 'POST', url: '/legacy/v1/thing', body: { a: 1 } })).json()).toEqual({
        legacy: true,
        url: '/legacy/v1/thing',
      })

      // Znight routes, with the hooks of the instance
      const item = await send({ method: 'GET', url: '/items/7' })
      expect(item.json()).toEqual({ id: 7 })
      expect(item.headers['x-root-hook']).toBe('1')
      expect((await send({ method: 'HEAD', url: '/items/7' })).status).toBe(200)
      expect((await send({ method: 'POST', url: '/items/echo', body: 'text' })).json()).toEqual({ body: 'text' })
      expect((await send({ method: 'GET', url: '/native' })).json()).toEqual({ native: true })

      // Znight errors
      const invalid = await send({ method: 'GET', url: '/items/abc' })
      expect(invalid.status).toBe(400)
      expect(invalid.json<{ error: string }>().error).toBe('Bad Request')
      expect((await send({ method: 'GET', url: '/items/fail' })).json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Nope',
      })

      // the paths of Znight routes keep Znight's 405, automatic OPTIONS and CORS preflights
      const wrongMethod = await send({ method: 'DELETE', url: '/items/7' })
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers['allow']).toBe('GET, HEAD, OPTIONS')
      expect(wrongMethod.headers['x-legacy-404']).toBeUndefined()
      // `/items/echo` also matches `GET /items/:id`
      const options = await send({ method: 'OPTIONS', url: '/items/echo' })
      expect(options.status).toBe(204)
      expect(options.headers['allow']).toBe('GET, HEAD, POST, OPTIONS')
      const preflight = await send({
        method: 'OPTIONS',
        url: '/items/echo',
        headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN)
      const simple = await send({ method: 'GET', url: '/items/1', headers: { origin: ORIGIN } })
      expect(simple.headers['access-control-allow-origin']).toBe(ORIGIN)
      await app.stop()
    })
  }

  it("serves a handler registered after Znight's context with notFound: 'instance'", async () => {
    const instance = legacyInstance(() => undefined)
    const adapter = fastifyAdapter({ instance, notFound: 'instance' })
    const app = await createApp(itemsMetadata(), { adapter }, { start: false })
    // the first request registers Znight's context: the plugin below is queued after it
    const first = adapter.inject({ method: 'GET', url: '/items/1' })
    instance.register(notFoundPlugin)
    expect((await first).status).toBe(200)
    const send = app.http.inject.bind(app.http)
    expect((await send({ method: 'GET', url: '/nope' })).json()).toEqual({ legacy: true, url: '/nope' })
    expect((await send({ method: 'GET', url: '/items/2' })).json()).toEqual({ id: 2 })
    expect((await send({ method: 'PUT', url: '/items/2' })).status).toBe(405)
    await app.stop()
  })

  it('leaves the 404 level to Znight by default when no handler is set before its context loads', async () => {
    const instance = legacyInstance(() => undefined)
    const adapter = fastifyAdapter({ instance })
    const app = await createApp(itemsMetadata(), { adapter }, { start: false })
    const first = adapter.inject({ method: 'GET', url: '/items/1' })
    instance.register(notFoundPlugin)
    // Fastify refuses the second handler of the level: that order needs notFound: 'instance'
    expect(String(await caught(() => first))).toContain('Not found handler already set')
    await app.stop()
  })

  it("answers unknown URLs with Fastify's default 404 with notFound: 'instance' and no handler", async () => {
    const instance = legacyInstance(() => undefined)
    const adapter = fastifyAdapter({ instance, notFound: 'instance' })
    const app = await createApp(itemsMetadata(), { adapter }, { start: false })
    const send = app.http.inject.bind(app.http)
    expect((await send({ method: 'GET', url: '/nope' })).json()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Route GET:/nope not found',
    })
    expect((await send({ method: 'GET', url: '/items/3' })).json()).toEqual({ id: 3 })
    expect((await send({ method: 'PATCH', url: '/items/3' })).status).toBe(405)
    await app.stop()
  })

  it('leaves to the instance the methods it routes itself on the paths of Znight routes', async () => {
    const instance = legacyInstance(i => i.setNotFoundHandler(legacyNotFound))
    instance.delete('/items/:itemId', request => ({ deleted: (request.params as { itemId: string }).itemId }))
    const app = await createApp(itemsMetadata(), { adapter: fastifyAdapter({ instance }) }, { start: false })
    const send = app.http.inject.bind(app.http)
    expect((await send({ method: 'DELETE', url: '/items/4' })).json()).toEqual({ deleted: '4' })
    expect((await send({ method: 'GET', url: '/items/4' })).json()).toEqual({ id: 4 })
    expect((await send({ method: 'PUT', url: '/items/4' })).status).toBe(405)
    await app.stop()
  })

  it('validates the notFound option', () => {
    expect(() => fastifyAdapter({ notFound: 'root' as 'instance' })).toThrow(
      `fastifyAdapter: option "notFound" must be 'znight' or 'instance' (received root)`,
    )
  })

  it("refuses an instance that owns its 404 handler with notFound: 'znight'", async () => {
    const instance = legacyInstance(i => i.setNotFoundHandler(legacyNotFound))
    const adapter = fastifyAdapter({ instance, notFound: 'znight' })
    const app = await createApp(itemsMetadata(), { adapter }, { start: false })
    const error = await caught(() => app.http.inject({ method: 'GET', url: '/items/1' }))
    expect(String(error)).toContain('already has a not-found handler')
    expect(String(error)).toContain("notFound: 'instance'")
    await app.stop()
  })

  it('keeps answering unknown URLs with Znight when the instance has no 404 handler', async () => {
    const instance = legacyInstance(() => undefined)
    const adapter = fastifyAdapter({ instance })
    const app = await createApp(itemsMetadata(), { adapter }, { start: false })
    const send = app.http.inject.bind(app.http)
    const unknown = await send({ method: 'GET', url: '/nope' })
    expect(unknown.json()).toEqual({ statusCode: 404, error: 'Not Found', message: 'Cannot GET /nope' })
    expect(unknown.headers['x-root-hook']).toBe('1')
    expect((await send({ method: 'DELETE', url: '/items/7' })).status).toBe(405)
    await app.stop()
  })
})
