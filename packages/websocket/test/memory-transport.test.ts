import type { SocketEvents } from '../src/index.ts'

import { MemoryClient, memoryTransport } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

function recorder(): SocketEvents & { readonly log: string[] } {
  const log: string[] = []
  return {
    log,
    message: (frame, binary) => log.push(`message:${binary ? 'binary' : String(frame)}`),
    pong: () => log.push('pong'),
    drain: () => log.push('drain'),
    close: (code, reason) => log.push(`close:${code}:${reason}`),
  }
}

const init = { protocol: 'chat.v1', headers: {}, maxPayload: 1024 }

describe('memory transport', () => {
  it('carries frames both ways and closes from either side', async () => {
    const transport = memoryTransport()
    const client = new MemoryClient()
    const events = recorder()
    const socket = await transport.accept({ kind: 'memory', peer: client }, init, events)
    expect(client.open).toBe(true)
    expect(client.protocol).toBe('chat.v1')

    client.send('hello')
    client.send(new Uint8Array([1]))
    expect(socket.send('{"event":"a"}', false)).toBe('sent')
    expect(client.received).toEqual(['{"event":"a"}'])

    client.close(4000, 'bye')
    expect(events.log).toEqual(['message:hello', 'message:binary', 'close:4000:bye'])
    expect(client.closed).toEqual({ code: 4000, reason: 'bye' })
    expect(socket.send('late', false)).toBe('dropped')
  })

  it('queues inbound frames while paused', async () => {
    const client = new MemoryClient()
    const events = recorder()
    const socket = await memoryTransport().accept({ kind: 'memory', peer: client }, init, events)
    expect(socket.pause()).toBe(true)
    client.send('one')
    client.send('two')
    expect(events.log).toEqual([])
    socket.resume()
    expect(events.log).toEqual(['message:one', 'message:two'])
  })

  it('terminates every socket when closed and refuses foreign peers', async () => {
    const transport = memoryTransport()
    const client = new MemoryClient()
    const events = recorder()
    await transport.accept({ kind: 'memory', peer: client }, init, events)
    await transport.close()
    expect(client.closed).toEqual({ code: 1006, reason: '' })
    expect(events.log).toEqual(['close:1006:'])
    expect(() => transport.accept({ kind: 'memory', peer: {} }, init, recorder())).toThrow('MemoryClient')
  })
})
