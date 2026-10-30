import { bearer, createTestApp } from './support/app.js'
import { mintToken } from './support/tokens.js'
import { expect, test as it } from 'bun:test'

it('only editors create notes', async () => {
  await using app = await createTestApp()
  const note = { text: 'hi' }

  const anonymous = await app.inject({ method: 'POST', url: '/notes', body: note })
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers['www-authenticate']).toBe('Bearer realm="api", ApiKey header="x-api-key"')

  const reader = await mintToken({ sub: 'u-1', roles: ['reader'] })
  expect((await app.inject({ method: 'POST', url: '/notes', headers: bearer(reader), body: note })).status).toBe(403)

  const expired = await mintToken({ sub: 'u-1', roles: ['editor'], exp: Math.floor(Date.now() / 1000) - 60 })
  const rejected = await app.inject({ method: 'POST', url: '/notes', headers: bearer(expired), body: note })
  expect(rejected.status).toBe(401)
  expect(rejected.headers['www-authenticate']).toContain('error="invalid_token"')

  const editor = await mintToken({ sub: 'u-1', roles: ['editor'] })
  expect((await app.inject({ method: 'POST', url: '/notes', headers: bearer(editor), body: note })).status).toBe(201)
})
