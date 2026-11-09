import type { HttpContext } from '@znight/http'
import type { ConnectionDriver, ConnectionLimits, WsCloseInfo } from '../src/connection.ts'
import type { SocketEvents, TransportSocket } from '../src/transport.ts'

import { WsClosedError, WsConnectionImpl } from '../src/connection.ts'
import { TokenBucket } from '../src/rate-limit.ts'
import { RoomRegistry } from '../src/rooms.ts'
import { MemoryClient, memoryTransport } from '../src/transports/memory.ts'
import { describe, expect, it } from 'bun:test'

const LIMITS: ConnectionLimits = {
  maxPayload: 64,
  maxPendingMessages: 4,
  concurrency: 1,
  backpressureLimit: 1024,
  onBackpressure: 'close',
  closeTimeoutMs: 1000,
}

interface Recorded {
  readonly log: string[]
  readonly closes: WsCloseInfo[]
  release(): void
}

function driver(options: { connect?: () => Promise<void>; handle?: (frame: string) => Promise<void> } = {}) {
  const log: string[] = []
  const closes: WsCloseInfo[] = []
  let gate: PromiseWithResolvers<void> | undefined
  const recorded: Recorded = { log, closes, release: () => gate?.resolve() }
  const impl: ConnectionDriver = {
    connect: async () => {
      log.push('connect')
      await options.connect?.()
    },
    dispatch: async (conn, frame) => {
      log.push(`start:${String(frame)}`)
      if (frame === 'slow') {
        gate = Promise.withResolvers()
        await gate.promise
      }
      await options.handle?.(String(frame))
      conn.send(`echo:${String(frame)}`)
      log.push(`end:${String(frame)}`)
    },
    rateLimited: (conn, frame) => conn.send(`limited:${String(frame)}`),
    connectFailure: () => ({ code: 1011, reason: 'connect failed' }),
    disconnect: () => {
      log.push('disconnect')
      return Promise.resolve()
    },
    closed: (_conn, info) => closes.push(info),
  }
  return { impl, recorded }
}

const handshake = { requestId: 'req-1', params: { room: 'a' } } as unknown as HttpContext

async function open(impl: ConnectionDriver, limits: ConnectionLimits = LIMITS) {
  const rooms = new RoomRegistry<WsConnectionImpl>()
  const conn = new WsConnectionImpl({
    id: 'c1',
    gateway: '/chat',
    handshake,
    protocol: '',
    limits,
    rooms,
    driver: impl,
  })
  const client = new MemoryClient()
  const socket = await memoryTransport().accept(
    { kind: 'memory', peer: client },
    { protocol: '', headers: {}, maxPayload: 64 },
    conn.socketEvents(),
  )
  conn.start(socket)
  return { conn, client, rooms }
}

describe('WsConnectionImpl', () => {
  it('runs @OnConnect first, then messages in order, then @OnDisconnect on a client close', async () => {
    const { impl, recorded } = driver()
    const { conn, client } = await open(impl)
    client.send('a')
    client.send('b')
    await Bun.sleep(1)
    expect(client.received).toEqual(['echo:a', 'echo:b'])
    expect(conn.params).toEqual({ room: 'a' })
    client.close(4000, 'bye')
    const info = await conn.finished
    expect(info).toEqual({ code: 4000, reason: 'bye', initiator: 'client' })
    expect(recorded.log).toEqual(['connect', 'start:a', 'end:a', 'start:b', 'end:b', 'disconnect'])
    expect(conn.readyState).toBe('closed')
    expect(conn.signal.aborted).toBe(true)
  })

  it('closes with the code of a failed @OnConnect and skips @OnDisconnect', async () => {
    const { impl, recorded } = driver({ connect: () => Promise.reject(new Error('no')) })
    const { conn, client } = await open(impl)
    expect(await conn.finished).toEqual({ code: 1011, reason: 'connect failed', initiator: 'server' })
    expect(client.closed?.code).toBe(1011)
    expect(recorded.log).toEqual(['connect'])
  })

  it('closes 1009 above maxPayload', async () => {
    const { impl } = driver()
    const { conn, client } = await open(impl)
    client.send('x'.repeat(65))
    expect((await conn.finished).code).toBe(1009)
  })

  it('pauses reading at maxPendingMessages and resumes at half', async () => {
    const { impl, recorded } = driver()
    const { conn, client } = await open(impl)
    await Bun.sleep(1)
    client.send('slow')
    await Bun.sleep(1)
    for (const frame of ['1', '2', '3', '4', '5']) client.send(frame)
    await Bun.sleep(1)
    // the memory transport queues while paused: only 4 reached the connection
    expect(recorded.log.filter(line => line.startsWith('start'))).toEqual(['start:slow'])
    recorded.release()
    await Bun.sleep(5)
    expect(client.received).toEqual(['echo:slow', 'echo:1', 'echo:2', 'echo:3', 'echo:4', 'echo:5'])
    conn.close()
    await conn.finished
  })

  it('applies the rate limit', async () => {
    const { impl } = driver()
    const { conn, client } = await open(impl, {
      ...LIMITS,
      rateLimit: { bucket: new TokenBucket(1, 60_000), onLimit: 'reject' },
    })
    await Bun.sleep(1)
    client.send('a')
    client.send('b')
    await Bun.sleep(1)
    expect(client.received.toSorted()).toEqual(['echo:a', 'limited:b'])
    conn.close()
    await conn.finished
  })

  it('closes 1013 or drops above the backpressure limit', async () => {
    const { impl } = driver()
    const { conn } = await open(impl, { ...LIMITS, backpressureLimit: 4 })
    expect(conn.send('12345')).toBe('dropped')
    expect(await conn.finished).toEqual({ code: 1013, reason: 'Slow consumer', initiator: 'backpressure' })

    const dropping = await open(driver().impl, { ...LIMITS, backpressureLimit: 4, onBackpressure: 'drop' })
    expect(dropping.conn.send('12345')).toBe('dropped')
    expect(dropping.conn.send('123')).toBe('sent')
    expect(dropping.conn.readyState).toBe('open')
  })

  it('joins rooms, broadcasts to the others and leaves on close', async () => {
    const { impl } = driver()
    const { conn, rooms } = await open(impl)
    conn.join(['lobby', 'vip'])
    expect([...conn.rooms]).toEqual(['lobby', 'vip'])
    expect(rooms.rooms().get('lobby')).toBe(1)
    conn.to('lobby').send('nobody else')
    expect(conn.emit('x', 1)).toBe('sent')
    conn.close()
    await conn.finished
    expect(rooms.rooms().size).toBe(0)
    expect(conn.send('late')).toBe('dropped')
    expect(conn.drained()).rejects.toBeInstanceOf(WsClosedError)
  })
})

