/** WebSocketPlugin (RFC 0003 §5.9, §8.9): handshakes, connections, hooks, shutdown and options, in memory. */
import type {
  Plugin,
  ProviderDefinition,
  WebSocketConnectionEvent,
  WebSocketMessageEvent,
  ZnightMetadata,
} from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'
import type {
  GatewayDefinition,
  WebSocketPluginOptions,
  WsCodec,
  WsConnection,
  WsMessageContext,
} from '../src/index.ts'

import { Application, silentLogger } from '@znight/core'
import { HttpPlugin } from '@znight/http'

import { jsonCodec, WebSocketPlugin, WsException, WsHandshakeError, WsServer, WsTokens } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

const CHAT = 'src/chat.gateway.ts#ChatGateway'
const DOC = 'src/doc.gateway.ts#DocGateway'
const TICKET_GUARD = 'src/ticket.guard.ts#TicketGuard'

class ChatGateway {
  readonly log: string[] = []
  constructor(readonly ws: WsServer) {}
}

class DocGateway {
  static created = 0
  readonly seen: string[] = []
  constructor(readonly conn: WsConnection) {
    DocGateway.created++
  }
}

class TicketGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    return ctx.query['ticket'] !== 'forged'
  }
}

function singleton<T>(
  cls: new (...args: never[]) => T,
  deps: string[] = [],
  scope: 'singleton' | 'request' = 'singleton',
): ProviderDefinition {
  return {
    scope,
    class: cls as never,
    deps,
    factory: (d: readonly unknown[]) => new (cls as new (...args: unknown[]) => T)(...d),
  }
}

const chat: GatewayDefinition = {
  token: CHAT,
  path: '/chat',
  protocol: 'events',
  protocols: ['chat.v1'],
  meta: {},
  handshakeGuards: [TICKET_GUARD],
  messageGuards: [],
  onConnect: {
    method: 'connected',
    invoke: (g: ChatGateway, c: WsConnection) => {
      if (c.handshake.query['fail'] === 'yes') throw new WsException('NOPE', 'Refused', undefined, { close: 4403 })
      g.log.push(`connect:${c.id.length > 0}`)
    },
  },
  onDisconnect: { method: 'gone', invoke: (g: ChatGateway) => g.log.push('disconnect') },
  handlers: [
    {
      method: 'join',
      event: 'room.join',
      meta: {},
      guards: [],
      params: [],
      invoke: (g: ChatGateway, m: WsMessageContext) => {
        const room = (m.data as { room: string }).room
        m.connection.join(room)
        m.connection.to(room).emit('joined', { room })
        return { members: g.ws.of(CHAT_CLASS).members(room).size }
      },
    },
    {
      method: 'say',
      event: 'say',
      meta: {},
      guards: [],
      params: [],
      invoke: (g: ChatGateway, m: WsMessageContext) => {
        g.ws.of('/chat').to('lobby').emit('said', m.data)
      },
    },
  ],
}

const CHAT_CLASS = ChatGateway

const doc: GatewayDefinition = {
  token: DOC,
  path: '/docs/:docId',
  protocol: 'raw',
  meta: {},
  handshakeGuards: [],
  messageGuards: [],
  handlers: [
    {
      method: 'frame',
      meta: {},
      guards: [],
      params: [],
      invoke: (g: DocGateway, m: WsMessageContext) => {
        g.seen.push(String(m.data))
        g.conn.send(`${g.conn.params['docId']}:${g.seen.join(',')}`)
      },
    },
  ],
}

const metadata: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {
    [CHAT]: singleton(ChatGateway, [WsTokens.Server]),
    [DOC]: singleton(DocGateway, [WsTokens.Connection], 'request'),
    [TICKET_GUARD]: singleton(TicketGuard),
  },
  resolutionOrder: [CHAT, TICKET_GUARD],
  externals: [
    { token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
    { token: '@znight/http#RequestId', scope: 'request', providedBy: 'HttpPlugin' },
    { token: WsTokens.Server, scope: 'singleton', providedBy: 'WebSocketPlugin' },
    { token: WsTokens.Connection, scope: 'request', providedBy: 'WebSocketPlugin' },
  ],
  extensions: { http: { controllers: [] }, websocket: { gateways: [chat, doc] } },
}

