/** `@znight/websocket/testing`: the fakes record what the code under test does. */
import { WsServer } from '../src/index.ts'
import { createTestConnection, createTestServer } from '../src/testing/index.ts'
import { describe, expect, it } from 'bun:test'

interface ChatEvents {
  'message.new': { readonly text: string }
}

class ChatGateway {}

describe('websocket testing fakes', () => {
  it('createTestServer records broadcasts by gateway path', () => {
    const server = createTestServer({ paths: [[ChatGateway, '/chat']] })
    expect(server).toBeInstanceOf(WsServer)
    const chat = server.of<ChatEvents>(ChatGateway)
    chat.to('general').except('c1').emit('message.new', { text: 'hi' })
    server.of('/feed').send('raw')
    chat.to(['a', 'b']).exceptRoom('muted').leave('a')
    expect(chat.members('general').size).toBe(0)
    expect(server.broadcasts).toEqual([
      { gateway: '/chat', rooms: ['general'], except: ['c1'], event: 'message.new', data: { text: 'hi' } },
      { gateway: '/feed', rooms: [], except: [], frame: 'raw' },
      { gateway: '/chat', rooms: ['a', 'b'], except: [], exceptRooms: ['muted'], action: 'leave', room: 'a' },
    ])
  })

  it('createTestConnection records frames, rooms and closes', () => {
    const conn = createTestConnection<{ user: string }, ChatEvents>({
      id: 'c1',
      gateway: '/chat',
      data: { user: 'alice' },
      rooms: ['general'],
      params: { room: 'general' },
    })
    expect(conn.data.user).toBe('alice')
    expect(conn.params['room']).toBe('general')
    expect(conn.emit('message.new', { text: 'hi' })).toBe('sent')
    conn.join(['a', 'b'])
    conn.leave('a')
    conn.to('general').emit('message.new', { text: 'all' })
    expect([...conn.rooms]).toEqual(['general', 'b'])
    expect(conn.emitted).toEqual([{ event: 'message.new', data: { text: 'hi' } }])
    expect(conn.broadcasts).toEqual([
      { gateway: '/chat', rooms: ['general'], except: ['c1'], event: 'message.new', data: { text: 'all' } },
    ])
    conn.close(4000, 'bye')
    expect(conn.readyState).toBe('closed')
    expect(conn.signal.aborted).toBe(true)
    expect(conn.closeInfo).toEqual({ code: 4000, reason: 'bye', initiator: 'server' })
    expect(conn.send('late')).toBe('dropped')
  })
})
