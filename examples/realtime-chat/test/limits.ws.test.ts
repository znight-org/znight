import { WsServer } from '@znight/websocket'

import { MAX_ROOMS_PER_CONNECTION } from '../src/chat/chat.gateway.js'
import { MAX_TABS } from '../src/chat/connection-quota.guard.js'
import { MAX_HISTORY_ROOMS, MessageService } from '../src/chat/message.service.js'
import { BOB_KEY, createApp } from './support/app.js'
import { describe, expect, test as it } from 'bun:test'

const BOB = { name: 'bob', roles: [] }

describe('limits of the chat', () => {
  it(`keeps the history of the ${MAX_HISTORY_ROOMS} most recently active rooms`, () => {
    const messages = new MessageService()
    for (let i = 0; i <= MAX_HISTORY_ROOMS; i++) messages.post(BOB, { room: `r-${i}`, text: 'hi' })
    expect(messages.roomCount).toBe(MAX_HISTORY_ROOMS)
    expect(messages.history('r-0')).toEqual([]) // the least recently active room went first
    expect(messages.history(`r-${MAX_HISTORY_ROOMS}`)).toHaveLength(1)

    messages.post(BOB, { room: 'r-1', text: 'still here' }) // r-1 becomes the most recent room
    messages.post(BOB, { room: 'new', text: 'hi' })
    expect(messages.history('r-1')).toHaveLength(2)
    expect(messages.history('r-2')).toEqual([])
  })

  it(`lets a connection join at most ${MAX_ROOMS_PER_CONNECTION} rooms`, async () => {
    await using app = await createApp()
    await using bob = await app.connect('/chat', { headers: { 'x-api-key': BOB_KEY }, protocols: ['chat.v1'] })
    for (let i = 0; i < MAX_ROOMS_PER_CONNECTION; i++) await bob.request('room.join', { room: `r-${i}` })
    await expect(bob.request('room.join', { room: 'one-more' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await bob.request('room.join', { room: 'r-0' })).toEqual({ members: 1 }) // already a member
  })

  it(`holds at most ${MAX_TABS} tabs per user, even for concurrent handshakes`, async () => {
    await using app = await createApp()
    const headers = { 'x-api-key': BOB_KEY }
    const attempts = await Promise.allSettled(
      Array.from({ length: 2 * MAX_TABS }, () => app.connect('/chat', { headers, protocols: ['chat.v1'] })),
    )
    const connected = attempts.flatMap(attempt => (attempt.status === 'fulfilled' ? [attempt.value] : []))
    expect((app.get(WsServer) as WsServer).of('/chat').members('user:bob').size).toBe(MAX_TABS)
    // closing returns how each connection closed: the tabs over the quota were already closed with 4429
    const closes = await Promise.all(connected.map(tab => tab.close()))
    expect(closes.filter(info => info.code === 4429)).toHaveLength(connected.length - MAX_TABS)
  })
})
