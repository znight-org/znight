import type { AdapterRequest, RequestId } from '../src/index.ts'

import { RequestContext } from '../src/context.ts'
import { CookieSigner } from '../src/cookie-signer.ts'
import { DEFAULT_COOKIE_OPTIONS } from '../src/cookies.ts'
import { BadRequestException, RequestAbortedError } from '../src/index.ts'
import { bodyPlan, DEFAULT_UPLOAD_LIMITS } from '../src/uploads.ts'
import { describe, expect, it } from 'bun:test'

function request(overrides: Partial<AdapterRequest> = {}, body = ''): AdapterRequest & { reads: number } {
  const result = {
    reads: 0,
    method: 'POST',
    url: '/users/1?tag=a&tag=b',
    headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
    ip: '127.0.0.1',
    raw: { native: 'request' },
    rawResponse: { native: 'response' },
    readBody(): Promise<Uint8Array> {
      result.reads++
      return Promise.resolve(new TextEncoder().encode(body))
    },
    ...overrides,
  }
  return result
}

function context(source: AdapterRequest, signer?: CookieSigner): RequestContext {
  return new RequestContext(source, {
    requestId: 'id-1' as RequestId,
    adapter: 'test',
    route: undefined,
    params: { id: '1' },
    body: bodyPlan({}, 100, DEFAULT_UPLOAD_LIMITS),
    cookies: { defaults: DEFAULT_COOKIE_OPTIONS, signer },
  })
}

