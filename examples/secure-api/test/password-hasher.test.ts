import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { PasswordHasher } from '../src/security/password-hasher.js'
import { legacyHash } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

const PASSWORD = 'correct horse battery staple'

async function createHasher(): Promise<PasswordHasher> {
  return (await TestBed.create(PasswordHasher, { metadata })).instance
}

describe('PasswordHasher', () => {
  it('hashes into a PHC string with the OWASP parameters and a random salt', async () => {
    const hasher = await createHasher()

    const first = await hasher.hash(PASSWORD)
    const second = await hasher.hash(PASSWORD)

    expect(first).toMatch(/^\$scrypt\$ln=17,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/) // 16-byte salt, 32-byte key
    expect(second).not.toBe(first)
  })

  it('verifies the password, and only it', async () => {
    const hasher = await createHasher()
    const stored = await hasher.hash(PASSWORD)

    expect(await hasher.verify(PASSWORD, stored)).toBe(true)
    expect(await hasher.verify('correct horse battery stapler', stored)).toBe(false)
    expect(await hasher.verify('', stored)).toBe(false)
  })

  it('normalises Unicode: the same password typed on another keyboard matches', async () => {
    const hasher = await createHasher()
    const stored = await hasher.hash('café') // é, one code point

    expect(await hasher.verify('café', stored)).toBe(true) // e + combining acute accent
  })

  it('verifies hashes made with older parameters, and asks for a rehash', async () => {
    const hasher = await createHasher()
    const legacy = legacyHash(PASSWORD, 14)

    expect(await hasher.verify(PASSWORD, legacy)).toBe(true)
    expect(hasher.needsRehash(legacy)).toBe(true)
    expect(hasher.needsRehash(await hasher.hash(PASSWORD))).toBe(false)
  })

  it('refuses malformed hashes and absurd parameters instead of running them', async () => {
    const hasher = await createHasher()
    const valid = await hasher.hash(PASSWORD)
    const [, , , salt, hash] = valid.split('$')

    const refused = [
      '',
      'plain-text-password',
      `$argon2id$v=19$m=65536,t=3,p=4$${salt}$${hash}`,
      `$scrypt$ln=30,r=8,p=1$${salt}$${hash}`, // 128 GiB
      `$scrypt$ln=17,r=99,p=1$${salt}$${hash}`, // 1.5 GiB
      `$scrypt$ln=17,r=8,p=99$${salt}$${hash}`, // 99 passes
      `$scrypt$ln=0,r=8,p=1$${salt}$${hash}`, // N = 1: scrypt would throw
      `$scrypt$ln=17,r=8,p=1$${salt}$${hash?.slice(0, 20)}`, // truncated key
    ]
    for (const stored of refused) {
      expect(await hasher.verify(PASSWORD, stored)).toBe(false)
      expect(hasher.needsRehash(stored)).toBe(true)
    }
  })

  it('runs at most 4 hashes at once, the others wait for a slot', async () => {
    const hasher = await createHasher()

    const hashes = Array.from({ length: 6 }, (_, i) => hasher.hash(`${PASSWORD} ${i}`))

    expect(hasher.stats).toEqual({ running: 4, waiting: 2 })
    expect(new Set(await Promise.all(hashes)).size).toBe(6)
    expect(hasher.stats).toEqual({ running: 0, waiting: 0 })
  })
})
