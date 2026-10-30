/**
 * Plugin options and boot checks of RFC 0006 (§4.5, §5.3, §7): `cookies` / `sse` options
 * (ZNIGHT005), hand-written `sse` metadata (ZNIGHT007), `signCookie()`, `injectStream()` on an
 * adapter without it, `signedCookies` without secrets, `streams`.
 */
import type { HttpAdapter, HttpPluginOptions } from '../src/index.ts'

import { ErrorCode } from '@znight/core'

import { nodeAdapter } from '../src/adapters/node.ts'
import { HttpResponse } from '../src/index.ts'
import { caught, controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class SimpleController {
  hello(): string {
    return 'hello'
  }
}

const meta = (extra: Partial<Parameters<typeof route>[3]> = {}) =>
  metadata({ [t('SimpleController')]: provider(SimpleController) }, [
    controller(t('SimpleController'), '/', [route('hello', '/', (c: SimpleController) => c.hello(), extra)]),
  ])

async function bootError(options: HttpPluginOptions, extra?: Partial<Parameters<typeof route>[3]>): Promise<Error> {
  return (await caught(() => createApp(meta(extra), options, { start: false }))) as Error
}

const SECRET = 's'.repeat(32)

describe('cookies option', () => {
  const invalid: readonly [string, HttpPluginOptions['cookies'], string][] = [
    ['not an object', 'x' as never, 'option "cookies" must be an object { secrets?, defaults? }'],
    ['an unknown key', { secret: SECRET } as never, 'unknown key \\"secret\\"'],
    ['a short secret', { secrets: 'short' }, 'option "cookies.secrets" must be secrets of at least 32 bytes'],
    ['an empty list', { secrets: [] }, 'option "cookies.secrets" must be at least one secret'],
    ['duplicates', { secrets: [SECRET, SECRET] }, 'distinct secrets'],
    ['a non-string secret', { secrets: [42] as never }, 'strings or Uint8Arrays'],
    ['defaults that are not an object', { defaults: 'x' as never }, 'option "cookies.defaults" must be an object'],
    ['an unknown default', { defaults: { maxAge: 1 } as never }, 'unknown key \\"maxAge\\"'],
    ['SameSite=None without Secure', { defaults: { sameSite: 'none', secure: false } }, 'valid cookie attributes'],
    ['an invalid default domain', { defaults: { domain: 'a b' } }, 'valid cookie attributes'],
  ]
  for (const [name, cookies, message] of invalid) {
    it(`rejects ${name} (ZNIGHT005)`, async () => {
      const error = await bootError({ cookies })
      expect(error).toMatchObject({ code: ErrorCode.InvalidDecorator })
      expect(error.message).toContain(message)
      expect(error.message).not.toContain('short"')
    })
  }

  it('applies the defaults to every cookie and signs with the first secret', async () => {
    const app = await createApp(meta(), {
      cookies: { secrets: [new Uint8Array(32).fill(1), SECRET], defaults: { secure: false, sameSite: 'strict' } },
    })
    const signed = app.http.signCookie('sid', 'a b')
    expect(signed).toMatch(/^a%20b\.[\w-]{43}$/)
    expect(() => app.http.signCookie('a b', 'x')).toThrow('Invalid cookie name')
    expect(() => app.http.signCookie('a', 1 as never)).toThrow('must be a string')
    await app.stop()
  })

  it('signCookie() and signedCookies need secrets', async () => {
    const app = await createApp(meta())
    expect(() => app.http.signCookie('sid', 'x')).toThrow('cookies.secrets is not set')
    await expect(app.http.inject({ method: 'GET', url: '/', signedCookies: { sid: 'x' } })).rejects.toThrow(
      'inject(): signedCookies require the HttpPlugin option cookies.secrets',
    )
    await expect(app.http.injectStream({ method: 'GET', url: '/', signedCookies: { sid: 'x' } })).rejects.toThrow(
      'injectStream(): signedCookies require',
    )
    await app.stop()
  })

  it('rejects invalid inject cookies', async () => {
    const app = await createApp(meta(), { cookies: { secrets: SECRET } })
    await expect(app.http.inject({ method: 'GET', url: '/', cookies: { 'a;b': 'x' } })).rejects.toThrow(
      'invalid cookie name',
    )
    await expect(app.http.inject({ method: 'GET', url: '/', cookies: { a: 1 as never } })).rejects.toThrow(
      'must be a string',
    )
    await expect(app.http.inject({ method: 'GET', url: '/', signedCookies: { 'a b': 'x' } })).rejects.toThrow(
      'invalid signed cookie name',
    )
    await app.stop()
  })
})

describe('sse option', () => {
  const invalid: readonly [string, HttpPluginOptions, string][] = [
    ['not an object', { sse: 1 as never }, 'option "sse" must be an object'],
    ['an unknown key', { sse: { ping: 1 } as never }, 'unknown key \\"ping\\"'],
    [
      'a short heartbeat',
      { sse: { heartbeat: 500 } },
      'option "sse.heartbeat" must be an integer number of ms from 1000 to 2147483647',
    ],
    // a longer delay overflows setTimeout to 1 ms: one heartbeat per millisecond
    ['a heartbeat above the timer limit', { sse: { heartbeat: 2 ** 31 } }, 'option "sse.heartbeat"'],
    [
      'a grace above the timer limit',
      { drainTimeoutMs: Number.POSITIVE_INFINITY, sse: { shutdownGraceMs: 2 ** 31 } },
      'option "sse.shutdownGraceMs" must be an integer number of ms from 0 to 2147483647',
    ],
    ['a negative retry', { sse: { retry: -1 } }, 'option "sse.retry"'],
    ['a fractional grace', { sse: { shutdownGraceMs: 1.5 } }, 'option "sse.shutdownGraceMs"'],
    [
      'a grace not below drainTimeoutMs',
      { drainTimeoutMs: 1_000, sse: { shutdownGraceMs: 1_000 } },
      'option "sse.shutdownGraceMs" must be lower than drainTimeoutMs (1000)',
    ],
  ]
  for (const [name, options, message] of invalid) {
    it(`rejects ${name} (ZNIGHT005)`, async () => {
      const error = await bootError(options)
      expect(error).toMatchObject({ code: ErrorCode.InvalidDecorator })
      expect(error.message).toContain(message)
    })
  }

  it('accepts heartbeat: false and any grace with an infinite drain', async () => {
    const app = await createApp(meta(), {
      drainTimeoutMs: Number.POSITIVE_INFINITY,
      sse: { heartbeat: false, retry: 0, shutdownGraceMs: 60_000 },
    })
    expect(app.http.streams).toBe(0)
    await app.stop()
  })
})

describe('hand-written sse metadata (ZNIGHT007)', () => {
  const invalid: readonly [string, Partial<Parameters<typeof route>[3]>, string][] = [
    ['on a POST route', { method: 'POST', sse: {} }, 'sse is only valid on GET routes (method POST)'],
    ['not an object', { sse: 'yes' as never }, 'sse must be an object'],
    ['a short heartbeat', { sse: { heartbeat: 10 } }, 'invalid sse.heartbeat 10'],
    ['a negative retry', { sse: { retry: -1 } }, 'invalid sse.retry -1'],
    ['a short maxDuration', { sse: { maxDuration: 5 } }, 'invalid sse.maxDuration 5'],
    ['an unknown key', { sse: { ping: 1 } as never }, 'invalid sse.ping 1'],
  ]
  for (const [name, extra, message] of invalid) {
    it(`rejects sse ${name}`, async () => {
      const error = await bootError({}, extra)
      expect(error).toMatchObject({ code: ErrorCode.InvalidRoute })
      expect(error.message).toContain(message)
    })
  }

  it('accepts heartbeat: 0 (disabled)', async () => {
    const app = await createApp(meta({ sse: { heartbeat: 0, retry: 0, maxDuration: 1_000 } }), {}, { start: false })
    await app.stop()
  })
})

describe('injectStream()', () => {
  it('requires an adapter implementing it', async () => {
    const base = nodeAdapter()
    const adapter: HttpAdapter = {
      name: 'custom',
      registerRoute: route => base.registerRoute(route),
      setFallbackHandler: handler => base.setFallbackHandler(handler),
      listen: (port, host) => base.listen(port, host),
      close: options => base.close(options),
      inject: request => base.inject(request),
    }
    const app = await createApp(meta(), { adapter }, { start: false })
    expect((await app.http.inject({ method: 'GET', url: '/' })).body).toBe('hello')
    await expect(app.http.injectStream({ method: 'GET', url: '/' })).rejects.toThrow(
      'HttpPlugin: the custom adapter does not implement injectStream()',
    )
    await expect(app.http.injectSse({ url: '/' })).rejects.toThrow('does not implement injectStream()')
    await app.stop()
  })

  it('streams a plain response body and can be aborted', async () => {
    const app = await createApp(meta(), {}, { start: false })
    const response = await app.http.injectStream({ method: 'GET', url: '/' })
    expect(response.status).toBe(200)
    expect(await new Response(response.body).text()).toBe('hello')
    await expect(app.http.injectStream({ method: 'GET', url: '/', signal: AbortSignal.abort() })).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    )
    await app.stop()
  })

  it('reads non-event-stream answers to the end with injectSse()', async () => {
    const app = await createApp(meta(), {}, { start: false })
    const response = await app.http.injectSse({ url: '/' })
    expect(response.status).toBe(200)
    expect(response.body).toBe('hello')
    await response.done
    expect(response.comments).toEqual([])
    expect(response.lastEventId).toBe('')
    await expect(response.next({ timeoutMs: 1 })).rejects.toThrow('injectSse(): the event stream of GET / ended')
    await expect(response.take(-1)).rejects.toThrow(TypeError)
    expect(response.json<unknown>).toThrow()
    await app.stop()
  })
})

describe('HttpResponse cookies', () => {
  it('validates at call time and replaces cookies of the same key', () => {
    const response = HttpResponse.ok(1)
      .withCookie('a', '1')
      .withCookie('b', '2', { path: '/b' })
      .withCookie('a', '3')
      .withoutCookie('b', { path: '/b' })
      .withStatus(201)
      .withHeader('x', 'y')
    expect(response.status).toBe(201)
    expect(response.cookies.map(cookie => [cookie.name, cookie.value, cookie.options])).toEqual([
      ['a', '3', {}],
      ['b', undefined, { path: '/b' }],
    ])
    expect(Object.isFrozen(response.cookies)).toBe(true)
    expect(() => HttpResponse.ok(1).withCookie('a b', 'x')).toThrow('Invalid cookie name')
    expect(() => HttpResponse.ok(1).withCookie('a', 'x', { maxAge: 1.5 })).toThrow('maxAge')
    expect(() => HttpResponse.ok(1).withoutCookie('a', null as never)).toThrow('options must be an object')
    // clearing cookies have no lifetime and are never signed
    expect(HttpResponse.ok(1).withoutCookie('a', { maxAge: 5, signed: true } as never).cookies[0]?.options).toEqual({})
  })
})
