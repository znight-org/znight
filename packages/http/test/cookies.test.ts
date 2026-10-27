/**
 * Cookies (RFC 0006 §4.2–4.4): request header parsing, canonical value encoding, strict
 * `Set-Cookie` serialisation (every validation rule), `Set-Cookie` parsing and the jar.
 */
import {
  CookieJar,
  checkCookie,
  decodeCookieValue,
  encodeCookieValue,
  isCookieName,
  parseCookieHeader,
  parseSetCookie,
  parseSetCookies,
  serializeClearCookie,
  serializeCookie,
  serializeResponseCookie,
} from '../src/cookies.ts'
import { caught } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('parseCookieHeader', () => {
  const cases: readonly [string, string | undefined, Record<string, string>][] = [
    ['absent', undefined, {}],
    ['empty', '', {}],
    ['one pair', 'a=1', { a: '1' }],
    ['several pairs', 'a=1; b=2;c=3', { a: '1', b: '2', c: '3' }],
    ['optional white space (SP, HTAB)', ' a = 1 ;\tb=\t2\t', { a: '1', b: '2' }],
    ['quoted value', 'a="x y"', { a: 'x y' }],
    ['lone quote kept', 'a="x', { a: '"x' }],
    ['percent-decoded', 'a=caf%C3%A9%3B%20b', { a: 'café; b' }],
    ['malformed sequence kept raw', 'a=%E0%A4%A; b=100%', { a: '%E0%A4%A', b: '100%' }],
    ['"+" is not a space', 'a=1+1', { a: '1+1' }],
    ['", " is not a separator', 'a=x, b=y', { a: 'x, b=y' }],
    ['pairs without "=" are ignored', 'flag; a=1; ;', { a: '1' }],
    ['empty names are ignored', '=x; a=1', { a: '1' }],
    ['empty values are kept', 'a=; b', { a: '' }],
    ['"=" inside values', 'a=b=c', { a: 'b=c' }],
    ['the first occurrence wins', 'a=1; a=2', { a: '1' }],
    ['names are case-sensitive', 'a=1; A=2', { a: '1', A: '2' }],
    ['names are kept as sent', 'my cookie=1; ünï=2', { 'my cookie': '1', ünï: '2' }],
  ]
  for (const [name, header, expected] of cases) {
    it(name, () => {
      expect({ ...parseCookieHeader(header) }).toEqual(expected)
    })
  }

  it('returns a frozen record without prototype (__proto__ is just a name)', () => {
    const cookies = parseCookieHeader('__proto__=x; constructor=y; toString=z')
    expect(Object.getPrototypeOf(cookies)).toBeNull()
    expect(Object.isFrozen(cookies)).toBe(true)
    expect(cookies['__proto__']).toBe('x')
    expect(cookies['constructor']).toBe('y')
    expect(Object.keys(cookies)).toEqual(['__proto__', 'constructor', 'toString'])
  })

  it('parses a 16 KiB header in linear time', () => {
    const pairs = Array.from({ length: 1_000 }, (_, index) => `c${index}=${'v'.repeat(10)}`)
    const header = pairs.join('; ')
    expect(header.length).toBeGreaterThan(16_000)
    const started = performance.now()
    const cookies = parseCookieHeader(header)
    expect(performance.now() - started).toBeLessThan(50)
    expect(Object.keys(cookies)).toHaveLength(1_000)
    // pathological inputs do not blow up either
    expect(Object.keys(parseCookieHeader(';'.repeat(20_000)))).toHaveLength(0)
    expect(Object.keys(parseCookieHeader('='.repeat(20_000)))).toHaveLength(0)
  })
})

