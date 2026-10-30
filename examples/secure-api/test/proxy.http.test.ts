import type { Me } from '../src/auth/me.controller.js'

import { bearer, createTestApp } from './support/app.js'
import { mintToken } from './support/tokens.js'
import { describe, expect, test as it } from 'bun:test'

/**
 * `TRUSTED_PROXIES` (`trustProxy`): `ctx.ip` is the client behind the trusted proxies. `app.inject()`
 * requests come from 127.0.0.1, the `loopback` alias.
 */
describe('trusted proxies', () => {
  it('reads the client address from x-forwarded-for behind a trusted proxy', async () => {
    await using app = await createTestApp() // TRUSTED_PROXIES=loopback
    const headers = bearer(await mintToken({ sub: 'u-1' }))

    const direct = await app.inject({ url: '/me', headers })
    const proxied = await app.inject({ url: '/me', headers: { ...headers, 'x-forwarded-for': '203.0.113.7' } })
    // the rightmost untrusted hop: what a client puts on the left cannot choose its address
    const spoofed = await app.inject({
      url: '/me',
      headers: { ...headers, 'x-forwarded-for': '198.51.100.1, 203.0.113.7' },
    })

    expect(direct.json<Me>().ip).toBe('127.0.0.1')
    expect(proxied.json<Me>().ip).toBe('203.0.113.7')
    expect(spoofed.json<Me>().ip).toBe('203.0.113.7')
  })

  it('ignores x-forwarded-for without trusted proxies', async () => {
    await using app = await createTestApp({ env: { TRUSTED_PROXIES: '' } })
    const headers = { ...bearer(await mintToken({ sub: 'u-1' })), 'x-forwarded-for': '203.0.113.7' }

    expect((await app.inject({ url: '/me', headers })).json<Me>().ip).toBe('127.0.0.1')
  })
})
