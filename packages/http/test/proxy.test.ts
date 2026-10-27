/** Trusted proxies (RFC 0001 §5.6): address parsing, hop counts, ranges, aliases, `x-forwarded-proto`. */
import type { TrustProxy } from '../src/index.ts'

import { ErrorCode, ZnightError } from '@znight/core'

import { parseAddress, resolveTrustProxy } from '../src/proxy.ts'
import { controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

function client(
  trust: TrustProxy,
  remote: string | undefined,
  headers: Record<string, string> = {},
  encrypted = false,
): { ip: string | undefined; protocol: string } {
  const policy = resolveTrustProxy(trust)
  if (policy === undefined) throw new Error('expected a policy')
  return policy.resolve(remote, headers, encrypted)
}

describe('parseAddress', () => {
  it.each([
    ['10.0.0.1', '10.0.0.1'],
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::FFFF:7f00:1', '127.0.0.1'],
    ['2001:DB8::1', '2001:db8::1'],
    ['fe80::1%eth0', 'fe80::1%eth0'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['::', '::'],
  ])('parses %p', (value, text) => {
    expect(parseAddress(value)?.text).toBe(text)
  })

  it.each([
    '',
    '256.0.0.1',
    '01.2.3.4',
    '1.2.3',
    '1.2.3.4:80',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    'gggg::1',
    '12345::1',
    'unknown',
    ':1',
  ])('rejects %p', value => {
    expect(parseAddress(value)).toBeUndefined()
  })
})

describe('resolveTrustProxy', () => {
  it('is disabled by default and with false', () => {
    expect(resolveTrustProxy(undefined)).toBeUndefined()
    expect(resolveTrustProxy(false)).toBeUndefined()
  })

  it.each([
    [true, 'option "trustProxy"'],
    [0, 'option "trustProxy"'],
    [-1, 'option "trustProxy"'],
    [1.5, 'option "trustProxy"'],
    ['loopback', 'option "trustProxy"'],
    [['10.0.0.0/33'], '"10.0.0.0/33" is invalid'],
    [['10.0.0.0/x'], '"10.0.0.0/x" is invalid'],
    [['::/129'], '"::/129" is invalid'],
    [['localhost'], '"localhost" is invalid'],
    [[42], 'option "trustProxy"'],
  ])('rejects %p (ZNIGHT005)', (value, message) => {
    let error: unknown
    try {
      resolveTrustProxy(value as TrustProxy)
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
    expect((error as ZnightError).message).toContain(message)
    expect((error as ZnightError).hints.join(' ')).toContain('Trusting every hop')
  })
})

describe('hop counts', () => {
  const xff = { 'x-forwarded-for': '198.51.100.1, 203.0.113.9, 10.0.0.2' }

  it('trusts the given number of hops from the socket', () => {
    expect(client(1, '10.0.0.1', xff).ip).toBe('10.0.0.2')
    expect(client(2, '10.0.0.1', xff).ip).toBe('203.0.113.9')
    expect(client(3, '10.0.0.1', xff).ip).toBe('198.51.100.1')
  })

  it('stops at the leftmost entry when the list is shorter', () => {
    expect(client(9, '10.0.0.1', xff).ip).toBe('198.51.100.1')
    expect(client(1, '10.0.0.1').ip).toBe('10.0.0.1')
  })

  it('stops at the last valid address before a malformed entry', () => {
    expect(client(3, '10.0.0.1', { 'x-forwarded-for': '198.51.100.1, garbage, 10.0.0.2' }).ip).toBe('10.0.0.2')
    expect(client(2, '10.0.0.1', { 'x-forwarded-for': '1.1.1.1, ' }).ip).toBe('10.0.0.1')
  })

  it('reads the leftmost x-forwarded-proto (the peer is trusted)', () => {
    expect(client(1, '10.0.0.1', { 'x-forwarded-proto': 'https, http' }).protocol).toBe('https')
    expect(client(1, '10.0.0.1', { 'x-forwarded-proto': 'HTTP' }, true).protocol).toBe('http')
    expect(client(1, '10.0.0.1', { 'x-forwarded-proto': 'wss' }, true).protocol).toBe('https')
    expect(client(1, '10.0.0.1', {}, true).protocol).toBe('https')
  })
})

describe('trusted addresses', () => {
  it('walks while the addresses are trusted (spoofed entries on the left are ignored)', () => {
    const headers = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2, 10.0.0.3' }
    expect(client(['10.0.0.0/8'], '10.0.0.1', headers).ip).toBe('203.0.113.9')
    expect(client(['private'], '10.0.0.1', headers).ip).toBe('203.0.113.9')
  })

  it('returns the leftmost entry when every address is trusted', () => {
    expect(client(['private'], '10.0.0.1', { 'x-forwarded-for': '192.168.1.5, 172.16.0.9' }).ip).toBe('192.168.1.5')
  })

  it('ignores the headers when the socket peer is not trusted', () => {
    const result = client(['loopback'], '198.51.100.7', { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' })
    expect(result).toEqual({ ip: '198.51.100.7', protocol: 'http' })
  })

  it('normalises IPv4-mapped IPv6 peers and supports IPv6 ranges and aliases', () => {
    expect(client(['loopback'], '::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }).ip).toBe('203.0.113.9')
    expect(client(['loopback'], '::1', { 'x-forwarded-for': '2001:db8::7' }).ip).toBe('2001:db8::7')
    expect(client(['fc00::/7'], 'fd12::1', { 'x-forwarded-for': '2001:db8::7' }).ip).toBe('2001:db8::7')
    expect(client(['linklocal'], 'fe80::1%eth0', { 'x-forwarded-for': '203.0.113.9' }).ip).toBe('203.0.113.9')
    expect(client(['linklocal'], '169.254.1.1', { 'x-forwarded-for': '203.0.113.9' }).ip).toBe('203.0.113.9')
    expect(client(['172.16.0.0/12'], '172.32.0.1', { 'x-forwarded-for': '203.0.113.9' }).ip).toBe('172.32.0.1')
    expect(client(['192.168.1.10'], '192.168.1.10', { 'x-forwarded-for': '203.0.113.9' }).ip).toBe('203.0.113.9')
    expect(client(['192.168.1.10'], '192.168.1.11', { 'x-forwarded-for': '203.0.113.9' }).ip).toBe('192.168.1.11')
  })

  it('keeps an unparsable or unknown socket address', () => {
    expect(client(['loopback'], undefined, { 'x-forwarded-for': '1.2.3.4' })).toEqual({
      ip: undefined,
      protocol: 'http',
    })
    expect(client(1, 'unix-socket', { 'x-forwarded-for': '1.2.3.4' })).toEqual({ ip: 'unix-socket', protocol: 'http' })
  })
})

describe('ctx.ip and ctx.protocol', () => {
  class Controller {
    client(ip: string | undefined, protocol: string) {
      return { ip, protocol }
    }
  }
  const meta = metadata({ [t('Controller')]: provider(Controller) }, [
    controller(t('Controller'), '/', [
      route('client', '/client', (c: Controller, ctx) => c.client(ctx.ip, ctx.protocol), {
        params: [{ index: 0, source: 'context' }],
      }),
    ]),
  ])

  it('keep the adapter values without trustProxy', async () => {
    const app = await createApp(meta, {}, { start: false })
    try {
      const res = await app.http.inject({
        method: 'GET',
        url: '/client',
        headers: { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' },
      })
      expect(res.json()).toEqual({ ip: '127.0.0.1', protocol: 'http' })
    } finally {
      await app.stop()
    }
  })

  it('follow a hop count', async () => {
    const app = await createApp(meta, { trustProxy: 1 }, { start: false })
    try {
      const res = await app.http.inject({
        method: 'GET',
        url: '/client',
        headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4', 'x-forwarded-proto': 'https' },
      })
      expect(res.json()).toEqual({ ip: '1.2.3.4', protocol: 'https' })
    } finally {
      await app.stop()
    }
  })
})
