/**
 * End to end (RFC 0003 §11.2): a chat application compiled with `compile()` (the extension found
 * through the manifest), then booted with `HttpPlugin` and `WebSocketPlugin` and driven in memory.
 */
import { Application, silentLogger } from '@znight/core'
import { HttpPlugin } from '@znight/http'

import { WebSocketPlugin } from '../../src/index.ts'
import { cleanupApps, compileAndLoad, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const APP: Readonly<Record<string, string>> = {
  'src/access.ts': `import { createRouteDecorator } from '@znight/http'

export const Roles = createRouteDecorator<readonly string[]>('roles')
`,
  'src/chat.protocol.ts': `import { z } from 'zod'

export const JoinRoom = z.object({ room: z.string().regex(/^[a-z]+$/) })
export type JoinRoom = z.output<typeof JoinRoom>
`,
  'src/moderator.guard.ts': `import type { WsGuard, WsMessageContext } from '@znight/websocket'
import { Roles } from './access.ts'

export class ModeratorGuard implements WsGuard {
  canHandle(ctx: WsMessageContext): boolean {
    const roles = Roles.get(ctx)
    return roles === undefined || ctx.connection.handshake.query['role'] === roles[0]
  }
}
`,
  'src/base.gateway.ts': `import { Conn, OnMessage, type WsConnection } from '@znight/websocket'

export abstract class BaseGateway {
  @OnMessage('whoami')
  whoami(@Conn() conn: WsConnection): string {
    return conn.protocol
  }
}
`,
  'src/chat.gateway.ts': `import { Conn, Ctx, Gateway, OnConnect, OnDisconnect, OnMessage, Payload, UseMessageGuard, WsServer, type WsConnection, type WsMessageContext } from '@znight/websocket'
import { Roles } from './access.ts'
import { BaseGateway } from './base.gateway.ts'
import { JoinRoom } from './chat.protocol.ts'
import { ModeratorGuard } from './moderator.guard.ts'

export const log: string[] = []

@Gateway({ path: '/chat', protocols: ['chat.v1'], rateLimit: { messages: 100, intervalMs: 1000 } })
export class ChatGateway extends BaseGateway {
  constructor(private readonly ws: WsServer) {
    super()
  }

  @OnConnect()
  connected(@Conn() conn: WsConnection<{ joined: number }>): void {
    conn.data.joined = 0
    log.push('connected')
  }

  @OnMessage('room.join')
  join(@Conn() conn: WsConnection, @Payload(JoinRoom) input: JoinRoom): { members: number } {
    conn.join(input.room)
    return { members: this.ws.of(ChatGateway).members(input.room).size }
  }

  @OnMessage('echo')
  echo(@Payload() text: string, @Ctx() ctx: WsMessageContext): string {
    return \`\${ctx.event}:\${text}\`
  }

  @OnMessage('kick')
  @Roles(['moderator'])
  @UseMessageGuard(ModeratorGuard)
  kick(): string {
    return 'kicked'
  }

  @OnDisconnect()
  gone(): void {
    log.push('gone')
  }
}
`,
  'src/main.ts': `export {}
`,
}

describe('compiled gateways', () => {
  it('generates the websocket section and serves it', async () => {
    const app = tempApp(APP)
    const { result, metadata } = await compileAndLoad(app)
    expect(result.code).toContain("import { validatePayload } from '@znight/websocket'")
    expect(result.code).toContain(
      "['invoke']: async (g: ChatGateway, m: WsMessageContext) =>\n                g.join(m.connection as never, await validatePayload(JoinRoom, m.data)),",
    )
    expect(result.code).toContain("['invoke']: (g: ChatGateway, m: WsMessageContext) => g.echo(m.data as never, m)")
    expect(result.code).toContain("['onDisconnect']: { ['method']: 'gone', ['invoke']: (g: ChatGateway) => g.gone() }")
    expect(
      result.diagnostics.filter(diagnostic => diagnostic.severity === 'error' || diagnostic.severity === 'warning'),
    ).toEqual([])
    const section = metadata.extensions?.websocket
    expect(
      section?.gateways.map(gateway => [gateway.token, gateway.path, gateway.protocols, gateway.rateLimit]),
    ).toEqual([
      ['src/chat.gateway.ts#ChatGateway', '/chat', ['chat.v1'], { messages: 100, intervalMs: 1000, onLimit: 'reject' }],
    ])
    expect(
      section?.gateways[0]?.handlers.map(handler => [handler.method, handler.event, handler.meta, handler.guards]),
    ).toEqual([
      ['whoami', 'whoami', {}, []],
      ['join', 'room.join', {}, []],
      ['echo', 'echo', {}, []],
      ['kick', 'kick', { roles: ['moderator'] }, ['src/moderator.guard.ts#ModeratorGuard']],
    ])

    const websocket = WebSocketPlugin.configure()
    const application = await Application.create({
      metadata,
      logger: silentLogger,
      shutdown: { signals: false },
      plugins: [HttpPlugin.configure({ port: 0 }), websocket],
    })
    try {
      const client = await websocket.connect('/chat', { protocols: ['chat.v1'] })
      expect(await client.request('room.join', { room: 'lobby' })).toEqual({ members: 1 })
      await expect(client.request('room.join', { room: 'NOPE' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        details: [{ path: 'room', message: expect.any(String) }],
      })
      expect(await client.request('echo', 'hi')).toBe('echo:hi')
      expect(await client.request('whoami')).toBe('chat.v1')
      await expect(client.request('kick')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      const moderator = await websocket.connect('/chat?role=moderator', { protocols: ['chat.v1'] })
      expect(await moderator.request('kick')).toBe('kicked')
      await client.close()
      await moderator.close()
      const { log } = (await import(`${app.root}/src/chat.gateway.ts`)) as { log: string[] }
      expect(log).toEqual(['connected', 'connected', 'gone', 'gone'])
    } finally {
      await application.stop()
    }
  })
})