describe('heartbeat', () => {
  it('pings live connections and terminates silent ones at the next tick', async () => {
    const { impl, recorded } = driver()
    const pings: string[] = []
    let events: { close(code: number, reason: string): void; pong(): void } | undefined
    const conn = new WsConnectionImpl({
      id: 'c1',
      gateway: '/chat',
      handshake,
      protocol: '',
      limits: LIMITS,
      rooms: new RoomRegistry(),
      driver: impl,
    })
    const socketEvents = conn.socketEvents()
    events = socketEvents
    conn.start({
      bufferedAmount: 0,
      extensions: '',
      send: () => 'sent',
      ping: () => pings.push('ping'),
      pause: () => true,
      resume: () => undefined,
      close: () => undefined,
      terminate: () => events?.close(1006, ''),
    })
    await Bun.sleep(1)
    conn.heartbeat()
    events.pong()
    conn.heartbeat()
    expect(pings).toEqual(['ping', 'ping'])
    conn.heartbeat() // no pong since the last tick
    await conn.finished
    expect(recorded.closes).toEqual([{ code: 1006, reason: '', initiator: 'heartbeat' }])
  })

  it('resolves drained() once the buffer falls below limit / 4, even when the transport reports no drain there', async () => {
    const { impl } = driver()
    const conn = new WsConnectionImpl({
      id: 'c2',
      gateway: '/chat',
      handshake,
      protocol: '',
      limits: LIMITS,
      rooms: new RoomRegistry<WsConnectionImpl>(),
      driver: impl,
    })
    let events: SocketEvents | undefined
    // a transport that only reports drains at its own limit (ws below the full limit, Bun after a -1 send)
    const socket: TransportSocket & { buffered: number } = {
      buffered: 0,
      get bufferedAmount() {
        return this.buffered
      },
      extensions: '',
      send: () => 'sent',
      ping: () => undefined,
      pause: () => true,
      resume: () => undefined,
      close: (code, reason) => events?.close(code, reason),
      terminate: () => events?.close(1006, ''),
    }
    events = conn.socketEvents()
    conn.start(socket)
    // between limit / 4 (256) and the limit (1024): parked
    socket.buffered = 600
    let resolved = false
    const waiting = conn.drained().then(() => {
      resolved = true
    })
    // a drain between limit / 4 and the limit leaves it parked
    socket.buffered = 400
    events.drain()
    await Bun.sleep(20)
    expect(resolved).toBe(false)
    // the buffer empties without any further drain event
    socket.buffered = 100
    await Promise.race([waiting, Bun.sleep(200)])
    expect(resolved).toBe(true)
    conn.close()
    await conn.finished
  })
})

describe('close frames', () => {
  it('truncates a reason over 123 bytes on a code point boundary', async () => {
    const { impl } = driver()
    impl.connect = () => Promise.reject(new Error('no'))
    impl.connectFailure = () => ({ code: 4404, reason: `Unknown symbol ${'é'.repeat(100)}` })
    const { conn, client } = await open(impl)
    const info = await conn.finished
    expect(info.code).toBe(4404)
    expect(info.reason).toBe(`Unknown symbol ${'é'.repeat(54)}`)
    expect(client.closed).toEqual({ code: 4404, reason: info.reason })
  })

  it('replaces a close code a server may not send with 1011', async () => {
    const { conn, client } = await open(driver().impl)
    conn.close(1006, 'abnormal')
    expect(await conn.finished).toEqual({ code: 1011, reason: 'abnormal', initiator: 'server' })
    expect(client.closed?.code).toBe(1011)
  })

  it('terminates the socket when the transport refuses the close frame', async () => {
    const conn = new WsConnectionImpl({
      id: 'c3',
      gateway: '/chat',
      handshake,
      protocol: '',
      limits: LIMITS,
      rooms: new RoomRegistry<WsConnectionImpl>(),
      driver: driver().impl,
    })
    const events = conn.socketEvents()
    const calls: string[] = []
    conn.start({
      bufferedAmount: 0,
      extensions: '',
      send: () => 'sent',
      ping: () => undefined,
      pause: () => true,
      resume: () => undefined,
      close: () => {
        calls.push('close')
        throw new RangeError('refused')
      },
      terminate: () => {
        calls.push('terminate')
        events.close(1006, '')
      },
    })
    await Bun.sleep(1)
    expect(() => conn.close(4000, 'bye')).not.toThrow()
    expect(await conn.finished).toEqual({ code: 4000, reason: 'bye', initiator: 'server' })
    expect(calls).toEqual(['close', 'terminate'])
  })
})
