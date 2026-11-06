import { ALICE_KEY, BOB_KEY, createApp } from './support/app.js'
import { describe, expect, test as it } from 'bun:test'

describe('/rooms/:room/cursor (one gateway instance per connection)', () => {
  it('relays cursors to the other members of the room and keeps per-connection state', async () => {
    await using app = await createApp()
    await using alice = await app.connect('/rooms/general/cursor', { headers: { 'x-api-key': ALICE_KEY } })
    await using bob = await app.connect('/rooms/general/cursor', { headers: { 'x-api-key': BOB_KEY } })
    await using elsewhere = await app.connect('/rooms/other/cursor', { headers: { 'x-api-key': BOB_KEY } })
    alice.send('move', { x: 0.25, y: 0.5 })
    alice.send('move', { x: 0.3, y: 0.5 })
    expect(await bob.next('cursor')).toEqual({ user: 'alice', x: 0.25, y: 0.5 })
    expect(await bob.next('cursor')).toEqual({ user: 'alice', x: 0.3, y: 0.5 })
    expect(await alice.request('stats')).toEqual({ moves: 2 })
    expect(await bob.request('stats')).toEqual({ moves: 0 })
    await expect(elsewhere.next('cursor', { timeoutMs: 50 })).rejects.toThrow('Timed out')
  })
})
