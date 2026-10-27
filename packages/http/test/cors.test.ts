/** CORS policy (RFC 0001 §5.4): option validation, origin decisions, headers; pipeline edge cases. */
import type { CorsOptions } from '../src/index.ts'

import { ErrorCode, ZnightError } from '@znight/core'

import { corsReplyHeaders, isPreflight, mergeVary, preflightHeaders, resolveCors } from '../src/cors.ts'
import { caught, controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

/** A resolved policy; `requestIdHeader: null` stands for `requestIdHeader: false`. */
function policy(options: CorsOptions, requestIdHeader: string | null = 'x-request-id') {
  const resolved = resolveCors(options, requestIdHeader ?? undefined)
  if (resolved === undefined) throw new Error('expected a policy')
  return resolved
}

function rejection(options: unknown): ZnightError {
  try {
    resolveCors(options as CorsOptions, 'x-request-id')
  } catch (error) {
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
    return error as ZnightError
  }
  throw new Error('expected a ZNIGHT005 error')
}

describe('resolveCors', () => {
  it('is disabled by default and with false', () => {
    expect(resolveCors(undefined, 'x-request-id')).toBeUndefined()
    expect(resolveCors(false, 'x-request-id')).toBeUndefined()
  })

  it.each([
    [{}, 'option "cors.origin"'],
    [
      { origin: 'https://app.example.com/' },
      'without path, trailing slash or default port ("https://app.example.com")',
    ],
    [{ origin: 'https://app.example.com:443' }, '("https://app.example.com")'],
    [{ origin: 'https://App.example.com' }, '("https://app.example.com")'],
    [{ origin: 'app.example.com' }, 'an http(s) origin'],
    [{ origin: 'ftp://files.example.com' }, 'an http(s) origin'],
    [{ origin: 'null' }, 'a real origin'],
    [{ origin: /example\.com$/ }, 'anchored with ^ and $'],
    [{ origin: /^https:\/\/example\.com/ }, 'anchored with ^ and $'],
    [{ origin: /^https:\/\/example\.com\$/ }, 'anchored with ^ and $'],
    [{ origin: /^https:\/\/a\.com|https:\/\/b\.com$/ }, 'around every alternative'],
    [{ origin: /^https:\/\/example\.com$/g }, 'without the g or y flag'],
    [{ origin: /^https:\/\/example\.com$/y }, 'without the g or y flag'],
    [{ origin: 42 }, 'option "cors.origin"'],
    [{ origin: ['https://a.com', 42] }, 'option "cors.origin"'],
    [{ origin: '*', credentials: true }, "explicit origins when credentials is true (not '*')"],
    [{ origin: ['https://a.com', '*'], credentials: true }, "explicit origins when credentials is true (not '*')"],
    [{ origin: 'https://a.com', credentials: true, allowHeaders: '*' }, 'option "cors.allowHeaders"'],
    [{ origin: 'https://a.com', credentials: 'yes' }, 'option "cors.credentials"'],
    [{ origin: 'https://a.com', methods: ['GET', 'BAD METHOD'] }, 'option "cors.methods"'],
    [{ origin: 'https://a.com', allowHeaders: ['x-ok', 'bad header'] }, 'option "cors.allowHeaders"'],
    [{ origin: 'https://a.com', exposeHeaders: 'x-a' }, 'option "cors.exposeHeaders"'],
    [{ origin: 'https://a.com', maxAge: 86_401 }, 'option "cors.maxAge"'],
    [{ origin: 'https://a.com', maxAge: 1.5 }, 'option "cors.maxAge"'],
    [{ origin: 'https://a.com', allow: ['x'] }, 'option "cors"'],
    [true, 'option "cors"'],
  ])('rejects %p', (options, message) => {
    expect(rejection(options).message).toContain(message)
  })

  it('accepts origins, anchored patterns and lists', async () => {
    const cors = policy({ origin: ['https://a.com', /^https:\/\/(?:x|y)\.b\.com$/, 'http://localhost:5173'] })
    expect(await cors.allows('https://a.com')).toBe(true)
    expect(await cors.allows('https://x.b.com')).toBe(true)
    expect(await cors.allows('http://localhost:5173')).toBe(true)
    expect(await cors.allows('https://a.com.evil.net')).toBe(false)
    expect(await cors.allows('https://z.b.com')).toBe(false)
    expect(await cors.allows('null')).toBe(false)
    expect(cors.wildcard).toBe(false)
    expect(cors.varyOrigin).toBe(true)
  })

  it('accepts a wildcard (alone: no vary on origin)', async () => {
    const alone = policy({ origin: '*' })
    expect(await alone.allows('https://anything.example')).toBe(true)
    expect({ wildcard: alone.wildcard, varyOrigin: alone.varyOrigin }).toEqual({ wildcard: true, varyOrigin: false })
    const listed = policy({ origin: ['*', 'https://a.com'] })
    expect({ wildcard: listed.wildcard, varyOrigin: listed.varyOrigin }).toEqual({ wildcard: true, varyOrigin: true })
  })

  it('accepts a function (awaited by the pipeline)', async () => {
    const cors = policy({ origin: async origin => origin.endsWith('.example.com') })
    expect(await cors.allows('https://a.example.com')).toBe(true)
    expect(await cors.allows('https://a.example.org')).toBe(false)
  })

  it('exposes the request id header by default', () => {
    expect(policy({ origin: 'https://a.com' }).exposeHeaders).toBe('x-request-id')
    expect(policy({ origin: 'https://a.com' }, null).exposeHeaders).toBeUndefined()
    expect(policy({ origin: 'https://a.com', exposeHeaders: ['X-Total', 'ETag'] }).exposeHeaders).toBe('x-total, etag')
    expect(policy({ origin: 'https://a.com', exposeHeaders: [] }).exposeHeaders).toBeUndefined()
  })
})

describe('preflight headers', () => {
  it('detects preflights', () => {
    expect(isPreflight('OPTIONS', { origin: 'https://a.com', 'access-control-request-method': 'PUT' })).toBe(true)
    expect(isPreflight('OPTIONS', { origin: 'https://a.com' })).toBe(false)
    expect(isPreflight('OPTIONS', { 'access-control-request-method': 'PUT' })).toBe(false)
    expect(isPreflight('GET', { origin: 'https://a.com', 'access-control-request-method': 'PUT' })).toBe(false)
  })

  it('uses the options, else the path methods and the requested headers', () => {
    const configured = policy({
      origin: 'https://a.com',
      methods: ['GET', 'PUT'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 60,
      credentials: true,
    })
    expect(preflightHeaders(configured, 'https://a.com', {}, 'GET, HEAD, OPTIONS')).toEqual({
      'access-control-allow-origin': 'https://a.com',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, PUT',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '60',
      allow: 'GET, HEAD, OPTIONS',
      vary: 'origin, access-control-request-method, access-control-request-headers',
    })
    const defaults = policy({ origin: '*', allowHeaders: undefined })
    expect(
      preflightHeaders(
        defaults,
        'https://b.com',
        { 'access-control-request-headers': ' X-A ,x-b,, ' },
        'POST, OPTIONS',
      ),
    ).toEqual({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'x-a, x-b',
      'access-control-max-age': '600',
      allow: 'POST, OPTIONS',
      vary: 'origin, access-control-request-method, access-control-request-headers',
    })
  })

  it('omits allow-headers for an invalid request list, sends * when configured', () => {
    const cors = policy({ origin: 'https://a.com' })
    const invalid = preflightHeaders(
      cors,
      'https://a.com',
      { 'access-control-request-headers': 'x-a, bad header' },
      'GET',
    )
    expect(invalid['access-control-allow-headers']).toBeUndefined()
    const star = policy({ origin: 'https://a.com', allowHeaders: '*' })
    expect(preflightHeaders(star, 'https://a.com', {}, 'GET')['access-control-allow-headers']).toBe('*')
  })

  it('builds reply headers', () => {
    expect(corsReplyHeaders(policy({ origin: 'https://a.com', credentials: true }), 'https://a.com')).toEqual({
      'access-control-allow-origin': 'https://a.com',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id',
    })
    expect(corsReplyHeaders(policy({ origin: '*' }, null), 'https://a.com')).toEqual({
      'access-control-allow-origin': '*',
    })
  })
})

describe('mergeVary', () => {
  it.each([
    [undefined, 'origin'],
    ['accept', 'accept, origin'],
    ['Accept, Origin', 'Accept, Origin'],
    ['*', '*'],
    [['accept', 'accept-encoding'], 'accept, accept-encoding, origin'],
    ['', 'origin'],
  ])('%p → %p', (existing, expected) => {
    const headers: Record<string, string | string[]> = existing === undefined ? {} : { vary: existing }
    mergeVary(headers, 'origin')
    expect(headers['vary']).toBe(expected)
  })
})

describe('CORS in the pipeline', () => {
  class Controller {
    get() {
      return 'ok'
    }
  }
  const meta = metadata({ [t('Controller')]: provider(Controller) }, [
    controller(t('Controller'), '/', [route('get', '/items', (c: Controller) => c.get())]),
  ])

  it('denies (and logs) an origin whose check throws', async () => {
    const app = await createApp(
      meta,
      {
        cors: {
          origin: origin => {
            if (origin === 'https://boom.example') throw new Error('lookup failed')
            return Promise.resolve(origin === 'https://ok.example')
          },
        },
      },
      { start: false },
    )
    try {
      const ok = await app.http.inject({ method: 'GET', url: '/items', headers: { origin: 'https://ok.example' } })
      expect(ok.headers['access-control-allow-origin']).toBe('https://ok.example')
      const boom = await app.http.inject({
        method: 'OPTIONS',
        url: '/items',
        headers: { origin: 'https://boom.example', 'access-control-request-method': 'GET' },
      })
      expect(boom.status).toBe(403)
      const logged = app.logger.entries.find(entry => entry.message.startsWith('The CORS origin check failed'))
      expect(logged?.level).toBe('error')
      expect(logged?.context?.['origin']).toBe('https://boom.example')
    } finally {
      await app.stop()
    }
  })

  it("does not vary on origin with origin: '*'", async () => {
    const app = await createApp(meta, { cors: { origin: '*' } }, { start: false })
    try {
      const res = await app.http.inject({ method: 'GET', url: '/items', headers: { origin: 'https://a.example' } })
      expect(res.headers['access-control-allow-origin']).toBe('*')
      expect(res.headers['vary']).toBeUndefined()
    } finally {
      await app.stop()
    }
  })

  it('leaves OPTIONS alone without the cors option', async () => {
    const app = await createApp(meta, {}, { start: false })
    try {
      const res = await app.http.inject({
        method: 'OPTIONS',
        url: '/items',
        headers: { origin: 'https://a.example', 'access-control-request-method': 'GET' },
      })
      expect(res.status).toBe(204)
      expect(res.headers['allow']).toBe('GET, HEAD, OPTIONS')
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      expect(res.headers['vary']).toBeUndefined()
    } finally {
      await app.stop()
    }
  })

  it('reports an invalid option at boot', async () => {
    const error = await caught(() => createApp(meta, { cors: { origin: 'https://a.com/' } }, { start: false }))
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
  })
})
