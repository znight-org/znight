/** Build-time diagnostics of the websocket extension (RFC 0003 §6.3): every case with its location. */
import { cleanupApps, compileApp, render, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const IMPORTS = `import { Conn, Ctx, Gateway, OnConnect, OnDisconnect, OnMessage, Payload, UseHandshakeGuard, UseMessageGuard, type WsConnection } from '@znight/websocket'
`

async function diagnose(
  source: string,
  codes?: readonly string[],
  extra: Record<string, string> = {},
): Promise<string[]> {
  const app = tempApp({ 'src/main.ts': 'export {}\n', 'src/gateway.ts': IMPORTS + source, ...extra })
  const result = await compileApp(app.root)
  return render(
    app.root,
    result.diagnostics,
    codes ?? ['ZNIGHT003', 'ZNIGHT005', 'ZNIGHT007', 'ZNIGHT017', 'ZNIGHT023', 'ZNIGHT050'],
  )
}

describe('websocket diagnostics', () => {
  it('reports an event handled twice, with the first handler as related location', async () => {
    const lines = await diagnose(`
@Gateway('/chat')
export class ChatGateway {
  @OnMessage('message.send')
  send(): void {}

  @OnMessage('message.send')
  post(): void {}
}
`)
    expect(lines).toEqual([
      [
        'error ZNIGHT050 src/gateway.ts:8:3 ChatGateway handles "message.send" twice: ChatGateway.send and ChatGateway.post',
        '  = An event has a single handler per gateway: merge the methods, or rename one of the events',
        '  - first handled here (src/gateway.ts:5:3)',
      ].join('\n'),
    ])
  })

  it('reports reserved and invalid event names', async () => {
    const lines = await diagnose(`
@Gateway('/chat')
export class ChatGateway {
  @OnMessage('$ping')
  ping(): void {}

  @OnMessage('9lives')
  nine(): void {}
}
`)
    expect(lines.map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT050 src/gateway.ts:5:14 Event name "$ping" is reserved (ChatGateway.ping)',
      'error ZNIGHT050 src/gateway.ts:8:14 Invalid event name "9lives" (ChatGateway.nine)',
    ])
  })

  it('reports invalid options, raw gateways with events and several lifecycle methods', async () => {
    const lines = await diagnose(`
@Gateway({ path: '/feed', protocol: 'raw', scope: 'transient', concurrency: 0, protocols: ['bad token'], maxPayload: 'huge' })
export class FeedGateway {
  @OnMessage('tick')
  tick(): void {}

  @OnMessage()
  frame(): void {}

  @OnConnect()
  a(): void {}

  @OnConnect()
  b(): void {}
}
`)
    expect(lines.map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT050 src/gateway.ts:3:10 @Gateway FeedGateway: "concurrency" must be a positive integer, got 0',
      `error ZNIGHT050 src/gateway.ts:3:10 @Gateway FeedGateway: "maxPayload" must be a positive byte size ('64kb', 65536), got "huge"`,
      'error ZNIGHT050 src/gateway.ts:3:10 @Gateway FeedGateway: "protocols" must be a non-empty list of distinct subprotocol tokens, got an array',
      "error ZNIGHT050 src/gateway.ts:3:10 @Gateway FeedGateway: a gateway cannot be 'transient'",
      'error ZNIGHT050 src/gateway.ts:5:3 @OnMessage("tick") on the raw gateway FeedGateway',
      'error ZNIGHT050 src/gateway.ts:8:3 The raw gateway FeedGateway has several handlers: FeedGateway.tick, FeedGateway.frame',
      'error ZNIGHT050 src/gateway.ts:14:3 FeedGateway has several @OnConnect methods: FeedGateway.a, FeedGateway.b',
    ])
  })

  it('reports parameters: undecorated, @Payload on lifecycle methods, two payloads, unvalidated input, foreign decorators', async () => {
    const lines = await diagnose(`
import { Ctx as HttpCtx } from '@znight/http'

interface Order { id: string }

@Gateway('/orders')
export class OrderGateway {
  @OnConnect()
  open(@Payload() data: unknown): void {}

  @OnMessage('a')
  a(input: string): void {}

  @OnMessage('b')
  b(@Payload() one: string, @Payload() two: string): void {}

  @OnMessage('c')
  c(@Payload() order: Order): void {}

  @OnMessage('d')
  d(@HttpCtx() ctx: unknown): void {}

  @OnMessage('e')
  e(@Payload() text: string | Uint8Array, @Conn() conn: WsConnection, optional?: number): void {}
}
`)
    expect(lines.map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT050 src/gateway.ts:10:8 @Payload on OrderGateway.open: only @OnMessage handlers receive a message',
      "error ZNIGHT050 src/gateway.ts:13:5 Parameter 'input' of OrderGateway.a has no @Payload(), @Conn() or @Ctx() decorator",
      'error ZNIGHT050 src/gateway.ts:16:29 OrderGateway.b has two @Payload parameters',
      "warning ZNIGHT017 src/gateway.ts:19:5 Unvalidated message payload: parameter 'order' of OrderGateway.c is typed 'Order' but @Payload() has no schema",
      "error ZNIGHT005 src/gateway.ts:22:5 @Ctx on parameter 'ctx' of OrderGateway.d is imported from '@znight/http': gateway handlers use Ctx from '@znight/websocket'",
    ])
  })

  it('reports decorators outside a gateway, but not on abstract bases', async () => {
    const lines = await diagnose(`
export class NotAGateway {
  @OnMessage('x')
  x(): void {}
}

export abstract class Base {
  @OnMessage('shared')
  shared(): void {}
}

@Gateway('/ok')
export class OkGateway extends Base {}
`)
    expect(lines.map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT005 src/gateway.ts:4:3 @OnMessage has no effect: NotAGateway is not a @Gateway',
    ])
  })

  it('reports invalid and duplicate paths (ZNIGHT007) and gateways without handler (warning)', async () => {
    const lines = await diagnose(`
@Gateway('/docs/:id')
export class A {
  @OnMessage() any(): void {}
}

@Gateway('/docs/:docId')
export class B {
  @OnMessage() any(): void {}
}

@Gateway('/bad path')
export class C {}
`)
    expect(lines.map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT007 src/gateway.ts:8:1 A (/docs/:id) and B (/docs/:docId) serve the same path',
      'warning ZNIGHT050 src/gateway.ts:13:1 @Gateway C has no handler',
      `error ZNIGHT007 src/gateway.ts:13:10 @Gateway C: invalid path "/bad path": invalid character " " in "bad path" (allowed: letters, digits and - . _ ~ ! $ & ' + , ; = @)`,
    ])
  })

  it('reports a singleton gateway injecting WsConnection (ZNIGHT003)', async () => {
    const lines = await diagnose(
      `
@Gateway('/me')
export class MeGateway {
  constructor(private readonly conn: WsConnection) {}

  @OnConnect() open(): void {}
}
`,
      ['ZNIGHT003'],
    )
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('error ZNIGHT003')
  })

  it('reports a gateway without the decision of a required group (ZNIGHT023)', async () => {
    const lines = await diagnose(
      `
import { Access } from './access.ts'

@Gateway('/open')
@Access('public')
export class OpenGateway {
  @OnConnect() open(): void {}
}

@Gateway('/closed')
export class ClosedGateway {
  @OnConnect() open(): void {}
}
`,
      ['ZNIGHT023'],
      {
        'src/access.ts': `import { createRouteDecorator } from '@znight/http'

export const Access = createRouteDecorator<'public' | 'private'>('access', { required: true })
`,
      },
    )
    expect(lines.map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT023 src/gateway.ts:11:1 Gateway ClosedGateway (/closed) has no "access" decision',
    ])
  })
})
