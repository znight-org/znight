/** Signed cookies (RFC 0006 §4.5): HMAC-SHA256 bound to the name, rotation, verification, secrets. */
import crypto, { createHmac } from 'node:crypto'

import { signValue, verifySigned } from '../src/cookie-settings.ts'
import { CookieSigner, checkSecrets } from '../src/cookie-signer.ts'
import { describe, expect, it, spyOn } from 'bun:test'

const CURRENT = 'c'.repeat(32)
const NEXT = new Uint8Array(32).fill(7)

describe('CookieSigner', () => {
  it('signs "<encoded>.<base64url(HMAC-SHA256(secret, name=encoded))>"', () => {
    const signer = new CookieSigner([CURRENT])
    const wire = signer.sign('sid', 'abc')
    const expected = createHmac('sha256', CURRENT).update('sid=abc').digest('base64url')
    expect(wire).toBe(`abc.${expected}`)
    expect(expected).toHaveLength(43)
    expect(signer.verify('sid', wire)).toBe('abc')
  })

  it('verifies with every secret and signs with the first (rotation)', () => {
    const old = new CookieSigner([CURRENT])
    const rotated = new CookieSigner([NEXT, CURRENT])
    const legacy = old.sign('sid', 'v')
    expect(rotated.verify('sid', legacy)).toBe('v')
    const fresh = rotated.sign('sid', 'v')
    expect(fresh).not.toBe(legacy)
    expect(old.verify('sid', fresh)).toBeUndefined()
    // the retired key no longer verifies once dropped
    expect(new CookieSigner([NEXT]).verify('sid', legacy)).toBeUndefined()
  })

  it('rejects tampered values and signatures, wrong lengths and foreign alphabets', () => {
    const signer = new CookieSigner([CURRENT])
    const wire = signer.sign('sid', 'abc')
    const signature = wire.slice(4)
    expect(signer.verify('sid', `abd.${signature}`)).toBeUndefined()
    expect(signer.verify('sid', `abc.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`)).toBeUndefined()
    expect(signer.verify('sid', `abc.${signature}x`)).toBeUndefined()
    expect(signer.verify('sid', `abc.${signature.slice(1)}`)).toBeUndefined()
    expect(signer.verify('sid', `abc.${'é'.repeat(43)}`)).toBeUndefined()
    expect(signer.verify('sid', `abc.${'+'.repeat(43)}`)).toBeUndefined()
    expect(signer.verify('sid', 'abc')).toBeUndefined()
    expect(signer.verify('sid', '')).toBeUndefined()
  })

  it('accepts values containing dots (split at the last one)', () => {
    const signer = new CookieSigner([CURRENT])
    expect(signer.verify('jwt', signer.sign('jwt', 'a.b.c'))).toBe('a.b.c')
  })

  it('binds the signature to the name', () => {
    const signer = new CookieSigner([CURRENT])
    const wire = signer.sign('a', 'v')
    expect(signer.verify('b', wire)).toBeUndefined()
    expect(signer.sign('sid', 'v')).not.toBe(signer.sign('__Host-sid', 'v'))
  })

  it('compares in constant time, with equal lengths only', () => {
    const spy = spyOn(crypto, 'timingSafeEqual')
    try {
      const signer = new CookieSigner([NEXT, CURRENT])
      const wire = signer.sign('sid', 'x')
      signer.verify('sid', `${wire.slice(0, -1)}A`)
      signer.verify('sid', 'x.short')
      expect(spy).toHaveBeenCalledTimes(2) // one per secret, the short signature never reaches it
      for (const [a, b] of spy.mock.calls as unknown as [Buffer, Buffer][]) expect(a.byteLength).toBe(b.byteLength)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('verifySigned / signValue', () => {
  it('re-encodes the parsed (decoded) value before checking the MAC', () => {
    const signer = new CookieSigner([CURRENT])
    const wire = signValue(signer, 'n', 'a b;é')
    expect(wire.startsWith('a%20b%3B%C3%A9.')).toBe(true)
    expect(verifySigned(signer, 'n', decodeURIComponent(wire))).toBe('a b;é')
    expect(verifySigned(signer, 'n', undefined)).toBeUndefined()
    expect(verifySigned(signer, 'n', 'nodot')).toBeUndefined()
  })
})

describe('checkSecrets', () => {
  it('normalises one secret or a list', () => {
    expect(checkSecrets(CURRENT)).toEqual({ secrets: [CURRENT] })
    expect(checkSecrets([NEXT, CURRENT])).toEqual({ secrets: [NEXT, CURRENT] })
  })

  it('explains invalid secrets without echoing them', () => {
    expect(checkSecrets([])).toEqual({ problem: 'at least one secret' })
    expect(checkSecrets('short')).toMatchObject({
      problem: expect.stringContaining('at least 32 bytes (secret #0 has 5)'),
    })
    expect(checkSecrets([CURRENT, 'é'.repeat(15)])).toMatchObject({ problem: expect.stringContaining('#1 has 30') })
    expect(checkSecrets([CURRENT, CURRENT])).toEqual({ problem: 'distinct secrets (secret #1 is a duplicate)' })
    expect(checkSecrets([42])).toMatchObject({ problem: expect.stringContaining('strings or Uint8Arrays') })
    for (const result of [checkSecrets('short'), checkSecrets([CURRENT, CURRENT])]) {
      expect(JSON.stringify(result)).not.toContain('short"')
      expect(JSON.stringify(result)).not.toContain(CURRENT)
    }
  })

  it('counts UTF-8 bytes', () => {
    expect(checkSecrets('é'.repeat(16))).toEqual({ secrets: ['é'.repeat(16)] })
  })
})
