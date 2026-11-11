---
description: "@znight/websocket - WebSocket gateways served by the HttpPlugin server: handshakes through the HTTP pipeline, validated events, replies, rooms, backpressure, heartbeats, checked at build time."
---

# @znight/websocket <Badge type="tip" text="available" />

WebSocket **gateways** for Znight ([RFC 0003](https://github.com/znight-org/znight/blob/main/rfcs/0003-websocket.md)).
The
[package README](../../packages/websocket/README.md) is the detailed reference.

- **The handshake is an HTTP request.** It runs through the `HttpPlugin` pipeline: request scope,
  `http:request` hook, global guards, access decisions, exception mappers. The request scope lasts
  as long as the connection, so what a guard put in a request-scoped provider is there for every
  message. `ctx.signal` aborts when the client leaves during the handshake, which is then not
  completed.
- **Checked at build time.** Gateways, events, parameters, guards and options are read by the
  compiler: a duplicate event, a reserved `$` event or a singleton gateway injecting `WsConnection`
  fail the build ([`ZNIGHT050`](/reference/error-codes#znight050),
  [`ZNIGHT003`](/reference/error-codes#znight003)).
- **One port, every adapter.** `node`, `fastify`, `express` and `hono` on Node.js and Bun: the `ws`
  transport on `node:http` servers (Bun ships its own `ws`), Bun's native WebSocket with
  `honoAdapter()` on `Bun.serve()`.
- **Bounded by default.** Origin check against cross-site WebSocket hijacking, payload, rate,
  connection and outbound buffer limits, heartbeats, handler timeouts and a graceful shutdown with
  close frames.

::: tip Guide
This page is the reference. To build WebSocket gateways step by step, read the
[WebSockets guide](/guide/websockets).
:::

## Install

```sh
npm install @znight/websocket @znight/http
npm install ws   # Node.js only (Bun provides it): the transport of node:http servers
```

Without a usable transport the boot fails with [`ZNIGHT051`](/reference/error-codes#znight051).
Entries: `@znight/websocket/ws` (`wsTransport()`), `@znight/websocket/bun` (`bunTransport()`),
`@znight/websocket/testing` (`createTestConnection()`, `createTestServer()` for unit tests).
`WebSocketPlugin.configure()` takes `transport` (`'auto'`), `origins` (`'same-origin'`), `maxPayload`
(`'1mb'`), `maxConnections`, `maxPendingMessages` (32), `backpressure`
(`{ limit: '1mb', onLimit: 'close' }`), `heartbeat` (30 s), `handshakeTimeoutMs`, `handlerTimeoutMs`,
`closeTimeoutMs`, `codec` (`jsonCodec`, the wire format of `events` gateways), `messageGuards`,
`exceptionMappers`, `exposeErrors` and `shutdown`: the package README describes each.

## A gateway

```ts
import { z } from 'zod'
import { Conn, Gateway, OnMessage, Payload, WsServer, type WsConnection } from '@znight/websocket'

export const JoinRoom = z.object({ room: z.string().regex(/^[a-z0-9-]{1,32}$/) })
export type JoinRoom = z.output<typeof JoinRoom>

@Gateway({ path: '/chat', protocols: ['chat.v1'] })
export class ChatGateway {
  constructor(private readonly ws: WsServer) {}

  @OnMessage('room.join')
  join(@Conn() conn: WsConnection, @Payload(JoinRoom) input: JoinRoom): { members: number } {
    conn.join(input.room)
    conn.to(input.room).emit('presence.joined', { room: input.room })
    return { members: this.ws.of(ChatGateway).members(input.room).size } // the reply
  }
}
```

```ts
import { HttpPlugin } from '@znight/http'
import { WebSocketPlugin } from '@znight/websocket'
import { createApplication } from './.znight/container.generated.js'

const app = await createApplication({
  plugins: [HttpPlugin.configure({ port: 3000 }), WebSocketPlugin.configure({ maxPayload: '64kb' })],
})
```

A client sends `{ "event": "room.join", "data": { "room": "general" }, "id": 1 }` and receives
`{ "id": 1, "data": { "members": 1 } }`; a payload the schema refuses gets
`{ "id": 1, "error": { "code": "BAD_REQUEST", "details": [...] } }`.

## Testing

```ts
import { TestApp } from '@znight/testing'

await using app = await TestApp.create({
  metadata,
  plugins: [HttpPlugin.configure({ port: 0 }), WebSocketPlugin.configure()],
})
await using alice = await app.connect('/chat', { protocols: ['chat.v1'] }) // in memory, real handshake
expect(await alice.request('room.join', { room: 'general' })).toEqual({ members: 1 })
```

See the [`@znight/testing` reference](/packages/testing) for `connect()` and `connectWebSocket()`,
and the [observability reference](/packages/observability) for the WebSocket spans, metrics and logs.

## Learn more

- The [WebSockets guide](/guide/websockets) walks through a complete chat (tickets, rooms, guards, a
  raw binary feed).
- The [`realtime-chat` example](/examples#realtime-chat) runs it, with its tests.
- For server-to-client streams only, [Server-Sent Events](/guide/files-and-streaming#server-sent-events) need no
  extra package.
