import type { NotesExport } from '../src/admin/admin.controller.js'

import { bearer, createTestApp, type LogEntry } from './support/app.js'
import { EXPORT_KEY, NEXT_EXPORT_KEY } from './support/fixtures.js'
import { mintToken } from './support/tokens.js'
import { describe, expect, test as it } from 'bun:test'

/** API keys (`ApiKeys`) and several strategies (`Authenticator`): bearer first, then the API key. */
describe('API keys', () => {
  it('authenticates the export client with either key of a rotation', async () => {
    await using app = await createTestApp()

    for (const key of [EXPORT_KEY, NEXT_EXPORT_KEY]) {
      const response = await app.inject({ url: '/admin/export', headers: { 'x-api-key': key } })
      expect(response.status).toBe(200)
      expect(response.headers['content-disposition']).toBe('attachment; filename="notes.json"')
      expect(response.json<NotesExport>()).toMatchObject({ notes: [] })
    }
    const me = await app.inject({ url: '/me', headers: { 'x-api-key': EXPORT_KEY } })
    expect(me.json()).toMatchObject({ id: 'export-client', roles: ['exporter'], via: 'api-key' })
  })

  it('answers 401 with every challenge for a wrong key, and logs the client address (never the key)', async () => {
    const logs: LogEntry[] = []
    await using app = await createTestApp({ logs })

    const response = await app.inject({
      url: '/admin/export',
      headers: { 'x-api-key': 'guessed-key', 'x-forwarded-for': '203.0.113.7' },
    })

    expect(response.status).toBe(401)
    expect(response.json()).toMatchObject({ message: 'Invalid API key' })
    expect(response.headers['www-authenticate']).toBe('Bearer realm="api", ApiKey header="x-api-key"')
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 40, msg: 'Invalid API key', ip: '203.0.113.7', route: '/admin/export' }),
    )
    expect(JSON.stringify(logs)).not.toContain('guessed-key')
  })

  it('lets the bearer token decide when a request carries both', async () => {
    await using app = await createTestApp()
    const token = await mintToken({ sub: 'u-editor', roles: ['editor'] })

    // the token applies first: the editor role does not open the export, the valid key is not tried
    const both = await app.inject({ url: '/admin/export', headers: { ...bearer(token), 'x-api-key': EXPORT_KEY } })
    expect(both.status).toBe(403)
  })
})
