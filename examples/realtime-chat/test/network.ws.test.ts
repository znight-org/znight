import type { HttpPlugin } from '@znight/http'

import { Application, silentLogger } from '@znight/core'
import { connectWebSocket } from '@znight/testing'

import { metadata } from '../src/.znight/container.generated.js'
import { plugins } from '../src/plugins.js'
import { BOB_KEY, TEST_CONFIG } from './support/app.js'
import { describe, expect, test as it } from 'bun:test'

describe('over the network', () => {
  it('serves /chat on the HTTP port (ws transport), with headers on the handshake', async () => {
    const app = await Application.create({
      metadata,
      logger: silentLogger,
      shutdown: { signals: false },
      plugins: plugins({ port: 0, config: TEST_CONFIG }),
    })
    await app.start()
    try {
      const port = app.getPlugin<HttpPlugin>('http')?.address?.port
      await using client = await connectWebSocket(`ws://127.0.0.1:${port}/chat`, {
        headers: { 'x-api-key': BOB_KEY },
        protocols: ['chat.v1'],
      })
      expect(client.protocol).toBe('chat.v1')
      expect(await client.request('room.join', { room: 'general' })).toEqual({ members: 1 })
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      expect(await health.json()).toEqual({ status: 'up', connections: 1 })
    } finally {
      await app.stop()
    }
  })
})