async function createApp(options: WebSocketPluginOptions = {}, plugins: Plugin[] = []) {
  const http = HttpPlugin.configure({ port: 0 })
  const websocket = WebSocketPlugin.configure(options)
  const app = await Application.create({
    metadata,
    logger: silentLogger,
    shutdown: { signals: false },
    plugins: [websocket, http, ...plugins],
  })
  return {
    app,
    http,
    websocket,
    chat: app.container.get(CHAT) as ChatGateway,
    async [Symbol.asyncDispose]() {
      await app.stop()
    },
  }
}

describe('WebSocketPlugin', () => {
  it('serves events gateways in memory: replies, rooms, broadcasts, $ping and lifecycle', async () => {
    await using t = await createApp()
    expect(t.websocket.gateways).toEqual([
      { path: '/chat', gateway: 'ChatGateway', protocol: 'events', events: ['room.join', 'say'] },
      { path: '/docs/:docId', gateway: 'DocGateway', protocol: 'raw', events: [] },
    ])
    const alice = await t.websocket.connect('/chat', { protocols: ['other', 'chat.v1'] })
    const bob = await t.websocket.connect('/chat', { protocols: ['chat.v1'] })
    expect(alice.protocol).toBe('chat.v1')
    expect(await alice.request('room.join', { room: 'lobby' })).toEqual({ members: 1 })
    expect(await bob.request('room.join', { room: 'lobby' })).toEqual({ members: 2 })
    expect(await alice.next('joined')).toEqual({ room: 'lobby' })
    bob.send('say', 'hi')
    expect(await alice.next('said')).toBe('hi')
    expect(await bob.next('said')).toBe('hi')
    expect(await alice.request('$ping')).toEqual({ t: expect.any(Number) })
    await expect(alice.request('nope')).rejects.toMatchObject({ code: 'UNKNOWN_EVENT' })
    expect(t.websocket.connections).toBe(2)
    expect(t.app.container.get(WsServer).connections).toBe(2)
    expect(await alice.close()).toEqual({ code: 1000, reason: '' })
    await Bun.sleep(5)
    expect(t.chat.log).toEqual(['connect:true', 'connect:true', 'disconnect'])
    const stats = t.websocket.stats()
    expect(stats).toMatchObject({ connections: 1, opened: 2, closed: 1 })
    expect(stats.messagesIn).toBe(5)
  })

  it('runs the websocket hooks', async () => {
    await using t = await createApp()
    const messages: WebSocketMessageEvent[] = []
    const connections: WebSocketConnectionEvent[] = []
    const wrapped: string[] = []
    t.app.hooks.on('websocket:message', event => {
      messages.push(event)
    })
    t.app.hooks.on('websocket:connection', event => {
      connections.push(event)
    })
    t.app.hooks.wrap('websocket:message', async (event, next) => {
      wrapped.push(`${event.event}:before`)
      await next()
      wrapped.push(`${event.event}:${event.outcome}`)
    })
    const client = await t.websocket.connect('/chat', { protocols: ['chat.v1'] })
    await client.request('room.join', { room: 'a' })
    await expect(client.request('unknown')).rejects.toMatchObject({ code: 'UNKNOWN_EVENT' })
    await client.close(4000, 'bye')
    await Bun.sleep(5)
    expect(wrapped).toEqual(['room.join:before', 'room.join:ok', 'unknown:before', 'unknown:unhandled'])
    expect(messages.map(m => [m.gateway, m.path, m.event, m.handler, m.outcome])).toEqual([
      ['ChatGateway', '/chat', 'room.join', 'join', 'ok'],
      ['ChatGateway', '/chat', 'unknown', undefined, 'unhandled'],
    ])
    expect(connections.map(c => [c.type, c.gateway, c.code, c.initiator])).toEqual([
      ['open', 'ChatGateway', undefined, undefined],
      ['close', 'ChatGateway', 4000, 'client'],
    ])
  })

  it('refuses handshakes: origin, subprotocol, guards, capacity', async () => {
    await using t = await createApp({ maxConnections: 1 })
    const refused = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => error,
      )
    const crossSite = await refused(
      t.websocket.connect('/chat', { protocols: ['chat.v1'], origin: 'https://evil.example' }),
    )
    expect(crossSite).toBeInstanceOf(WsHandshakeError)
    expect(crossSite).toMatchObject({ status: 403 })
    expect(await refused(t.websocket.connect('/chat', { protocols: ['v2'] }))).toMatchObject({ status: 400 })
    expect(
      await refused(t.websocket.connect('/chat', { protocols: ['chat.v1'], query: { ticket: 'forged' } })),
    ).toMatchObject({ status: 403 })
    const sameOrigin = await t.websocket.connect('/chat', {
      protocols: ['chat.v1'],
      origin: 'http://localhost',
    })
    const full = await refused(t.websocket.connect('/chat', { protocols: ['chat.v1'] }))
    expect(full).toMatchObject({ status: 503, headers: { 'retry-after': '1' } })
    await sameOrigin.close()
  })

  it('accepts listed origins', async () => {
    await using t = await createApp({ origins: ['https://app.example.com', /^https:\/\/[a-z]+\.example\.org$/] })
    await (await t.websocket.connect('/chat', { protocols: ['chat.v1'], origin: 'https://app.example.com' })).close()
    await (await t.websocket.connect('/chat', { protocols: ['chat.v1'], origin: 'https://x.example.org' })).close()
    await expect(
      t.websocket.connect('/chat', { protocols: ['chat.v1'], origin: 'http://localhost' }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('closes with the code of an @OnConnect exception', async () => {
    await using t = await createApp()
    const client = await t.websocket.connect('/chat', { protocols: ['chat.v1'], query: { fail: 'yes' } })
    expect(await client.closed).toEqual({ code: 4403, reason: 'Refused' })
  })

  it('creates a request-scoped gateway per connection, injecting WsConnection', async () => {
    await using t = await createApp()
    DocGateway.created = 0
    const one = await t.websocket.connect('/docs/d1')
    const two = await t.websocket.connect('/docs/d2')
    one.sendRaw('a')
    one.sendRaw('b')
    two.sendRaw('c')
    expect(await one.nextRaw()).toBe('d1:a')
    expect(await one.nextRaw()).toBe('d1:a,b')
    expect(await two.nextRaw()).toBe('d2:c')
    expect(DocGateway.created).toBe(2)
  })

  it('closes every connection with 1001 on stop and runs @OnDisconnect', async () => {
    const t = await createApp()
    const client = await t.websocket.connect('/chat', { protocols: ['chat.v1'] })
    await t.app.stop()
    expect(await client.closed).toEqual({ code: 1001, reason: 'Server shutting down' })
    expect(t.chat.log).toEqual(['connect:true', 'disconnect'])
    expect(t.websocket.connections).toBe(0)
  })

  it('serves another application once the first one stopped', async () => {
    const websocket = WebSocketPlugin.configure()
    for (let round = 0; round < 2; round++) {
      const app = await Application.create({
        metadata,
        logger: silentLogger,
        shutdown: { signals: false },
        plugins: [HttpPlugin.configure({ port: 0 }), websocket],
      })
      const client = await websocket.connect('/chat', { protocols: ['chat.v1'] })
      expect(await client.request('room.join', { room: 'r' })).toEqual({ members: 1 })
      await app.stop()
    }
  })

  it('validates its options (ZNIGHT050) and needs HttpPlugin (ZNIGHT051)', async () => {
    await expect(createApp({ maxPayload: 'big' } as never)).rejects.toThrow('ZNIGHT050')
    await expect(createApp({ origins: [/example\.com/] })).rejects.toThrow('anchored')
    await expect(createApp({ nope: true } as never)).rejects.toThrow('unknown option "nope"')
    await expect(
      Application.create({
        metadata,
        logger: silentLogger,
        shutdown: { signals: false },
        plugins: [WebSocketPlugin.configure()],
      }),
    ).rejects.toThrow('ZNIGHT051')
  })

  it('costs nothing without gateways', async () => {
    const http = HttpPlugin.configure({ port: 0 })
    const websocket = WebSocketPlugin.configure()
    const app = await Application.create({
      metadata: { ...metadata, extensions: { http: { controllers: [] } } },
      logger: silentLogger,
      shutdown: { signals: false },
      plugins: [http, websocket],
    })
    expect(websocket.transport).toBeUndefined()
    expect(http.routes).toEqual([])
    await app.stop()
  })

  it('lists initRoots from the options and the metadata', () => {
    class Guard {
      canHandle(): boolean {
        return true
      }
    }
    const roots = WebSocketPlugin.configure({ messageGuards: [Guard] }).initRoots({ metadata })
    expect(roots).toEqual([Guard, CHAT, TICKET_GUARD, DOC])
  })
})

describe('WebSocketPlugin codec', () => {
  it('encodes and decodes events with a custom codec (JSON over binary frames)', async () => {
    const text = new TextDecoder()
    const bytes = new TextEncoder()
    const binaryJson: WsCodec = {
      decode: (frame, binary) =>
        binary ? jsonCodec.decode(text.decode(frame as Uint8Array), false) : jsonCodec.decode(frame, false),
      encode: message => bytes.encode(jsonCodec.encode(message) as string),
    }
    await using t = await createApp({ codec: binaryJson })
    const client = await t.websocket.connect('/chat', { protocols: ['chat.v1'] })
    client.sendRaw(bytes.encode(JSON.stringify({ event: 'room.join', data: { room: 'bin' }, id: 1 })))
    const reply = await client.nextRaw()
    expect(reply).toBeInstanceOf(Uint8Array)
    expect(JSON.parse(text.decode(reply as Uint8Array))).toEqual({ id: 1, data: { members: 1 } })
    await client.close()
    await expect(createApp({ codec: { decode: () => undefined } } as never)).rejects.toThrow('ZNIGHT050')
  })
})

describe('WebSocketPlugin handshakes in flight', () => {
  const SLOW = 'src/slow.gateway.ts#SlowGateway'
  const GATED = 'src/gated.gateway.ts#GatedGateway'
  const SLOW_GUARD = 'src/slow.guard.ts#SlowGuard'

  class SlowGateway {}
  class GatedGateway {}

  class SlowGuard implements CanActivate {
    async canActivate(): Promise<boolean> {
      await Bun.sleep(20)
      return true
    }
  }

  const raw = (token: string, path: string, guards: string[] = []): GatewayDefinition => ({
    token,
    path,
    protocol: 'raw',
    meta: {},
    handshakeGuards: guards,
    messageGuards: [],
    handlers: [],
  })

  /** The request-scoped gateway factory waits for `gate`. */
  function gatedApp(options: WebSocketPluginOptions, http: HttpPlugin = HttpPlugin.configure({ port: 0 })) {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const meta: ZnightMetadata = {
      ...metadata,
      providers: {
        [SLOW]: singleton(SlowGateway),
        [SLOW_GUARD]: singleton(SlowGuard),
        [GATED]: {
          scope: 'request',
          class: GatedGateway as never,
          deps: [],
          factory: async () => {
            entered.resolve()
            await gate.promise
            return new GatedGateway()
          },
        },
      },
      resolutionOrder: [SLOW, SLOW_GUARD],
      extensions: {
        http: { controllers: [] },
        websocket: { gateways: [raw(SLOW, '/slow', [SLOW_GUARD]), raw(GATED, '/gated')] },
      },
    }
    const websocket = WebSocketPlugin.configure(options)
    const created = Application.create({
      metadata: meta,
      logger: silentLogger,
      shutdown: { signals: false },
      plugins: [websocket, http],
    })
    return { created, websocket, entered: entered.promise, release: () => gate.resolve() }
  }

  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'open',
      (error: unknown) => (error as { status?: number }).status,
    )

  it('reserves maxConnections for concurrent handshakes behind an async guard', async () => {
    const { created, websocket } = gatedApp({ maxConnections: 2 })
    const app = await created
    try {
      const results = await Promise.all(Array.from({ length: 5 }, () => outcome(websocket.connect('/slow'))))
      expect(results.filter(result => result === 'open')).toHaveLength(2)
      expect(results.filter(result => result === 503)).toHaveLength(3)
      expect(websocket.connections).toBe(2)
    } finally {
      await app.stop()
    }
  })

  it('refuses a handshake completing while the server drains, without waiting for the drain timeout', async () => {
    const { created, websocket, entered, release } = gatedApp(
      {},
      HttpPlugin.configure({ port: 0, drainTimeoutMs: 5000 }),
    )
    const app = await created
    const result = outcome(websocket.connect('/gated'))
    await entered
    const stopped = app.stop()
    await Bun.sleep(5)
    release()
    expect(await result).toBe(503)
    const started = performance.now()
    await stopped
    expect(performance.now() - started).toBeLessThan(1000)
    expect(websocket.stats().opened).toBe(0)
  })

  it('does not complete a handshake that timed out while the gateway was created', async () => {
    const { created, websocket, entered, release } = gatedApp({ handshakeTimeoutMs: 30 })
    const app = await created
    try {
      const result = outcome(websocket.connect('/gated'))
      await entered
      expect(await result).toBe(408)
      release()
      await Bun.sleep(20)
      expect(websocket.connections).toBe(0)
      expect(websocket.stats().opened).toBe(0)
    } finally {
      await app.stop()
    }
  })
})