describe('encodeCookieValue / decodeCookieValue', () => {
  it('encodes the bytes outside cookie-octet and "%"', () => {
    expect(encodeCookieValue('a b;c')).toBe('a%20b%3Bc')
    expect(encodeCookieValue('"q",\\%')).toBe('%22q%22%2C%5C%25')
    expect(encodeCookieValue('café')).toBe('caf%C3%A9')
    expect(encodeCookieValue('😀')).toBe('%F0%9F%98%80')
    expect(encodeCookieValue('\u0000\t\u007f')).toBe('%00%09%7F')
    // unchanged when nothing needs encoding (the same string)
    const plain = "abc.DEF-123_~!#$&'()*+/:<=>?@[]^`{|}"
    expect(encodeCookieValue(plain)).toBe(plain)
  })

  it('round-trips every Latin-1 character and emoji', () => {
    for (let code = 0; code <= 0xff; code++) {
      const value = `x${String.fromCharCode(code)}y`
      const encoded = encodeCookieValue(value)
      expect(decodeCookieValue(encoded)).toBe(value)
      // canonical: encode(decode(w)) === w
      expect(encodeCookieValue(decodeCookieValue(encoded))).toBe(encoded)
      // and it survives the request header parser
      expect(parseCookieHeader(`k=${encoded}`)['k']).toBe(value)
    }
    for (const value of ['👍🏽 thumbs', '漢字', 'a\u{1F600}b', '%41', '%%', '']) {
      expect(decodeCookieValue(encodeCookieValue(value))).toBe(value)
    }
  })

  it('rejects non-strings and lone surrogates', () => {
    expect(() => encodeCookieValue('\ud800')).toThrow(TypeError)
    expect(() => encodeCookieValue('a\udc00b')).toThrow('lone surrogate')
    expect(() => encodeCookieValue(42 as unknown as string)).toThrow(TypeError)
  })

  it('decodes only values containing "%", keeping malformed ones', () => {
    expect(decodeCookieValue('a+b')).toBe('a+b')
    expect(decodeCookieValue('%zz')).toBe('%zz')
  })
})

describe('isCookieName', () => {
  it('accepts RFC 9110 tokens only', () => {
    for (const name of ['sid', '__Host-uid', "a!#$%&'*+-.^_`|~9"]) expect(isCookieName(name)).toBe(true)
    for (const name of ['', 'a b', 'a;b', 'a=b', 'a,b', 'é', 'a"', '(a)', 'a/b', 'a:b']) {
      expect(isCookieName(name)).toBe(false)
    }
    expect(isCookieName(1)).toBe(false)
  })
})

