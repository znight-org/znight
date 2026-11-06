import type { HttpContext } from '@znight/http'
import type { ConnectionLimits } from '../src/connection.ts'
import type { DispatcherOptions, HandlerPlan } from '../src/dispatcher.ts'
import type { GatewayDefinition, WsHandlerDefinition } from '../src/metadata.ts'

import { ForbiddenException } from '@znight/http'

import { WsConnectionImpl } from '../src/connection.ts'
import { connectFailureCode, GatewayDispatcher } from '../src/dispatcher.ts'
import { WsException, WsValidationException } from '../src/exceptions.ts'
import { RoomRegistry } from '../src/rooms.ts'
import { MemoryClient, memoryTransport } from '../src/transports/memory.ts'
import { describe, expect, it } from 'bun:test'

const LIMITS: ConnectionLimits = {
  maxPayload: 1024,
  maxPendingMessages: 32,
  concurrency: 1,
  backpressureLimit: 1024 * 1024,
  onBackpressure: 'close',
  closeTimeoutMs: 1000,
}

function handler(
  method: string,
  event: string | undefined,
  invoke: WsHandlerDefinition['invoke'],
): WsHandlerDefinition {
  return { method, ...(event === undefined ? {} : { event }), meta: {}, guards: [], params: [], invoke }
}

class Gateway {
  readonly log: string[] = []
}

async function connect(
  handlers: readonly WsHandlerDefinition[],
  extra: Partial<DispatcherOptions> & {
    readonly protocol?: 'events' | 'raw'
    readonly guards?: HandlerPlan['guards']
  } = {},
) {
  const gateway = new Gateway()
  const errors: string[] = []
  const definition: GatewayDefinition = {
    token: 'src/chat.gateway.ts#ChatGateway',
    path: '/chat',
    protocol: extra.protocol ?? 'events',
    meta: {},
    handshakeGuards: [],
    messageGuards: [],
    onConnect: { method: 'connected', invoke: (g: Gateway) => g.log.push('connected') },
    onDisconnect: { method: 'gone', invoke: (g: Gateway) => g.log.push('gone') },
    handlers,
    ...extra.definition,
  }
  const dispatcher = new GatewayDispatcher({
    definition,
    path: '/api/chat',
    handlers: handlers.map(h => ({ definition: h, guards: extra.guards ?? [], meta: { scope: 'chat' } })),
    instance: () => gateway,
    handlerTimeoutMs: 50,
    exposeErrors: false,
    logError: message => errors.push(message),
    closed: () => undefined,
    ...extra,
  })
  const conn = new WsConnectionImpl({
    id: 'c1',
    gateway: '/api/chat',
    handshake: { requestId: 'r1', params: {} } as unknown as HttpContext,
    protocol: '',
    limits: LIMITS,
    rooms: new RoomRegistry(),
    driver: dispatcher,
  })
  const client = new MemoryClient()
  conn.start(
    await memoryTransport().accept(
      { kind: 'memory', peer: client },
      { protocol: '', headers: {}, maxPayload: 1024 },
      conn.socketEvents(),
    ),
  )
  const received = async () => {
    await Bun.sleep(5)
    return client.received.map(frame => JSON.parse(String(frame)) as unknown)
  }
  return { gateway, client, conn, errors, received }
}

describe('GatewayDispatcher', () => {
  it('routes events, replies to ids and answers $ping', async () => {
    const { client, received, gateway, conn } = await connect([
      handler('join', 'room.join', (_g, m) => ({ room: m.data, path: m.route.path, meta: m.route.meta })),
      handler('fire', 'fire', () => 'ignored'),
    ])
    client.send('{"event":"room.join","data":"lobby","id":1}')
    client.send('{"event":"fire","data":1}')
    client.send('{"event":"$ping","id":"p"}')
    const frames = await received()
    expect(frames[0]).toEqual({ id: 1, data: { room: 'lobby', path: '/api/chat', meta: { scope: 'chat' } } })
    expect(frames[1]).toMatchObject({ id: 'p', data: { t: expect.any(Number) } })
    expect(frames).toHaveLength(2)
    conn.close()
    await conn.finished
    expect(gateway.log).toEqual(['connected', 'gone'])
  })

  it('answers unknown events, bad frames, guards and errors', async () => {
    const { client, received, errors } = await connect(
      [
        handler('denied', 'denied', () => 1),
        handler('bad', 'bad', () => {
          throw new WsValidationException([{ path: 'room', message: 'Required' }])
        }),
        handler('http', 'http', () => {
          throw new ForbiddenException('No')
        }),
        handler('boom', 'boom', () => {
          throw new Error('secret')
        }),
        handler('slow', 'slow', () => Bun.sleep(200)),
      ],
      { guards: [{ canActivate: ctx => ctx.event !== 'denied' }] },
    )
    for (const frame of [
      '{"event":"nope","id":1}',
      'not json',
      '{"event":"denied","id":2}',
      '{"event":"bad"}',
      '{"event":"http","id":3}',
      '{"event":"boom","id":4}',
      '{"event":"slow","id":5}',
    ]) {
      client.send(frame)
    }
    await Bun.sleep(80)
    expect(await received()).toEqual([
      { id: 1, error: { code: 'UNKNOWN_EVENT', message: 'Unknown event "nope"' } },
      { event: '$error', data: { code: 'BAD_FRAME', message: 'The frame is not valid JSON' } },
      { id: 2, error: { code: 'FORBIDDEN', message: 'Forbidden' } },
      {
        event: '$error',
        data: {
          event: 'bad',
          code: 'BAD_REQUEST',
          message: 'Invalid payload',
          details: [{ path: 'room', message: 'Required' }],
        },
      },
      { id: 3, error: { code: 'FORBIDDEN', message: 'No' } },
      { id: 4, error: { code: 'INTERNAL', message: 'Internal error' } },
      { id: 5, error: { code: 'TIMEOUT', message: 'The handler timed out' } },
    ])
    expect(errors).toEqual(['Handler boom failed'])
  })

  it('passes frames to the default handler of a raw gateway and closes on WsException close', async () => {
    const seen: unknown[] = []
    const { client, conn } = await connect(
      [
        handler('any', undefined, (_g, m) => {
          seen.push(m.data)
          if (m.data === 'quit') throw new WsException('BYE', 'bye', undefined, { close: 4001 })
        }),
      ],
      { protocol: 'raw' },
    )
    client.send('hello')
    client.send(new Uint8Array([1]))
    client.send('quit')
    expect((await conn.finished).code).toBe(4001)
    expect(seen).toEqual(['hello', new Uint8Array([1]), 'quit'])
    expect(client.received).toEqual([])
  })

  it('maps @OnConnect failures to close codes', () => {
    expect(connectFailureCode(new WsException('X', 'x'))).toEqual({ code: 1008, reason: 'x' })
    expect(connectFailureCode(new WsException('X', 'x', undefined, { close: 4404 })).code).toBe(4404)
    expect(connectFailureCode(new ForbiddenException('no')).code).toBe(4403)
    expect(connectFailureCode(new WsValidationException([])).code).toBe(4400)
    expect(connectFailureCode(new Error('x')).code).toBe(1011)
  })
})
