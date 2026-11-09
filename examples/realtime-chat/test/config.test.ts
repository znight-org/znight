import { inline } from '@znight/config'

import { ALICE_KEY, createApp } from './support/app.js'
import { describe, expect, test as it } from 'bun:test'

describe('API keys', () => {
  it('refuses to boot without CHAT_KEYS (no built-in keys)', async () => {
    await expect(createApp({ config: [inline({})] })).rejects.toMatchObject({
      code: 'ZNIGHT006',
      message: expect.stringContaining('CHAT_KEYS'),
    })
  })

  it('accepts only the configured keys', async () => {
    await using app = await createApp({ config: [inline({ CHAT_KEYS: 'carol:carol-key:moderator' })] })
    const rejected = await app.inject({ method: 'POST', url: '/ws/tickets', headers: { 'x-api-key': ALICE_KEY } })
    expect(rejected.status).toBe(401)
    const accepted = await app.inject({ method: 'POST', url: '/ws/tickets', headers: { 'x-api-key': 'carol-key' } })
    expect(accepted.status).toBe(201)
  })
})
