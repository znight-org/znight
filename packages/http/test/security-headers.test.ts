/** Security headers (RFC 0001 §5.5): defaults, merging, validation; precedence in the pipeline. */
import type { SecurityHeadersOptions } from '../src/index.ts'

import { ErrorCode, ZnightError } from '@znight/core'

import { HttpResponse } from '../src/index.ts'
import { resolveSecurityHeaders } from '../src/security-headers.ts'
import { controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const DEFAULTS = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

describe('resolveSecurityHeaders', () => {
  it('has safe defaults for APIs (on by default)', () => {
    expect(resolveSecurityHeaders(undefined)).toEqual(DEFAULTS)
    expect(resolveSecurityHeaders(true)).toEqual(DEFAULTS)
    expect(Object.isFrozen(resolveSecurityHeaders(undefined))).toBe(true)
  })

  it('is disabled with false', () => {
    expect(resolveSecurityHeaders(false)).toEqual({})
  })

  it('merges an object over the defaults', () => {
    expect(
      resolveSecurityHeaders({
        contentSecurityPolicy: false,
        frameOptions: 'SAMEORIGIN',
        noSniff: false,
        referrerPolicy: 'no-referrer, strict-origin-when-cross-origin',
        hsts: true,
        crossOriginResourcePolicy: 'same-site',
        cacheControl: 'no-store',
      }),
    ).toEqual({
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'no-referrer, strict-origin-when-cross-origin',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'cross-origin-resource-policy': 'same-site',
      'cache-control': 'no-store',
    })
  })

  it('builds HSTS', () => {
    const hsts = (value: SecurityHeadersOptions['hsts']) =>
      resolveSecurityHeaders({ hsts: value })['strict-transport-security']
    expect(hsts(false)).toBeUndefined()
    expect(hsts({ maxAge: 600, includeSubDomains: false })).toBe('max-age=600')
    expect(hsts({ preload: true })).toBe('max-age=31536000; includeSubDomains; preload')
  })

  it.each([
    ['yes', 'option "securityHeaders"'],
    [{ csp: "default-src 'none'" }, 'unknown "csp"'],
    [{ contentSecurityPolicy: '' }, 'securityHeaders.contentSecurityPolicy'],
    [{ contentSecurityPolicy: 'a\r\nb' }, 'securityHeaders.contentSecurityPolicy'],
    [{ frameOptions: 'ALLOW-FROM x' }, 'securityHeaders.frameOptions'],
    [{ noSniff: 'yes' }, 'securityHeaders.noSniff'],
    [{ referrerPolicy: 'never' }, 'securityHeaders.referrerPolicy'],
    [{ hsts: { maxAge: -1 } }, 'securityHeaders.hsts.maxAge'],
    [{ hsts: { maxAge: 600, preload: true } }, 'securityHeaders.hsts'],
    [{ hsts: { includeSubDomains: false, preload: true } }, 'securityHeaders.hsts'],
    [{ hsts: { age: 1 } }, 'securityHeaders.hsts'],
    [{ crossOriginResourcePolicy: 'none' }, 'securityHeaders.crossOriginResourcePolicy'],
    [{ cacheControl: 1 }, 'securityHeaders.cacheControl'],
  ])('rejects %p (ZNIGHT005)', (value, message) => {
    let error: unknown
    try {
      resolveSecurityHeaders(value as SecurityHeadersOptions)
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
    expect((error as ZnightError).message).toContain(message)
  })
})

describe('security headers in the pipeline', () => {
  class Controller {
    plain() {
      return 'plain'
    }
    custom() {
      return new HttpResponse('custom', { headers: { 'referrer-policy': 'origin', 'cache-control': 'max-age=60' } })
    }
    response() {
      return new Response('web', { headers: { 'x-frame-options': 'SAMEORIGIN' } })
    }
  }
  const meta = metadata({ [t('Controller')]: provider(Controller) }, [
    controller(t('Controller'), '/', [
      route('plain', '/plain', (c: Controller) => c.plain()),
      route('custom', '/custom', (c: Controller) => c.custom()),
      route('response', '/response', (c: Controller) => c.response()),
    ]),
  ])

  it('lose to HttpResponse headers and Web Response headers', async () => {
    const app = await createApp(meta, { securityHeaders: { cacheControl: 'no-store' } }, { start: false })
    try {
      const plain = await app.http.inject({ method: 'GET', url: '/plain' })
      expect(plain.headers).toMatchObject({ ...DEFAULTS, 'cache-control': 'no-store' })
      const custom = await app.http.inject({ method: 'GET', url: '/custom' })
      expect(custom.headers).toMatchObject({ 'referrer-policy': 'origin', 'cache-control': 'max-age=60' })
      const response = await app.http.inject({ method: 'GET', url: '/response' })
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
    } finally {
      await app.stop()
    }
  })

  it('are absent with securityHeaders: false', async () => {
    const app = await createApp(meta, { securityHeaders: false }, { start: false })
    try {
      const res = await app.http.inject({ method: 'GET', url: '/plain' })
      for (const name of Object.keys(DEFAULTS)) expect(res.headers[name]).toBeUndefined()
    } finally {
      await app.stop()
    }
  })
})
