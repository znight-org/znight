/**
 * Behaviour matrix: every adapter × (in-memory inject, real socket + fetch) must answer the same.
 */
import type { HttpRequestEvent } from '@znight/core'

import { ADAPTERS, createApp, type Send, type TestApp, TRANSPORTS } from './helpers.ts'
import { sampleMetadata, sampleOptions, scopeStats } from './sample-app.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} adapter`, () => {
    let app: TestApp
    const events: HttpRequestEvent[] = []

    beforeAll(async () => {
      app = await createApp(sampleMetadata(), { ...sampleOptions(), adapter: adapter.create() })
      app.app.hooks.wrap('http:request', async (event, next) => {
        event.responseHeaders['x-hooked'] = '1'
        await next()
      })
      app.app.hooks.on('http:request', event => {
        events.push(event)
      })
    })

    afterAll(async () => {
      await app.stop()
    })

    for (const transport of TRANSPORTS) {
      describe(`via ${transport.name}`, () => {
        let send: Send
        beforeAll(() => {
          send = transport.create(app.http)
        })

        describe('routing, params and query', () => {
          it('coerces route params', async () => {
            const res = await send({ method: 'GET', url: '/users/42' })
            expect(res.status).toBe(200)
            expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
            expect(res.json()).toEqual({ id: 42 })
          })

          it('answers 400 for a non-coercible param', async () => {
            const res = await send({ method: 'GET', url: '/users/abc' })
            expect(res.status).toBe(400)
            expect(res.json()).toEqual({
              statusCode: 400,
              error: 'Bad Request',
              message: 'Invalid param "id": expected a number, received "abc"',
            })
          })

          it('prefers static segments over params', async () => {
            expect((await send({ method: 'GET', url: '/users/me' })).body).toBe('me')
            expect((await send({ method: 'GET', url: '/misc/items/me/static' })).body).toBe('static me')
            expect((await send({ method: 'GET', url: '/misc/items/7/static' })).json()).toEqual({
              id: '7',
              slug: 'static',
            })
          })

          it('decodes params', async () => {
            const res = await send({ method: 'GET', url: '/misc/items/a%20b/c%2Fd' })
            expect(res.json()).toEqual({ id: 'a b', slug: 'c/d' })
          })

          it('answers 400 for malformed percent-encoding', async () => {
            const res = await send({ method: 'GET', url: '/misc/items/%E0%A4%A/x' })
            expect(res.status).toBe(400)
            expect(res.json<{ error: string }>().error).toBe('Bad Request')
          })

          it('coerces optional and array query values', async () => {
            expect((await send({ method: 'GET', url: '/users' })).json()).toEqual({ page: 1, tags: [] })
            expect((await send({ method: 'GET', url: '/users?page=3&tag=a&tag=b' })).json()).toEqual({
              page: 3,
              tags: ['a', 'b'],
            })
            expect((await send({ method: 'GET', url: '/users', query: { tag: 'solo' } })).json()).toEqual({
              page: 1,
              tags: ['solo'],
            })
            const bad = await send({ method: 'GET', url: '/users?page=1.5' })
            expect(bad.status).toBe(400)
            expect(bad.json<{ message: string }>().message).toBe(
              'Invalid query "page": expected an integer, received "1.5"',
            )
          })

          it('parses the whole query', async () => {
            const res = await send({ method: 'GET', url: '/misc/query?a=1&b=x+y&b=%C3%A9&c=' })
            expect(res.json()).toEqual({ a: '1', b: ['x y', 'é'], c: '' })
          })

          it('coerces headers', async () => {
            expect((await send({ method: 'GET', url: '/misc/header', headers: { 'X-Num': '12.5' } })).json()).toEqual({
              value: 12.5,
            })
            expect((await send({ method: 'GET', url: '/misc/header' })).json()).toEqual({ value: null })
            expect((await send({ method: 'GET', url: '/misc/header', headers: { 'x-num': 'nan' } })).status).toBe(400)
          })

          it('matches trailing wildcards', async () => {
            expect((await send({ method: 'GET', url: '/misc/files/a/b%20c.txt' })).json()).toEqual({
              rest: 'a/b c.txt',
            })
            expect((await send({ method: 'GET', url: '/misc/files/' })).json()).toEqual({ rest: '' })
            expect((await send({ method: 'GET', url: '/misc/files' })).status).toBe(404)
          })

          it('serves @All routes for methods without a dedicated route', async () => {
            expect((await send({ method: 'GET', url: '/misc/any' })).body).toBe('explicit get')
            expect((await send({ method: 'POST', url: '/misc/any' })).body).toBe('any POST')
            expect((await send({ method: 'DELETE', url: '/misc/any' })).body).toBe('any DELETE')
          })

          it('is strict about trailing slashes by default', async () => {
            expect((await send({ method: 'GET', url: '/users/42/' })).status).toBe(404)
          })

          it('is case-sensitive', async () => {
            expect((await send({ method: 'GET', url: '/USERS/42' })).status).toBe(404)
          })

          it('exposes the matched route and metadata on the context', async () => {
            const res = await send({ method: 'GET', url: '/misc/context?x=1' })
            expect(res.json()).toEqual({
              adapter: adapter.name,
              route: {
                method: 'GET',
                path: '/misc/context',
                controller: 'src/app.ts#MiscController',
                handler: 'context',
                meta: { feature: 'context' },
              },
              ip: 'string',
              method: 'GET',
              url: '/misc/context?x=1',
            })
          })
        })

        describe('404, 405 and OPTIONS', () => {
          it('answers 404 for unknown paths (through exception mappers)', async () => {
            const res = await send({ method: 'GET', url: '/nope' })
            expect(res.status).toBe(404)
            expect(res.json()).toEqual({ statusCode: 404, error: 'Not Found', message: 'No route for GET /nope' })
          })

          it('answers 405 with an allow header', async () => {
            const res = await send({ method: 'PATCH', url: '/users/1' })
            expect(res.status).toBe(405)
            expect(res.headers.allow).toBe('DELETE, GET, HEAD, PUT')
            expect(res.json<{ error: string }>().error).toBe('Method Not Allowed')
          })

          it('answers OPTIONS automatically', async () => {
            const res = await send({ method: 'OPTIONS', url: '/users/1' })
            expect(res.status).toBe(204)
            expect(res.headers.allow).toBe('DELETE, GET, HEAD, PUT, OPTIONS')
            expect(res.body).toBe('')
          })

          it('answers 404 for unknown paths with a body', async () => {
            const res = await send({ method: 'POST', url: '/nope', body: { a: 1 } })
            expect(res.status).toBe(404)
          })
        })

        describe('HEAD', () => {
          it('serves HEAD for GET routes without body', async () => {
            const get = await send({ method: 'GET', url: '/users/42' })
            const head = await send({ method: 'HEAD', url: '/users/42' })
            expect(head.status).toBe(200)
            expect(head.body).toBe('')
            expect(head.headers['content-type']).toBe('application/json; charset=utf-8')
            expect(head.headers['content-length']).toBe(get.headers['content-length'])
          })

          it('prefers an explicit HEAD route', async () => {
            const head = await send({ method: 'HEAD', url: '/misc/head' })
            expect(head.status).toBe(204)
            expect(head.headers['x-head']).toBe('explicit')
            expect((await send({ method: 'GET', url: '/misc/head' })).body).toBe('get body')
          })
        })

        describe('bodies', () => {
          it('validates JSON bodies with zod and injects the schema output', async () => {
            const res = await send({
              method: 'POST',
              url: '/users',
              body: { name: 'Ada', email: 'ada@example.com', extra: 1 },
            })
            expect(res.status).toBe(201)
            expect(res.json()).toEqual({ id: 1, name: 'Ada', email: 'ada@example.com', role: 'user' })
          })

          it('answers 400 with issue details for invalid bodies (zod)', async () => {
            const res = await send({ method: 'POST', url: '/users', body: { name: '', email: 'nope' } })
            expect(res.status).toBe(400)
            const json = res.json<{ message: string; details: { path: string; message: string }[] }>()
            expect(json.message).toBe('Invalid body')
            expect(json.details.map(detail => detail.path).sort()).toEqual(['email', 'name'])
          })

          it('validates bodies with valibot', async () => {
            const ok = await send({ method: 'PUT', url: '/users/5', body: { name: 'Bob', age: 3, ignored: true } })
            expect(ok.status).toBe(200)
            expect(ok.json()).toEqual({ id: 5, name: 'Bob', age: 3 })
            const bad = await send({ method: 'PUT', url: '/users/5', body: { name: 'Bob', age: 1.5 } })
            expect(bad.status).toBe(400)
            expect(bad.json<{ details: { path: string }[] }>().details[0]?.path).toBe('age')
          })

          it('supports async schemas', async () => {
            expect((await send({ method: 'POST', url: '/users/code', body: { code: 'ok' } })).json()).toEqual({
              code: 'ok',
            })
            const bad = await send({ method: 'POST', url: '/users/code', body: { code: 'ko' } })
            expect(bad.status).toBe(400)
            expect(bad.json<{ details: unknown }>().details).toEqual([{ path: 'code', message: 'bad code' }])
          })

          it('validates query objects and params with schemas', async () => {
            expect((await send({ method: 'GET', url: '/users/search?q=x' })).json()).toEqual({ q: 'x', limit: 10 })
            expect((await send({ method: 'GET', url: '/users/search?q=x&limit=500' })).status).toBe(400)
            expect((await send({ method: 'GET', url: '/users/12/typed' })).json()).toEqual({ id: 12, type: 'number' })
            const bad = await send({ method: 'GET', url: '/users/1.5/typed' })
            expect(bad.status).toBe(400)
            expect(bad.json<{ message: string }>().message).toBe('Invalid param "id"')
          })

          it('answers 400 for malformed JSON', async () => {
            const res = await send({
              method: 'POST',
              url: '/users',
              body: '{"name":',
              headers: { 'content-type': 'application/json' },
            })
            expect(res.status).toBe(400)
            expect(res.json<{ message: string }>().message).toStartWith('Invalid JSON body')
          })

          it('answers 413 above the body limit', async () => {
            const res = await send({ method: 'POST', url: '/body/echo', body: 'x'.repeat(2048) })
            expect(res.status).toBe(413)
            expect(res.json<{ error: string }>().error).toBe('Payload Too Large')
          })

          it('parses text, forms, bytes, multipart and empty bodies', async () => {
            expect((await send({ method: 'POST', url: '/body/echo', body: 'hello' })).json()).toEqual({
              kind: 'string',
              value: 'hello',
            })
            expect(
              (
                await send({
                  method: 'POST',
                  url: '/body/echo',
                  body: 'a=1&a=2&b=x+y',
                  headers: { 'content-type': 'application/x-www-form-urlencoded' },
                })
              ).json(),
            ).toEqual({ kind: 'object', value: { a: ['1', '2'], b: 'x y' } })
            expect(
              (await send({ method: 'POST', url: '/body/echo', body: new TextEncoder().encode('raw') })).json(),
            ).toEqual({
              kind: 'bytes',
              length: 3,
              text: 'raw',
            })
            expect((await send({ method: 'POST', url: '/body/echo' })).json()).toEqual({ kind: 'undefined' })
            const boundary = 'znightboundary'
            const multipart = [
              `--${boundary}`,
              'Content-Disposition: form-data; name="field"',
              '',
              'value',
              `--${boundary}`,
              'Content-Disposition: form-data; name="file"; filename="a.txt"',
              'Content-Type: text/plain',
              '',
              'file content',
              `--${boundary}--`,
              '',
            ].join('\r\n')
            expect(
              (
                await send({
                  method: 'POST',
                  url: '/body/echo',
                  body: multipart,
                  headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
                })
              ).json(),
            ).toEqual({
              kind: 'object',
              value: { field: 'value' },
              files: { file: [{ name: 'a.txt', type: 'text/plain', text: 'file content' }] },
            })
          })

          it('rejects compressed bodies with 415', async () => {
            const res = await send({
              method: 'POST',
              url: '/body/echo',
              body: 'xx',
              headers: { 'content-encoding': 'gzip' },
            })
            expect(res.status).toBe(415)
          })

          it('reads raw and lazily parsed bodies', async () => {
            expect((await send({ method: 'POST', url: '/body/raw', body: 'abcdef' })).json()).toEqual({ length: 6 })
            expect((await send({ method: 'POST', url: '/body/lazy', body: { a: 1 } })).json()).toEqual({
              before: 'undefined',
              parsed: { a: 1 },
              after: { a: 1 },
            })
          })
        })

        describe('status and serialisation', () => {
          it('applies the default statuses', async () => {
            expect((await send({ method: 'GET', url: '/status/value' })).status).toBe(200)
            const created = await send({ method: 'POST', url: '/status/created' })
            expect(created.status).toBe(201)
            expect(created.json()).toEqual({ ok: true })
            const empty = await send({ method: 'GET', url: '/status/empty' })
            expect(empty.status).toBe(204)
            expect(empty.body).toBe('')
            expect(empty.headers['content-type']).toBeUndefined()
            const postEmpty = await send({ method: 'POST', url: '/status/empty' })
            expect(postEmpty.status).toBe(201)
            expect(postEmpty.body).toBe('')
            expect((await send({ method: 'GET', url: '/status/empty-code' })).status).toBe(202)
          })

          it('applies @HttpCode over HttpResponse.status, and HttpResponse.status over defaults', async () => {
            const code = await send({ method: 'GET', url: '/status/http-code' })
            expect(code.status).toBe(202)
            expect(code.headers['x-static']).toBe('static')
            expect(code.headers['x-resp']).toBe('response')
            expect((await send({ method: 'GET', url: '/status/response' })).status).toBe(203)
          })

          it('serialises strings, bytes, streams, null and Web responses', async () => {
            const text = await send({ method: 'GET', url: '/status/text' })
            expect(text.headers['content-type']).toBe('text/plain; charset=utf-8')
            expect(text.body).toBe('hello')
            const bytes = await send({ method: 'GET', url: '/status/bytes' })
            expect(bytes.headers['content-type']).toBe('application/octet-stream')
            expect(bytes.headers['content-length']).toBe('2')
            expect(bytes.body).toBe('hi')
            const stream = await send({ method: 'GET', url: '/status/stream' })
            expect(stream.status).toBe(200)
            expect(stream.body).toBe('chunk1-chunk2')
            const nul = await send({ method: 'GET', url: '/status/null' })
            expect(nul.body).toBe('null')
            expect(nul.headers['content-type']).toBe('application/json; charset=utf-8')
            const web = await send({ method: 'GET', url: '/status/web' })
            expect(web.status).toBe(418)
            expect(web.body).toBe('teapot')
            expect(web.headers['content-type']).toBe('text/x-tea')
            expect(web.headers['x-web']).toBe('1')
            expect(web.headers['x-static']).toBeUndefined()
          })

          it('redirects', async () => {
            const res = await send({ method: 'GET', url: '/status/redirect' })
            expect(res.status).toBe(307)
            expect(res.headers.location).toBe('/status/value')
          })

          it('merges headers: @Header < ctx.setHeader < HttpResponse', async () => {
            const res = await send({ method: 'GET', url: '/status/headers' })
            expect(res.headers['x-static']).toBe('static')
            expect(res.headers['x-ctx']).toBe('ctx')
            expect(res.headers['x-resp']).toBe('resp')
            expect(res.headers['x-override']).toBe('resp')
          })

          it('sends repeated headers', async () => {
            const res = await send({ method: 'GET', url: '/status/cookies' })
            expect(res.headers['set-cookie']).toBe('a=1, b=2')
          })

          it('answers 500 when the result cannot be serialised', async () => {
            const res = await send({ method: 'GET', url: '/status/bigint' })
            expect(res.status).toBe(500)
            expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' })
          })

          it('lets handlers write the native response with @Res()', async () => {
            const res = await send({ method: 'GET', url: '/misc/raw' })
            expect(res.status).toBe(299)
            expect(res.body).toBe(`raw ${adapter.name}`)
            expect(res.headers['x-raw']).toBe(adapter.name)
          })
        })

        describe('guards', () => {
          it('runs global → controller → route guards with route metadata', async () => {
            const ok = await send({
              method: 'GET',
              url: '/guarded/roles',
              headers: { authorization: 'Bearer ok', 'x-role': 'admin' },
            })
            expect(ok.status).toBe(200)
            expect(ok.json()).toEqual([
              'auth',
              'controller',
              'roles',
              'global:before',
              'controller:before',
              'handler',
              'controller:after',
              'global:after',
            ])
          })

          it('answers 401 from a throwing guard, with its headers', async () => {
            const res = await send({ method: 'GET', url: '/guarded/roles', headers: { 'x-role': 'admin' } })
            expect(res.status).toBe(401)
            expect(res.headers['www-authenticate']).toBe('Bearer')
            expect(res.json()).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Missing token' })
          })

          it('answers 403 when a guard returns false and keeps headers set before', async () => {
            const res = await send({
              method: 'GET',
              url: '/guarded/roles',
              headers: { authorization: 'Bearer ok', 'x-role': 'guest' },
            })
            expect(res.status).toBe(403)
            expect(res.headers['x-guard']).toBe('roles')
            expect(res.json()).toEqual({ statusCode: 403, error: 'Forbidden', message: 'Forbidden resource' })
            const denied = await send({
              method: 'GET',
              url: '/guarded/open',
              headers: { 'x-deny': 'controller' },
            })
            expect(denied.status).toBe(403)
          })

          it('lets metadata decorators open routes', async () => {
            const res = await send({ method: 'GET', url: '/guarded/open' })
            expect(res.status).toBe(200)
            expect(res.json<string[]>().slice(0, 2)).toEqual(['auth:public', 'controller'])
          })
        })

        describe('interceptors', () => {
          it('runs global → controller → route interceptors, outermost first', async () => {
            const res = await send({ method: 'GET', url: '/guarded/interceptors' })
            expect(res.json()).toEqual([
              'auth:public',
              'controller',
              'global:before',
              'controller:before',
              'route:before',
              'handler',
              'route:after',
              'controller:after',
              'global:after',
            ])
          })

          it('transforms and short-circuits results', async () => {
            expect((await send({ method: 'GET', url: '/guarded/wrapped' })).json()).toEqual({ data: 'value' })
            expect(
              (await send({ method: 'GET', url: '/guarded/cached', headers: { 'x-cache': 'hit' } })).json(),
            ).toEqual({
              cached: true,
            })
            expect((await send({ method: 'GET', url: '/guarded/cached' })).body).toBe('value')
          })
        })

        describe('errors', () => {
          it('maps errors with exception mappers (class and instance)', async () => {
            const domain = await send({ method: 'GET', url: '/errors/domain' })
            expect(domain.status).toBe(409)
            expect(domain.json()).toEqual({ conflict: 'already exists' })
            const teapot = await send({ method: 'GET', url: '/errors/teapot' })
            expect(teapot.status).toBe(418)
            expect(teapot.json()).toEqual({ tea: true })
            const web = await send({ method: 'GET', url: '/errors/web' })
            expect(web.status).toBe(451)
            expect(web.body).toBe('mapped')
          })

          it('hides unexpected errors (sync and async) and logs them', async () => {
            for (const url of ['/errors/boom', '/errors/rejected']) {
              const res = await send({ method: 'GET', url })
              expect(res.status).toBe(500)
              expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' })
              expect(res.body).not.toContain('secret')
            }
            const logged = app.logger.entries.filter(
              entry => entry.level === 'error' && entry.message.includes('/errors/boom'),
            )
            expect(logged.length).toBeGreaterThan(0)
            expect((logged[0]?.context?.['err'] as Error | undefined)?.message).toBe('secret details')
          })

          it('falls back to the default rendering when a mapper throws', async () => {
            const res = await send({ method: 'GET', url: '/errors/broken' })
            expect(res.status).toBe(500)
            expect(app.logger.entries.some(entry => entry.message === 'An exception mapper failed')).toBe(true)
          })

          it('renders HttpException details and context headers', async () => {
            const res = await send({ method: 'GET', url: '/errors/http' })
            expect(res.status).toBe(404)
            expect(res.json()).toEqual({ statusCode: 404, error: 'Not Found', message: 'nope', details: { id: 1 } })
            const forbidden = await send({ method: 'GET', url: '/errors/forbidden' })
            expect(forbidden.status).toBe(403)
            expect(forbidden.headers['x-guard']).toBe('set-before-throw')
          })
        })

        describe('request scope, request id and hooks', () => {
          it('creates request-scoped controllers per request and injects HttpContext / RequestId', async () => {
            const before = { ...scopeStats }
            const first = (await send({ method: 'GET', url: '/scoped' })).json<{
              requestId: string
              ctxRequestId: string
              path: string
              instance: number
            }>()
            const second = (await send({ method: 'GET', url: '/scoped' })).json<{
              instance: number
              requestId: string
            }>()
            expect(first.requestId).toMatch(UUID)
            expect(first.ctxRequestId).toBe(first.requestId)
            expect(first.path).toBe('/scoped')
            expect(second.instance).toBe(first.instance + 1)
            expect(second.requestId).not.toBe(first.requestId)
            expect(scopeStats.states - before.states).toBe(2)
            expect(scopeStats.disposed - before.disposed).toBe(2)
          })

          it('resolves Lazy<HttpContext> from singletons in the current request', async () => {
            const res = await send({ method: 'GET', url: '/audit', headers: { 'x-request-id': 'audit-1' } })
            expect(res.json()).toEqual({ requestId: 'audit-1' })
          })

          it('reuses valid incoming request ids and echoes them', async () => {
            const res = await send({ method: 'GET', url: '/misc/request-id', headers: { 'x-request-id': 'abc-123' } })
            expect(res.json()).toEqual({ requestId: 'abc-123' })
            expect(res.headers['x-request-id']).toBe('abc-123')
            const invalid = await send({
              method: 'GET',
              url: '/misc/request-id',
              headers: { 'x-request-id': 'bad id!' },
            })
            expect(invalid.json<{ requestId: string }>().requestId).toMatch(UUID)
            const errorResponse = await send({ method: 'GET', url: '/nope', headers: { 'x-request-id': 'err-1' } })
            expect(errorResponse.headers['x-request-id']).toBe('err-1')
          })

          it('wraps requests with the http:request hook', async () => {
            const res = await send({
              method: 'POST',
              url: '/users/7?x=1',
              headers: { 'x-request-id': `hook-${transport.name}` },
            })
            expect(res.status).toBe(405)
            expect(res.headers['x-hooked']).toBe('1')
            const ok = await send({
              method: 'GET',
              url: '/users/7',
              headers: { 'x-request-id': `hook-ok-${transport.name}` },
            })
            expect(ok.headers['x-hooked']).toBe('1')
            const event = events.find(e => e.requestId === `hook-ok-${transport.name}`)
            expect(event).toMatchObject({ method: 'GET', path: '/users/7', route: '/users/:id', status: 200 })
            expect(event?.error).toBeUndefined()
            expect(typeof event?.startTime).toBe('number')
            expect((event?.context as { requestId: string } | undefined)?.requestId).toBe(`hook-ok-${transport.name}`)
            expect(event?.headers['x-request-id']).toBe(`hook-ok-${transport.name}`)
            const failed = events.find(e => e.requestId === `hook-${transport.name}`)
            expect(failed).toMatchObject({ method: 'POST', path: '/users/7', route: undefined, status: 405 })
            expect(failed?.error).toBeInstanceOf(Error)
          })

          it('records errors and statuses of failed requests in the event', async () => {
            await send({ method: 'GET', url: '/errors/boom', headers: { 'x-request-id': `boom-${transport.name}` } })
            const event = events.find(e => e.requestId === `boom-${transport.name}`)
            expect(event?.status).toBe(500)
            expect((event?.error as Error | undefined)?.message).toBe('secret details')
            expect(event?.route).toBe('/errors/boom')
          })
        })
      })
    }
  })
}