describe('serializeCookie', () => {
  it('applies the secure defaults', () => {
    expect(serializeCookie('sid', 'abc')).toBe('sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax')
  })

  it('writes every attribute in order', () => {
    const expires = new Date(Date.UTC(2030, 0, 2, 3, 4, 5))
    expect(
      serializeCookie('n', 'v w', {
        maxAge: 3600,
        expires,
        domain: '.Example.COM',
        path: '/app',
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        partitioned: true,
        priority: 'high',
      }),
    ).toBe(
      'n=v%20w; Max-Age=3600; Expires=Wed, 02 Jan 2030 03:04:05 GMT; Domain=example.com; Path=/app; Secure; HttpOnly; SameSite=None; Partitioned; Priority=High',
    )
  })

  it('turns off flags and writes SameSite and Priority values', () => {
    expect(serializeCookie('t', 'dark', { httpOnly: false, sameSite: 'strict', priority: 'low' })).toBe(
      't=dark; Path=/; Secure; SameSite=Strict; Priority=Low',
    )
    expect(serializeCookie('t', 'x', { secure: false, priority: 'medium' })).toBe(
      't=x; Path=/; HttpOnly; SameSite=Lax; Priority=Medium',
    )
  })

  it('expires the cookie at once with maxAge ≤ 0', () => {
    expect(serializeCookie('a', '', { maxAge: 0 })).toBe('a=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax')
    expect(serializeCookie('a', 'x', { maxAge: -5 })).toStartWith('a=x; Max-Age=0;')
  })

  it('ignores options set to undefined (the defaults stay)', () => {
    expect(serializeCookie('a', 'x', { path: undefined, secure: undefined })).toBe(
      'a=x; Path=/; Secure; HttpOnly; SameSite=Lax',
    )
  })

  const invalid: readonly [string, () => unknown, ErrorConstructor | RangeErrorConstructor, string][] = [
    ['a name that is not a token', () => serializeCookie('a b', 'x'), TypeError, 'Invalid cookie name "a b"'],
    ['an empty name', () => serializeCookie('', 'x'), TypeError, 'Invalid cookie name ""'],
    ['a non-string value', () => serializeCookie('a', 1 as unknown as string), TypeError, 'must be a string'],
    ['a lone surrogate', () => serializeCookie('a', '\ud83d'), TypeError, 'lone surrogate'],
    ['a fractional maxAge', () => serializeCookie('a', 'x', { maxAge: 1.5 }), TypeError, 'maxAge must be an integer'],
    ['an infinite maxAge', () => serializeCookie('a', 'x', { maxAge: Infinity }), TypeError, 'maxAge'],
    ['an invalid Date', () => serializeCookie('a', 'x', { expires: new Date('x') }), TypeError, 'expires'],
    ['a string expires', () => serializeCookie('a', 'x', { expires: '2030' as never }), TypeError, 'expires'],
    ['a domain with a port', () => serializeCookie('a', 'x', { domain: 'a.com:80' }), TypeError, 'invalid domain'],
    ['an IDN domain', () => serializeCookie('a', 'x', { domain: 'exämple.com' }), TypeError, 'punycode'],
    ['an empty label', () => serializeCookie('a', 'x', { domain: 'a..com' }), TypeError, 'invalid domain'],
    ['a trailing dot', () => serializeCookie('a', 'x', { domain: 'a.com.' }), TypeError, 'invalid domain'],
    ['an empty domain', () => serializeCookie('a', 'x', { domain: '' }), TypeError, 'invalid domain'],
    ['a relative path', () => serializeCookie('a', 'x', { path: 'app' }), TypeError, 'invalid path'],
    ['a path with ";"', () => serializeCookie('a', 'x', { path: '/a;b' }), TypeError, 'invalid path'],
    ['a path with a control', () => serializeCookie('a', 'x', { path: '/a\nb' }), TypeError, 'invalid path'],
    ['a non-ASCII path', () => serializeCookie('a', 'x', { path: '/é' }), TypeError, 'invalid path'],
    [
      'SameSite=None without Secure',
      () => serializeCookie('a', 'x', { sameSite: 'none', secure: false }),
      TypeError,
      'SameSite=None requires secure',
    ],
    [
      'partitioned without Secure',
      () => serializeCookie('a', 'x', { partitioned: true, secure: false }),
      TypeError,
      'partitioned cookies require secure',
    ],
    [
      'an unknown SameSite',
      () => serializeCookie('a', 'x', { sameSite: 'Lax' as never }),
      TypeError,
      'sameSite must be',
    ],
    [
      'an unknown priority',
      () => serializeCookie('a', 'x', { priority: 'urgent' as never }),
      TypeError,
      'priority must be',
    ],
    [
      'a non-boolean flag',
      () => serializeCookie('a', 'x', { httpOnly: 'yes' as never }),
      TypeError,
      'httpOnly must be a boolean',
    ],
    [
      'an unknown option',
      () => serializeCookie('a', 'x', { maxage: 1 } as never),
      TypeError,
      'unknown option "maxage"',
    ],
    [
      'options that are not an object',
      () => serializeCookie('a', 'x', 'secure' as never),
      TypeError,
      'must be an object',
    ],
    [
      '__Secure- without Secure',
      () => serializeCookie('__Secure-a', 'x', { secure: false }),
      TypeError,
      'the __Secure- prefix requires secure',
    ],
    [
      '__secure- (any case) without Secure',
      () => serializeCookie('__SECURE-a', 'x', { secure: false }),
      TypeError,
      '__Secure- prefix',
    ],
    [
      '__Host- with a domain',
      () => serializeCookie('__Host-a', 'x', { domain: 'a.com' }),
      TypeError,
      'the __Host- prefix forbids a domain',
    ],
    [
      '__Host- with another path',
      () => serializeCookie('__host-a', 'x', { path: '/app' }),
      TypeError,
      "the __Host- prefix requires path: '/'",
    ],
    [
      '__Host- without Secure',
      () => serializeCookie('__Host-a', 'x', { secure: false }),
      TypeError,
      'the __Host- prefix requires secure',
    ],
    [
      '__Http- without HttpOnly',
      () => serializeCookie('__Http-a', 'x', { httpOnly: false }),
      TypeError,
      'the __Http- prefix requires httpOnly',
    ],
    [
      '__Http- without Secure',
      () => serializeCookie('__Http-a', 'x', { secure: false }),
      TypeError,
      'the __Http- prefix requires secure',
    ],
    [
      '__Host-Http- without HttpOnly',
      () => serializeCookie('__Host-Http-a', 'x', { httpOnly: false }),
      TypeError,
      'the __Host-Http- prefix requires httpOnly',
    ],
    [
      '__Host-Http- with a path',
      () => serializeCookie('__host-http-a', 'x', { path: '/x' }),
      TypeError,
      'the __Host-Http- prefix requires path',
    ],
    [
      'name=value above 4096 bytes',
      () => serializeCookie('a', 'x'.repeat(4095)),
      RangeError,
      'above the limit of 4096',
    ],
    ['an encoded value above 4096 bytes', () => serializeCookie('a', 'é'.repeat(700)), RangeError, '4096'],
    [
      'a domain above 1024 bytes',
      () => serializeCookie('a', 'x', { domain: `${'a'.repeat(1025)}.com` }),
      RangeError,
      'domain exceeds 1024',
    ],
    [
      'a path above 1024 bytes',
      () => serializeCookie('a', 'x', { path: `/${'a'.repeat(1024)}` }),
      RangeError,
      'path exceeds 1024',
    ],
  ]
  for (const [name, fn, type, message] of invalid) {
    it(`rejects ${name}`, async () => {
      const error = await caught(fn)
      expect(error).toBeInstanceOf(type)
      expect((error as Error).message).toContain(message)
    })
  }

  it('accepts valid prefixed cookies and the size limit exactly', () => {
    expect(serializeCookie('__Host-uid', 'u')).toBe('__Host-uid=u; Path=/; Secure; HttpOnly; SameSite=Lax')
    expect(serializeCookie('__Secure-a', 'x', { domain: 'example.com', path: '/a' })).toContain('Domain=example.com')
    expect(serializeCookie('__Host-Http-a', 'x')).toStartWith('__Host-Http-a=x;')
    expect(serializeCookie('a', 'x'.repeat(4094))).toStartWith('a=x')
    expect(serializeCookie('a', 'x', { domain: 'localhost', path: `/${'a'.repeat(1023)}` })).toContain(
      'Domain=localhost',
    )
  })

  it('measures the size after signing', () => {
    const sign = (_name: string, encoded: string): string => `${encoded}.${'s'.repeat(43)}`
    const fits = 'x'.repeat(4094 - 44)
    expect(serializeResponseCookie({ name: 'a', value: fits, options: { signed: true } }, {}, sign).line).toStartWith(
      `a=${fits}.sss`,
    )
    expect(() =>
      serializeResponseCookie({ name: 'a', value: `${fits}x`, options: { signed: true } }, {}, sign),
    ).toThrow(RangeError)
    expect(() => serializeResponseCookie({ name: 'a', value: 'x', options: { signed: true } }, {})).toThrow(
      'no signing key',
    )
  })
})

