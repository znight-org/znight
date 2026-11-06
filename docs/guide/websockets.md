---
description: Real time with Znight - WebSocket gateways on the HTTP server, the handshake as an HTTP request, validated events, replies, rooms, tickets for browsers, guards, backpressure, testing and observability, from the realtime-chat example.
---

# WebSockets

[`@znight/websocket`](/packages/websocket) ([RFC 0003](https://github.com/znight-org/znight/blob/main/rfcs/0003-websocket.md))
serves WebSocket gateways on the HTTP server. This guide follows the
[`realtime-chat`](../../examples/realtime-chat/README.md) example: every file shown here is a file
of the example, and its tests are the tests of this guide.

## Gateways are served by the HTTP server

A gateway is a provider decorated with `@Gateway(path)`. `WebSocketPlugin` serves every gateway
through `HttpPlugin`'s server, on the same port, with any adapter:

```ts
import { HttpPlugin } from '@znight/http'
import { WebSocketPlugin } from '@znight/websocket'

const plugins = [
  HttpPlugin.configure({ port: 3000, guards: [AuthGuard] }),
  WebSocketPlugin.configure({ maxPayload: '64kb' }),
]
```

The **handshake is an HTTP request**: it goes through the request scope, the `http:request` hook
(logs, metrics, traces), the global guards, the gateway's handshake guards and the access decisions
of [Security](/guide/security). The request scope then lasts as long as the connection: a
request-scoped provider filled by a guard at the handshake is there for every message.

## The chat gateway

```ts [src/chat/chat.gateway.ts]
import type { Lazy } from '@znight/core'
import type { RequestUser } from '../auth/request-user.js'
import type { MessageService } from './message.service.js'

import {
  Conn,
  Gateway,
  type GatewayChannel,
  OnConnect,
  OnDisconnect,
  OnMessage,
  Payload,
  UseHandshakeGuard,
  UseMessageGuard,
  WsException,
  type WsServer,
} from '@znight/websocket'

import { Authenticated, Roles } from '../auth/access.js'
import {
  type ChatConnection,
  type ChatEvents,
  type ChatMessage,
  JoinRoom,
  KickUser,
  SendMessage,
} from './chat.protocol.js'
import { ConnectionQuotaGuard } from './connection-quota.guard.js'
import { ModeratorGuard } from './moderator.guard.js'

@Gateway({ path: '/chat', protocols: ['chat.v1'], rateLimit: { messages: 30, intervalMs: 1_000 } })
@Authenticated() // the handshake's access decision, enforced by the global AuthGuard
@UseHandshakeGuard(ConnectionQuotaGuard) // after the global guards: at most 5 tabs per user
export class ChatGateway {
  readonly #chat: GatewayChannel<ChatEvents>

  constructor(
    ws: WsServer,
    private readonly user: Lazy<RequestUser>,
    private readonly messages: MessageService,
  ) {
    this.#chat = ws.of<ChatEvents>(ChatGateway) // a lazy handle: usable once the plugin is bootstrapped
  }

  @OnConnect()
  connected(@Conn() conn: ChatConnection): void {
    // the guards ran in this connection's scope: RequestUser is the authenticated caller
    conn.data.user = this.user.get().principal
    conn.join(`user:${conn.data.user.name}`) // one room per user: every tab of a user
  }

  @OnMessage('room.join')
  join(@Conn() conn: ChatConnection, @Payload(JoinRoom) input: JoinRoom): { members: number } {
    conn.join(input.room)
    conn.to(input.room).emit('presence.joined', { room: input.room, user: conn.data.user.name })
    return { members: this.#chat.members(input.room).size } // the reply, when the client sent an id
  }

  @OnMessage('message.send')
  send(@Conn() conn: ChatConnection, @Payload(SendMessage) input: SendMessage): ChatMessage {
    if (!conn.rooms.has(input.room)) throw new WsException('FORBIDDEN', `Join "${input.room}" first`)
    const message = this.messages.post(conn.data.user, input)
    this.#chat.to(input.room).emit('message.new', message) // encoded once, sent to every member
    return message
  }

  @OnMessage('room.kick')
  @Roles(['moderator']) // message-level decision...
  @UseMessageGuard(ModeratorGuard) // ...enforced by a message guard reading Roles.get(ctx)
  kick(@Payload(KickUser) input: KickUser): void {
    const target = this.#chat.to(`user:${input.user}`)
    target.emit('kicked', { room: input.room })
    target.leave(input.room)
  }

  @OnDisconnect()
  disconnected(@Conn() conn: ChatConnection): void {
    for (const room of conn.rooms) {
      if (!room.startsWith('user:')) this.#chat.to(room).emit('presence.left', { room, user: conn.data.user.name })
    }
  }
}
```

- `@OnMessage('room.join')` handles the `room.join` event; the value a handler returns is the
  **reply** of a message sent with an `id` (`{ "event": "room.join", "data": {...}, "id": 1 }` →
  `{ "id": 1, "data": { "members": 1 } }`).
- `@Payload(JoinRoom)` validates the data with a Standard Schema (Zod here): an invalid payload is
  answered `BAD_REQUEST` with `details: [{ path, message }]`, without reaching the handler.
- Rooms are strings scoped per gateway; `WsServer.of(ChatGateway).to(room).emit(...)` encodes the
  frame once and sends it to every member, each with its own backpressure policy.
- A `WsException(code, message)` answers its code (`FORBIDDEN` here); a message without `id` gets
  an `$error` event instead of a reply.

The events of the protocol are typed in one place, shared by the gateway and the tests:

```ts [src/chat/chat.protocol.ts]
import type { WsConnection } from '@znight/websocket'
import type { Principal } from '../auth/request-user.js'

import { z } from 'zod'

export const RoomName = z.string().regex(/^[a-z0-9-]{1,32}$/)
export const JoinRoom = z.object({ room: RoomName })
export type JoinRoom = z.output<typeof JoinRoom>
export const SendMessage = z.object({ room: RoomName, text: z.string().trim().min(1).max(2000) })
export type SendMessage = z.output<typeof SendMessage>
export const KickUser = z.object({ room: RoomName, user: z.string().min(1) })
export type KickUser = z.output<typeof KickUser>

export interface ChatMessage {
  readonly id: string
  readonly room: string
  readonly author: string
  readonly text: string
  readonly at: string
}

/** Events the server sends on `/chat` (typed `emit`). */
export interface ChatEvents {
  'message.new': ChatMessage
  'presence.joined': { readonly room: string; readonly user: string }
  'presence.left': { readonly room: string; readonly user: string }
  kicked: { readonly room: string }
}

/** Per-connection data, set in `@OnConnect`. */
export interface ChatData {
  user: Principal
}

export type ChatConnection = WsConnection<ChatData, ChatEvents>
```

## Authentication: API keys and tickets

The global `AuthGuard` protects routes **and** handshakes. Browsers cannot set headers on a
WebSocket, so they ask an authenticated `POST /ws/tickets` for a single-use ticket valid 30 s and
connect to `/chat?ticket=...`; the guard accepts tickets on upgrade requests only, so that a ticket
never works as a URL credential elsewhere.

```ts [src/auth/auth.guard.ts]
import type { ApiKeys } from './api-keys.js'
import type { RequestUser } from './request-user.js'
import type { TicketStore } from './tickets.js'

import { Injectable, type Lazy } from '@znight/core'
import { type CanActivate, type HttpContext, UnauthorizedException } from '@znight/http'

import { Authenticated, Public } from './access.js'

/**
 * The global guard of `HttpPlugin`: it protects routes **and** WebSocket handshakes, which are HTTP
 * requests. An API key (`x-api-key`), or a ticket on upgrade requests only.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  static readonly enforces = [Public, Authenticated]

  constructor(
    private readonly keys: ApiKeys,
    private readonly tickets: TicketStore,
    private readonly user: Lazy<RequestUser>,
  ) {}

  canActivate(ctx: HttpContext): boolean {
    if (Public.get(ctx) === true) return true
    const principal = this.#identify(ctx)
    if (principal === undefined) throw new UnauthorizedException('Missing or invalid credentials')
    this.user.get().authenticate(principal)
    return Authenticated.get(ctx) === true
  }

  #identify(ctx: HttpContext) {
    const key = ctx.header('x-api-key')
    if (key !== undefined) return this.keys.identify(key)
    // tickets are for WebSocket handshakes only: they end up in URLs, never accept them elsewhere
    const ticket = ctx.query['ticket']
    const upgrade = ctx.header('upgrade')?.toLowerCase() === 'websocket'
    return upgrade && typeof ticket === 'string' ? this.tickets.consume(ticket) : undefined
  }
}
```

**Origins.** WebSockets have no CORS and browsers send cookies with cross-site handshakes:
`WebSocketPlugin` checks the `Origin` before any guard (`'same-origin'` by default, a list with the
`origins` option), refusing others with `403`.

**Handshake and message guards.** `@UseHandshakeGuard(ConnectionQuotaGuard)` runs an HTTP guard
after the global ones (five tabs per user, `429` above); `@UseMessageGuard(ModeratorGuard)` runs a
`WsGuard` before a handler, here reading the handler's `@Roles`:

```ts [src/chat/moderator.guard.ts]
import type { WsGuard, WsMessageContext } from '@znight/websocket'
import type { RequestUser } from '../auth/request-user.js'

import { Injectable, type Lazy } from '@znight/core'

import { Roles } from '../auth/access.js'

/** A message guard: the handler's `@Roles`, checked against the caller authenticated at the handshake. */
@Injectable()
export class ModeratorGuard implements WsGuard {
  constructor(private readonly user: Lazy<RequestUser>) {}

  canHandle(ctx: WsMessageContext): boolean {
    const roles = Roles.get(ctx)
    return roles === undefined || roles.some(role => this.user.get().principal.roles.includes(role))
  }
}
```

## Raw gateways and backpressure

A `raw` gateway has no envelope: its single `@OnMessage()` handler receives every frame, and
`conn.send()` sends frames as they are. A producer follows the client's pace: `send()` returns
`'queued'` when the outbound buffer grows, and `await conn.drained()` waits for it to empty. Above
`backpressure.limit`, the connection is closed with `1013` (or frames are dropped with
`onLimit: 'drop'`, for lossy feeds).

```ts [src/ticker/ticker.gateway.ts]
import { Conn, Gateway, OnConnect, type WsConnection, WsException } from '@znight/websocket'

import { Public } from '../auth/access.js'
import { encodeTick, type PriceFeed } from './price-feed.js'

/** A raw gateway: binary ticks at the client's pace (`drained()`), a `4404` close for an unknown symbol. */
@Gateway({ path: '/ticker/:symbol', protocol: 'raw', backpressure: { limit: '64kb' } })
@Public()
export class TickerGateway {
  constructor(private readonly prices: PriceFeed) {}

  @OnConnect()
  start(@Conn() conn: WsConnection): void {
    const symbol = conn.params['symbol'] ?? ''
    if (!this.prices.has(symbol)) {
      throw new WsException('NOT_FOUND', `Unknown symbol ${symbol}`, undefined, { close: 4404 })
    }
    // not awaited: @OnConnect must return for the connection to receive messages
    this.#pump(conn, symbol).catch(() => conn.close(1011, 'Feed failed'))
  }

  async #pump(conn: WsConnection, symbol: string): Promise<void> {
    for await (const tick of this.prices.ticks(symbol, conn.signal)) {
      if (conn.send(encodeTick(tick)) === 'queued') await conn.drained()
    }
  }
}
```

## Errors and close codes

| Thrown in       | `WsException`                         | `HttpException`             | Anything else               |
| --------------- | ------------------------------------- | --------------------------- | --------------------------- |
| a handler/guard | reply or `$error` with its code       | code from the status        | `INTERNAL` (logged)         |
| `@OnConnect`    | closes with its `close` code (`1008`) | closes with `4000 + status` | closes with `1011` (logged) |

A refused handshake is an HTTP error (`401`, `403`, `429`...): browsers only see a `1006` close,
so an application that must tell "unauthorized" from "network error" in a browser authenticates in
`@OnConnect` and closes with `4401`. On shutdown, every connection is closed with `1001` after its
running handlers, and `@OnDisconnect` runs.

## Scaling out

Rooms are per process. To broadcast across instances, publish through
[`@znight/messaging`](/packages/messaging) (a topic every instance consumes) and broadcast locally
in the consumer with `WsServer`.

## Testing

`app.connect()` of [`TestApp`](/packages/testing) runs the real handshake in memory (guards,
origin, subprotocols) and returns a client that buffers every frame, so tests never race the
server:

```ts [test/chat.ws.test.ts]
import type { ChatMessage } from '../src/chat/chat.protocol.js'

import { ALICE_KEY, BOB_KEY, createApp, ticket } from './support/app.js'
import { describe, expect, test as it } from 'bun:test'

describe('/chat', () => {
  it('members chat in a room: replies, presence and broadcasts', async () => {
    await using app = await createApp()
    await using alice = await app.connect('/chat', {
      query: { ticket: await ticket(app, ALICE_KEY) },
      protocols: ['chat.v1'],
    })
    await using bob = await app.connect('/chat', { headers: { 'x-api-key': BOB_KEY }, protocols: ['chat.v1'] })
    expect(alice.protocol).toBe('chat.v1')

    expect(await alice.request('room.join', { room: 'general' })).toEqual({ members: 1 })
    expect(await bob.request('room.join', { room: 'general' })).toEqual({ members: 2 })
    expect(await alice.next('presence.joined')).toEqual({ room: 'general', user: 'bob' })

    const sent = await alice.request<ChatMessage>('message.send', { room: 'general', text: ' hi ' })
    expect(sent).toMatchObject({ room: 'general', author: 'alice', text: 'hi' })
    expect(await bob.next('message.new')).toEqual(sent) // frames are buffered: no race
    expect(await alice.next('message.new')).toEqual(sent)

    const rooms = await app.inject({ url: '/rooms', headers: { 'x-api-key': BOB_KEY } })
    expect(rooms.json()).toEqual([{ room: 'general', members: 2 }])
    const history = await app.inject({ url: '/rooms/general/messages', headers: { 'x-api-key': BOB_KEY } })
    expect(history.json()).toEqual([sent])
  })

  it('answers errors with stable codes', async () => {
    await using app = await createApp()
    await using bob = await app.connect('/chat', { headers: { 'x-api-key': BOB_KEY }, protocols: ['chat.v1'] })
    await expect(bob.request('message.send', { room: 'general', text: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      details: [{ path: 'text', message: expect.any(String) }],
    })
    await expect(bob.request('message.send', { room: 'general', text: 'hi' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Join "general" first',
    })
    await expect(bob.request('nope')).rejects.toMatchObject({ code: 'UNKNOWN_EVENT' })
    expect(await bob.request('$ping')).toEqual({ t: expect.any(Number) })
    bob.send('room.join', { room: 'NOT VALID' }) // without id: the error comes as a $error event
    expect(await bob.next('$error')).toMatchObject({ event: 'room.join', code: 'BAD_REQUEST' })
  })

  it('lets moderators kick users (a message guard reading @Roles)', async () => {
    await using app = await createApp()
    await using alice = await app.connect('/chat', { headers: { 'x-api-key': ALICE_KEY }, protocols: ['chat.v1'] })
    await using bob = await app.connect('/chat', { headers: { 'x-api-key': BOB_KEY }, protocols: ['chat.v1'] })
    await bob.request('room.join', { room: 'general' })
    await expect(bob.request('room.kick', { room: 'general', user: 'alice' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await alice.request('room.kick', { room: 'general', user: 'bob' })
    expect(await bob.next('kicked')).toEqual({ room: 'general' })
    await expect(bob.request('message.send', { room: 'general', text: 'hi' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})
```

`connectWebSocket(url)` gives the same client over the network, and
`@znight/websocket/testing` provides `createTestConnection()` and `createTestServer()` for unit
tests of gateways and services.

## Observability

Handshakes are `http:request` events (`status: 101`). With
[`@znight/observability`](/packages/observability), every message is a `SERVER` span (a new trace
linked to the handshake's span), the `websocket_*` metrics count connections and messages, and one
log entry records each closed connection.
