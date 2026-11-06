import { ChatGateway } from '../src/chat/chat.gateway.js'
import { BOB_KEY, createApp } from './support/app.js'
import { describe, expect, test as it } from 'bun:test'

describe('shutdown', () => {
  it('closes every connection with 1001 and runs @OnDisconnect', async () => {
    const app = await createApp()
    const alice = await app.connect('/chat', { headers: { 'x-api-key': 'alice-key' }, protocols: ['chat.v1'] })
    const bob = await app.connect('/chat', { headers: { 'x-api-key': BOB_KEY }, protocols: ['chat.v1'] })
    await alice.request('room.join', { room: 'general' })
    await bob.request('room.join', { room: 'general' })
    expect(app.get(ChatGateway)).toBeInstanceOf(ChatGateway)
    await app.close()
    expect(await alice.closed).toEqual({ code: 1001, reason: 'Server shutting down' })
    expect(await bob.closed).toEqual({ code: 1001, reason: 'Server shutting down' })
  })
})