describe('serializeResponseCookie', () => {
  it('merges the defaults under the options and keys the cookie by name, domain and path', () => {
    const defaults = { path: '/', secure: false, httpOnly: true, sameSite: 'strict' as const, domain: 'Example.com' }
    const cookie = serializeResponseCookie({ name: 'a', value: 'x', options: { path: '/p' } }, defaults)
    expect(cookie.line).toBe('a=x; Domain=example.com; Path=/p; HttpOnly; SameSite=Strict')
    const other = serializeResponseCookie(
      { name: 'a', value: 'y', options: { path: '/p', domain: '.EXAMPLE.com' } },
      defaults,
    )
    expect(other.key).toBe(cookie.key)
    expect(serializeResponseCookie({ name: 'a', value: 'x', options: {} }, defaults).key).not.toBe(cookie.key)
  })

  it('checks the prefixes against the defaults', () => {
    expect(() => serializeResponseCookie({ name: '__Host-a', value: 'x', options: {} }, { secure: false })).toThrow(
      '__Host- prefix requires secure',
    )
  })
})

describe('serializeClearCookie', () => {
  it('expires the cookie with the same identifying attributes', () => {
    expect(serializeClearCookie('sid')).toBe(
      'sid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=Lax',
    )
    expect(serializeClearCookie('a', { domain: 'example.com', path: '/x', partitioned: true })).toBe(
      'a=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=example.com; Path=/x; Secure; HttpOnly; SameSite=Lax; Partitioned',
    )
  })

  it('keeps prefixed cookies valid and is never signed nor prioritised', () => {
    expect(serializeClearCookie('__Host-uid')).toStartWith('__Host-uid=; Max-Age=0;')
    const line = serializeResponseCookie(
      { name: 'a', value: undefined, options: { signed: true, priority: 'high' } as never },
      { path: '/', secure: true },
    ).line
    expect(line).toBe('a=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure')
    expect(() => serializeClearCookie('__Host-a', { path: '/x' })).toThrow(TypeError)
  })
})

