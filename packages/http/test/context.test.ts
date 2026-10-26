import type { AdapterRequest, RequestId } from '../src/index.ts'

import { RequestContext } from '../src/context.ts'
import { BadRequestException } from '../src/index.ts'
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

function context(source: AdapterRequest): RequestContext {
  return new RequestContext(source, {
    requestId: 'id-1' as RequestId,
    adapter: 'test',
    route: undefined,
    params: { id: '1' },
    bodyLimit: 100,
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
})
