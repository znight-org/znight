import type { ChatMessage } from '../src/chat/chat.protocol.js'

import { ALICE_KEY, BOB_KEY, createApp, ticket } from './support/app.js'
import { describe, expect, test as it } from 'bun:test'

describe('/chat', () => {
  it('members chat in a room: replies, presence and broadcasts', async () => {
    await using app = await createApp()
    await using alice = await app.connect('/chat', {
      query: { ticket: await ticket(app, ALICE_KEY) },
      protocols: ['chat.v1'],
    })
    await using bob = await app.connect('/chat', { headers: { 'x-api-key': BOB_KEY }, protocols: ['chat.v1'] })
    expect(alice.protocol).toBe('chat.v1')

    expect(await alice.request('room.join', { room: 'general' })).toEqual({ members: 1 })
    expect(await bob.request('room.join', { room: 'general' })).toEqual({ members: 2 })
    expect(await alice.next('presence.joined')).toEqual({ room: 'general', user: 'bob' })

    const sent = await alice.request<ChatMessage>('message.send', { room: 'general', text: ' hi ' })
    expect(sent).toMatchObject({ room: 'general', author: 'alice', text: 'hi' })
    expect(await bob.next('message.new')).toEqual(sent) // frames are buffered: no race
    expect(await alice.next('message.new')).toEqual(sent)

    const rooms = await app.inject({ url: '/rooms', headers: { 'x-api-key': BOB_KEY } })
    expect(rooms.json()).toEqual([{ room: 'general', members: 2 }])
    const history = await app.inject({ url: '/rooms/general/messages', headers: { 'x-api-key': BOB_KEY } })
    expect(history.json()).toEqual([sent])
  })

  it('answers errors with stable codes', async () => {
    await using app = await createApp()
    await using bob = await app.connect('/chat', { headers: { 'x-api-key': BOB_KEY }, protocols: ['chat.v1'] })
    await expect(bob.request('message.send', { room: 'general', text: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      details: [{ path: 'text', message: expect.any(String) }],
    })
    await expect(bob.request('message.send', { room: 'general', text: 'hi' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Join "general" first',
    })
    await expect(bob.request('nope')).rejects.toMatchObject({ code: 'UNKNOWN_EVENT' })
    expect(await bob.request('$ping')).toEqual({ t: expect.any(Number) })
    bob.send('room.join', { room: 'NOT VALID' }) // without id: the error comes as a $error event
    expect(await bob.next('$error')).toMatchObject({ event: 'room.join', code: 'BAD_REQUEST' })
  })

  it('lets moderators kick users (a message guard reading @Roles)', async () => {
    await using app = await createApp()
    await using alice = await app.connect('/chat', { headers: { 'x-api-key': ALICE_KEY }, protocols: ['chat.v1'] })
    await using bob = await app.connect('/chat', { headers: { 'x-api-key': BOB_KEY }, protocols: ['chat.v1'] })
    await bob.request('room.join', { room: 'general' })
    await expect(bob.request('room.kick', { room: 'general', user: 'alice' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await alice.request('room.kick', { room: 'general', user: 'bob' })
    expect(await bob.next('kicked')).toEqual({ room: 'general' })
    await expect(bob.request('message.send', { room: 'general', text: 'hi' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})