describe('checkCookie (HttpResponse.withCookie at call time)', () => {
  it('checks what does not depend on the plugin', () => {
    expect(() => checkCookie('a b', 'x', {})).toThrow('Invalid cookie name')
    expect(() => checkCookie('a', 1 as never, {})).toThrow(TypeError)
    expect(() => checkCookie('a', 'x', { maxAge: 0.5 })).toThrow('maxAge')
    expect(() => checkCookie('a', 'x', { domain: 'a b' })).toThrow('invalid domain')
    expect(() => checkCookie('a', 'x', { path: 'x' })).toThrow('invalid path')
    expect(() => checkCookie('a', 'x'.repeat(5000), {})).toThrow(RangeError)
  })

  it('leaves the rules depending on the defaults to the serialisation', () => {
    expect(() => checkCookie('__Host-a', 'x', { secure: false })).not.toThrow()
    expect(() => checkCookie('a', 'x', { sameSite: 'none' })).not.toThrow()
    expect(() => checkCookie('a', undefined, { domain: 'example.com' })).not.toThrow()
  })
})

describe('parseSetCookie', () => {
  it('parses every attribute (case-insensitive) and decodes the value', () => {
    const line =
      'n=v%20w; max-age=3600; EXPIRES=Wed, 02 Jan 2030 03:04:05 GMT; Domain=.Example.com; path=/app; secure; HTTPONLY; samesite=None; Partitioned; Priority=HIGH'
    expect(parseSetCookie(line)).toEqual({
      name: 'n',
      value: 'v w',
      raw: line,
      maxAge: 3600,
      expires: new Date(Date.UTC(2030, 0, 2, 3, 4, 5)),
      domain: 'example.com',
      path: '/app',
      secure: true,
      httpOnly: true,
      sameSite: 'none',
      partitioned: true,
      priority: 'high',
    })
  })

  it('round-trips serializeCookie', () => {
    const line = serializeCookie('__Host-uid', 'a;b', { maxAge: 60 })
    expect(parseSetCookie(line)).toEqual({
      name: '__Host-uid',
      value: 'a;b',
      raw: line,
      maxAge: 60,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      partitioned: false,
    })
  })

  it('ignores unknown or malformed attributes and rejects lines without a name', () => {
    expect(parseSetCookie('a="q"; Max-Age=x; Expires=never; Path=rel; SameSite=weird; Foo=bar')).toEqual({
      name: 'a',
      value: 'q',
      raw: 'a="q"; Max-Age=x; Expires=never; Path=rel; SameSite=weird; Foo=bar',
      secure: false,
      httpOnly: false,
      partitioned: false,
    })
    expect(() => parseSetCookie('novalue')).toThrow(TypeError)
    expect(() => parseSetCookie('=x')).toThrow(TypeError)
  })

  it('parses a list by name (the last one wins)', () => {
    const cookies = parseSetCookies(['a=1', 'b=2', 'a=3', 'broken'])
    expect(Object.keys(cookies)).toEqual(['a', 'b'])
    expect(cookies['a']?.value).toBe('3')
    expect(parseSetCookies(undefined)).toEqual({})
    expect(parseSetCookies('x=1')['x']?.value).toBe('1')
  })
})

describe('CookieJar', () => {
  it('replaces entries of the same key in place, keeping insertion order', () => {
    const jar = new CookieJar<string>()
    jar.set('a', 'a1')
    jar.set('b', 'b1')
    jar.set('a', 'a2')
    expect(jar.values()).toEqual(['a2', 'b1'])
    expect(jar.entries()).toEqual([
      ['a', 'a2'],
      ['b', 'b1'],
    ])
    expect(jar.size).toBe(2)
  })
})
