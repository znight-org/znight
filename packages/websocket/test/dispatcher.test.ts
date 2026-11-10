import type { ErrorReportEvent } from '@znight/core'
import type { HttpContext } from '@znight/http'
import type { ConnectionLimits } from '../src/connection.ts'
import type { DispatcherOptions, HandlerPlan } from '../src/dispatcher.ts'
import type { GatewayDefinition, WsHandlerDefinition } from '../src/metadata.ts'

import { Hooks } from '@znight/core'
import { ForbiddenException } from '@znight/http'

import { WsConnectionImpl } from '../src/connection.ts'
import { connectFailureCode, GatewayDispatcher } from '../src/dispatcher.ts'
import { jsonCodec } from '../src/envelope.ts'
import { WsException, WsValidationException } from '../src/exceptions.ts'
import { TokenBucket } from '../src/rate-limit.ts'
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
    readonly limits?: ConnectionLimits
  } = {},
) {
  const gateway = new Gateway()
  const errors: string[] = []
  const warnings: string[] = []
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
    logClientError: message => warnings.push(message),
    closed: () => undefined,
    ...extra,
  })
  const conn = new WsConnectionImpl({
    id: 'c1',
    gateway: '/api/chat',
    handshake: { requestId: 'r1', params: {} } as unknown as HttpContext,
    protocol: '',
    limits: extra.limits ?? LIMITS,
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
  return { gateway, client, conn, errors, warnings, received }
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

  it('reports once per handler a result sent to nobody (a message without id)', async () => {
    const ignored: string[] = []
    const { client, received } = await connect([handler('fire', 'fire', () => 'ignored')], {
      ignoredResult: (method, event) => ignored.push(`${method}:${event}`),
    })
    client.send('{"event":"fire"}')
    client.send('{"event":"fire"}')
    expect(await received()).toEqual([])
    expect(ignored).toEqual(['fire:fire'])
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
      { guards: [{ canHandle: ctx => ctx.event !== 'denied' }] },
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

  it('answers BAD_FRAME and logs once per connection when a custom codec throws, rate limited or not', async () => {
    const codec = {
      decode: (frame: string | Uint8Array) => {
        if (frame === 'garbage') throw new Error('malformed')
        return jsonCodec.decode(frame, false)
      },
      encode: jsonCodec.encode,
    }
    const { client, received, errors, warnings, conn } = await connect([handler('echo', 'echo', (_g, m) => m.data)], {
      codec,
      limits: { ...LIMITS, rateLimit: { bucket: new TokenBucket(2, 60_000), onLimit: 'reject' } },
    })
    await Bun.sleep(1)
    client.send('garbage')
    client.send('{"event":"echo","data":1,"id":1}')
    expect(() => client.send('garbage')).not.toThrow() // over the rate limit
    // the rate-limited frame is answered at once, the others in their queue: any order
    const frames = await received()
    expect(frames).toHaveLength(3)
    expect(frames).toEqual(
      expect.arrayContaining([
        { event: '$error', data: { code: 'BAD_FRAME', message: 'The frame could not be decoded' } },
        { id: 1, data: 1 },
        { event: '$error', data: { code: 'RATE_LIMITED', message: 'Too many messages' } },
      ]),
    )
    // client input: logged once per connection, not as an error, whatever the number of bad frames
    expect(warnings).toEqual(['The codec failed to decode a frame (later failures of this connection are not logged)'])
    expect(errors).toEqual([])
    expect(conn.readyState).toBe('open')
  })

  it('refuses invalid event names of any codec before the hooks and the default handler', async () => {
    const hooks = new Hooks()
    const seen: (string | undefined)[] = []
    hooks.on('websocket:message', event => {
      seen.push(event.event)
    })
    const codec = {
      decode: (frame: string | Uint8Array) => ({ event: String(frame), data: undefined, id: 1 }),
      encode: jsonCodec.encode,
    }
    const { client, received } = await connect([handler('any', undefined, (_g, m) => m.event)], { codec, hooks })
    client.send(`bad\r\n${'x'.repeat(200)}`)
    client.send('good')
    expect(await received()).toEqual([
      { id: 1, error: { code: 'BAD_FRAME', message: 'Invalid event name' } },
      { id: 1, data: 'good' },
    ])
    expect(seen).toEqual([undefined, 'good'])
  })
})

describe('error:report', () => {
  function reporting() {
    const hooks = new Hooks()
    const reports: ErrorReportEvent[] = []
    hooks.on('error:report', report => {
      reports.push(report)
    })
    return { hooks, reports }
  }

  function lifecycle(hook: 'onConnect' | 'onDisconnect', method: string, error: Error): GatewayDefinition {
    return {
      [hook]: {
        method,
        invoke: () => {
          throw error
        },
      },
    } as Partial<GatewayDefinition> as GatewayDefinition
  }

  it('reports an unexpected handler failure once, with the message context', async () => {
    const { hooks, reports } = reporting()
    const failure = new Error('database down')
    const { client, received, errors } = await connect(
      [
        handler('send', 'send', () => {
          throw failure
        }),
        handler('denied', 'denied', () => {
          throw new ForbiddenException('nope')
        }),
        handler('invalid', 'invalid', () => {
          throw new WsValidationException([{ message: 'bad', path: '' }])
        }),
        handler('slow', 'slow', () => new Promise(() => undefined)),
        handler('ok', 'ok', () => 1),
      ],
      { hooks, name: 'ChatGateway' },
    )
    client.send('{"event":"send","data":1,"id":1}')
    client.send('{"event":"denied","id":2}')
    client.send('{"event":"invalid","id":3}')
    client.send('{"event":"unknown","id":4}')
    client.send('{"event":"ok","id":5}')
    client.send('{"event":"slow","id":6}')
    await Bun.sleep(80)
    expect(await received()).toHaveLength(6)
    expect(errors).toEqual(['Handler send failed'])
    expect(reports).toHaveLength(1)
    const report = reports[0] as ErrorReportEvent
    expect(report.error).toBe(failure)
    expect(report.source).toBe('websocket')
    expect(report.operation).toBe('ChatGateway.send')
    expect(report.requestId).toBe('r1')
    expect(report.tags).toEqual({
      gateway: 'ChatGateway',
      path: '/api/chat',
      event: 'send',
      handler: 'send',
      connectionId: 'c1',
    })
    expect((report.context as { event: string }).event).toBe('send')
  })

  it('reports unexpected @OnConnect and @OnDisconnect failures, not expected refusals', async () => {
    const connectFailure = new Error('session store down')
    const failing = reporting()
    const opened = await connect([], {
      hooks: failing.hooks,
      name: 'ChatGateway',
      definition: lifecycle('onConnect', 'connected', connectFailure),
    })
    await opened.conn.finished
    expect(failing.reports.map(report => [report.error, report.operation, report.tags['handler']])).toEqual([
      [connectFailure, 'ChatGateway.connected', 'connected'],
    ])
    expect(failing.reports[0]?.context).toBe(opened.conn)

    const refused = reporting()
    const rejected = await connect([], {
      hooks: refused.hooks,
      name: 'ChatGateway',
      definition: lifecycle('onConnect', 'connected', new WsException('UNAUTHORIZED', 'who are you')),
    })
    await rejected.conn.finished
    expect(refused.reports).toEqual([])

    const disconnectFailure = new Error('presence store down')
    const leaving = reporting()
    const left = await connect([], {
      hooks: leaving.hooks,
      name: 'ChatGateway',
      definition: lifecycle('onDisconnect', 'gone', disconnectFailure),
    })
    await Bun.sleep(1)
    left.conn.close()
    await left.conn.finished
    expect(leaving.reports.map(report => [report.error, report.operation])).toEqual([
      [disconnectFailure, 'ChatGateway.gone'],
    ])
  })
})
