import { WsHandshakeError } from '@znight/testing'

import { MAX_TABS } from '../src/chat/connection-quota.guard.js'
import { BOB_KEY, createApp, ticket } from './support/app.js'
import { describe, expect, test as it } from 'bun:test'

describe('handshakes', () => {
  it('are authenticated by the global AuthGuard (API key, or a single-use ticket)', async () => {
    await using app = await createApp()
    const refused = app.connect('/chat', { query: { ticket: 'forged' }, protocols: ['chat.v1'] })
    await expect(refused).rejects.toBeInstanceOf(WsHandshakeError)
    await expect(refused).rejects.toMatchObject({ status: 401 })

    const once = await ticket(app, BOB_KEY)
    await (await app.connect('/chat', { query: { ticket: once }, protocols: ['chat.v1'] })).close()
    await expect(app.connect('/chat', { query: { ticket: once }, protocols: ['chat.v1'] })).rejects.toMatchObject({
      status: 401,
    })
    // tickets are refused outside handshakes
    const http = await app.inject({ url: '/rooms', query: { ticket: await ticket(app, BOB_KEY) } })
    expect(http.status).toBe(401)
  })

  it('check the origin, the subprotocol and the per-user quota', async () => {
    await using app = await createApp()
    const headers = { 'x-api-key': BOB_KEY }
    await expect(
      app.connect('/chat', { headers, protocols: ['chat.v1'], origin: 'https://evil.example' }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(app.connect('/chat', { headers, protocols: ['chat.v2'] })).rejects.toMatchObject({ status: 400 })
    const tabs = []
    for (let index = 0; index < MAX_TABS; index++)
      tabs.push(await app.connect('/chat', { headers, protocols: ['chat.v1'] }))
    await expect(app.connect('/chat', { headers, protocols: ['chat.v1'] })).rejects.toMatchObject({ status: 429 })
    for (const tab of tabs) await tab.close()
  })

  it('answers 426 to a plain GET of a gateway path', async () => {
    await using app = await createApp()
    const response = await app.inject({ url: '/chat', headers: { 'x-api-key': BOB_KEY } })
    expect(response.status).toBe(426)
  })
})