describe('RequestContext', () => {
  it('exposes the request', () => {
    const ctx = context(request())
    expect(ctx).toMatchObject({
      requestId: 'id-1',
      method: 'POST',
      url: '/users/1?tag=a&tag=b',
      path: '/users/1',
      params: { id: '1' },
      adapter: 'test',
      ip: '127.0.0.1',
      request: { native: 'request' },
      response: { native: 'response' },
      route: undefined,
    })
    expect(ctx.header('X-Custom')).toBe('yes')
    expect(ctx.header('missing')).toBeUndefined()
  })

  it('parses the query lazily, once', () => {
    const ctx = context(request())
    expect(ctx.query).toEqual({ tag: ['a', 'b'] })
    expect(ctx.query).toBe(ctx.query)
  })

  it('stores state and response headers', () => {
    const ctx = context(request())
    expect(ctx.hasResponseHeaders).toBe(false)
    expect(ctx.responseHeaders).toEqual({})
    ctx.state.set('user', 'ada')
    expect(ctx.state.get('user')).toBe('ada')
    ctx.setHeader('X-A', '1')
    ctx.setHeader('x-list', ['a', 'b'])
    ctx.appendHeader('Set-Cookie', 'a=1')
    ctx.appendHeader('set-cookie', 'b=2')
    ctx.appendHeader('set-cookie', 'c=3')
    expect(ctx.hasResponseHeaders).toBe(true)
    expect({ ...ctx.responseHeaders }).toEqual({
      'x-a': '1',
      'x-list': ['a', 'b'],
      'set-cookie': ['a=1', 'b=2', 'c=3'],
    })
  })

  it('reads and parses the body once', async () => {
    const source = request({}, '{"a":1}')
    const ctx = context(source)
    expect(ctx.body).toBeUndefined()
    expect(await ctx.parseBody()).toEqual({ a: 1 })
    expect(await ctx.parseBody()).toEqual({ a: 1 })
    expect(new TextDecoder().decode(await ctx.rawBody())).toBe('{"a":1}')
    expect(ctx.body).toEqual({ a: 1 })
    expect(source.reads).toBe(1)
  })

  it('rejects malformed bodies', async () => {
    const ctx = context(request({}, '{'))
    await expect(ctx.parseBody()).rejects.toBeInstanceOf(BadRequestException)
  })

  it('parses request cookies lazily, once', () => {
    const ctx = context(request({ headers: { cookie: 'a=1; b=x%20y; a=2' } }))
    expect(ctx.cookies).toEqual({ a: '1', b: 'x y' })
    expect(ctx.cookies).toBe(ctx.cookies)
    expect(context(request()).cookies).toEqual({})
  })

  it('verifies signed cookies once per name, and requires secrets', () => {
    const signer = new CookieSigner(['s'.repeat(32)])
    const wire = signer.sign('uid', 'u-1')
    const ctx = context(request({ headers: { cookie: `uid=${wire}; forged=u-2.${'A'.repeat(43)}` } }), signer)
    expect(ctx.signedCookie('uid')).toBe('u-1')
    expect(ctx.signedCookie('uid')).toBe('u-1')
    expect(ctx.signedCookie('forged')).toBeUndefined()
    expect(ctx.signedCookie('absent')).toBeUndefined()
    expect(() => context(request()).signedCookie('uid')).toThrow('cookies.secrets is not set')
  })

  it('collects response cookies in a jar keyed by name, domain and path', () => {
    const ctx = context(request())
    expect(ctx.responseCookies).toEqual([])
    ctx.setCookie('a', '1')
    ctx.setCookie('b', '2', { path: '/b' })
    ctx.clearCookie('a')
    ctx.setCookie('b', '3', { path: '/other' })
    expect(ctx.responseCookies.map(cookie => [cookie.name, cookie.value])).toEqual([
      ['a', undefined],
      ['b', '2'],
      ['b', '3'],
    ])
    expect(ctx.cookieLines.map(entry => entry.line)).toEqual([
      'a=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=Lax',
      'b=2; Path=/b; Secure; HttpOnly; SameSite=Lax',
      'b=3; Path=/other; Secure; HttpOnly; SameSite=Lax',
    ])
  })

  it('validates cookies when they are set', () => {
    const ctx = context(request())
    expect(() => ctx.setCookie('a b', 'x')).toThrow('Invalid cookie name')
    expect(() => ctx.setCookie('__Host-a', 'x', { domain: 'example.com' })).toThrow('forbids a domain')
    expect(() => ctx.setCookie('a', 'x', { signed: true })).toThrow('cookies.secrets is not set')
    expect(() => ctx.setCookie('a', 'x', null as never)).toThrow('options must be an object')
    expect(ctx.responseCookies).toEqual([])
  })

  it('refuses cookies once the headers are sent', () => {
    const ctx = context(request())
    ctx.commit()
    expect(() => ctx.setCookie('a', '1')).toThrow('Cannot set cookie "a": the response headers were already sent')
    expect(() => ctx.clearCookie('a')).toThrow('already sent')
  })

  it('creates the signal lazily and aborts it once', () => {
    const listeners: (() => void)[] = []
    const ctx = context(request({ onAbort: listener => listeners.push(listener) }))
    expect(listeners).toHaveLength(0)
    const signal = ctx.signal
    expect(ctx.signal).toBe(signal)
    expect(listeners).toHaveLength(1)
    expect(signal.aborted).toBe(false)
    listeners[0]?.()
    ctx.abort('shutdown')
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBeInstanceOf(RequestAbortedError)
    expect(signal.reason).toMatchObject({ name: 'AbortError', kind: 'client', message: 'The client disconnected' })
  })

  it('remembers an abort that happened before the signal was created', () => {
    const ctx = context(request())
    ctx.abort('expired')
    expect(ctx.aborted).toBe(true)
    expect(ctx.signal.aborted).toBe(true)
    expect((ctx.signal.reason as RequestAbortedError).kind).toBe('expired')
  })

  it('ignores aborts once the request is over', () => {
    const listeners: (() => void)[] = []
    const ctx = context(request({ onAbort: listener => listeners.push(listener) }))
    const signal = ctx.signal
    ctx.complete()
    listeners[0]?.()
    ctx.abort('client')
    expect(signal.aborted).toBe(false)
    const late = context(request({ onAbort: listener => listeners.push(listener) }))
    late.complete()
    expect(late.signal.aborted).toBe(false)
    expect(listeners).toHaveLength(1) // not subscribed after completion
  })
})
