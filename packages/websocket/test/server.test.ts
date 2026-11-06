import type { ChannelMember } from '../src/rooms.ts'

import { RoomRegistry } from '../src/rooms.ts'
import { WsServer } from '../src/server.ts'
import { describe, expect, it } from 'bun:test'

class ChatGateway {}

function member(id: string, frames: (string | Uint8Array)[]): ChannelMember {
  return { id, roomSet: new Set(), sendFrame: frame => frames.push(frame), close: () => undefined }
}

interface Events {
  hello: string
}

describe('WsServer', () => {
  it('gives lazy handles on gateways by class or path', () => {
    const server = new WsServer()
    const byClass = server.of<Events>(ChatGateway)
    expect(() => byClass.size).toThrow(TypeError)

    // biome-ignore lint/suspicious/noExplicitAny: the registry holds connections; fakes are enough here
    const rooms = new RoomRegistry<any>()
    server.register({ type: ChatGateway, declaredPath: '/chat', path: '/api/chat', rooms })
    const frames: (string | Uint8Array)[] = []
    const a = member('a', frames)
    rooms.add(a)
    rooms.add(member('b', []))
    rooms.join(a, 'lobby')

    expect(byClass.path).toBe('/api/chat')
    expect(server.of('/chat').size).toBe(2)
    expect(server.connections).toBe(2)
    expect(byClass.connection('a') as unknown).toBe(a)
    expect([...byClass.members('lobby')] as unknown[]).toEqual([a])
    expect(byClass.rooms()).toEqual(new Map([['lobby', 1]]))
    byClass.to('lobby').emit('hello', 'room')
    byClass.except('b').emit('hello', 'all')
    expect(frames).toEqual(['{"event":"hello","data":"room"}', '{"event":"hello","data":"all"}'])
    expect(() => server.of('/nope').size).toThrow('WsServer.of("/nope")')
  })
})
