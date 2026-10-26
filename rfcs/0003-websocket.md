# RFC 0003: `@znight/websocket` for v0.1

|          |                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status   | Deferred to v0.2                                                                                                                                                                                                                                                               |
| Date     | 2026-10-26                                                                                                                                                                                                                                                                     |
| Affects  | New `@znight/websocket` (runtime, compiler extension, transports), `@znight/http` (upgrade routes, adapter capability, two compiler exports), `@znight/core` (two hooks, two error codes), `@znight/testing`, `@znight/observability`, CLI, docs                               |
| Decision | Gateways served **by `HttpPlugin`'s server**: the handshake is an HTTP request (same scope, hooks, guards, CORS/proxy settings), then a transport takes the socket: **`ws`** on every `node:http` adapter (Node and Bun), **native `Bun.serve()`** with `honoAdapter()` on Bun |

## 1. Summary

`@znight/websocket` adds WebSocket **gateways** to Znight: a provider class decorated with
`@Gateway(path)` whose methods handle the connection lifecycle (`@OnConnect`, `@OnDisconnect`) and
inbound events (`@OnMessage(event)`), with Standard Schema validation of payloads, request/reply
acknowledgements, rooms, broadcasts, backpressure, heartbeats and a graceful shutdown. Like every
Znight feature, gateways are resolved **at build time**: `@znight/websocket/compiler` reads the
decorators, validates the gateway graph (new diagnostics ZNIGHT030/031, plus the existing ZNIGHT003,
005, 007, 017 and RFC 0001's ZNIGHT023) and generates one `invoke` function per handler. At runtime
the plugin only wires generated code: no reflection, no per-message metadata lookup.

The design rests on five opinions:

1. **The handshake is an HTTP request.** It runs through the `@znight/http` pipeline: request scope,
   `http:request` hook (logs, metrics, traces), global HTTP guards, gateway handshake guards, exception
   mappers, `trustProxy` and the RFC 0001 access groups. The `AuthGuard` of `examples/rest-api` works
   on gateways **unchanged**, and the request-scoped `RequestUser` it fills is still there when
   messages arrive.
2. **The request scope is the connection.** It opens with the handshake and closes after
   `@OnDisconnect`. Messages of a connection are handled **in order** (concurrency 1 by default) in
   that scope.
3. **One port, one server, every adapter.** `WebSocketPlugin` requires `HttpPlugin` and plugs into
   its server: `node`, `fastify`, `express` and `hono` behave the same on Node.js 24 and Bun 1.3+.
   Znight intercepts upgrades at the server level, never through `@fastify/websocket`,
   `@hono/node-ws`, `express-ws` or `crossws`.
4. **Two transports, chosen automatically.** `ws` (the de facto standard, an optional peer; Bun
   replaces it with its built-in uWS-backed implementation, nothing to install) for every
   `node:http`-based server, and Bun's native `ServerWebSocket` when `honoAdapter()` runs on
   `Bun.serve()`. A third, in-memory transport powers `connect()` in tests.
5. **A tiny, documented wire protocol** (a JSON envelope with optional request ids) for `events`
   gateways, and a `raw` protocol for everything else (binary feeds, third-party protocols).

## 2. Context: what exists today (checked against the code and the runtimes)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                          | Where / how verified                                                             | Consequence                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| The HTTP plugin owns the server, the adapter and the pipeline; adapters only route and translate I/O                                                                                                                                                                                                                                                                                                                          | `packages/http/src/plugin.ts`, `adapter.ts`                                      | WebSocket support belongs at the same seam: a new optional adapter capability, not per-framework plugins                               |
| The pipeline keeps the request scope open until a streamed body completes (`done` promise, `captureContext()` = `AsyncLocalStorage.snapshot()`)                                                                                                                                                                                                                                                                               | `pipeline.ts` `#serve`, `stream.ts`                                              | The same mechanism holds the scope for the lifetime of a connection and re-enters it for each message                                  |
| Guards are `CanActivate.canActivate(ctx: HttpContext)`; `createRouteDecorator().get(ctx)` only reads `ctx.route?.meta[key]`                                                                                                                                                                                                                                                                                                   | `interfaces.ts`, `decorators.ts:330`                                             | HTTP guards apply as they are to handshakes; route decorators can serve message handlers if `get` accepts any object with `route.meta` |
| HTTP decorators on a class owned by another extension are reported (`@UseGuard has no effect: X is not a controller`)                                                                                                                                                                                                                                                                                                         | `http/src/compiler/analyze.ts` `reportOutsideController`                         | Gateways need their own guard decorators; reusing `@znight/http#UseGuard` would be an error                                            |
| Route decorators are recognised only by the http extension (`route-decorators.ts`, not exported)                                                                                                                                                                                                                                                                                                                              | `http/src/compiler/route-decorators.ts`                                          | The websocket extension needs a small public export from `@znight/http/compiler` (§6.4)                                                |
| `ZnightHooks` lists `http:request`, `messaging:message`, `messaging:publish`; event types live in core                                                                                                                                                                                                                                                                                                                        | `core/src/hooks.ts`                                                              | Two WebSocket hooks are added to core, so observability does not depend on `@znight/websocket`                                         |
| `ZNIGHT022` is the last code; RFC 0001 adds `ZNIGHT023`                                                                                                                                                                                                                                                                                                                                                                       | `core/src/errors.ts`, `rfcs/0001-security.md`                                    | This RFC opens the `ZNIGHT030`–`ZNIGHT039` range (§6.3)                                                                                |
| Node.js 24 has no WebSocket **server** in core (global `WebSocket` client only)                                                                                                                                                                                                                                                                                                                                               | Node 24.21                                                                       | A library is needed on Node: `ws`                                                                                                      |
| `node:http` `'upgrade'` events work on **Bun 1.4.4** with a raw socket                                                                                                                                                                                                                                                                                                                                                        | scratch probe (raw RFC 6455 handshake, both runtimes)                            | The `node`, `express` and `fastify` adapters can serve WebSockets on Bun too                                                           |
| On Bun, `import 'ws'` resolves to a **built-in** implementation (even without the npm package) backed by native code; `WebSocketServer.handleUpgrade` + `maxPayload` behave like npm `ws` (close 1009)                                                                                                                                                                                                                        | scratch probe, stack trace `ws:1003 nativeBufferedAmount`                        | `ws` is an optional peer **for Node only**; Bun users install nothing                                                                  |
| `ws` emits `'error'` on the socket; an unhandled one crashes the process                                                                                                                                                                                                                                                                                                                                                      | probe (`RangeError: Max payload size exceeded`)                                  | The transport always attaches an error listener                                                                                        |
| `http.Server` `shouldUpgradeCallback` (option, or assigned later) routes only chosen upgrades to `'upgrade'`; others are ordinary requests                                                                                                                                                                                                                                                                                    | probe on Node 24.21 and Bun 1.4.4; Node docs: option added in v24.12.0 / v25.1.0 | Gateways never steal upgrades of other paths; Express/Fastify/Hono routes keep working                                                 |
| `Bun.serve()` accepts `server.upgrade(req, { data, headers })` **after an `await`** (async guards); `open` runs synchronously inside `upgrade()`; `websocket` handlers are server-wide (`maxPayloadLength`, `backpressureLimit` 16 MB, `idleTimeout` 120 s, `sendPings`, `perMessageDeflate`); `ServerWebSocket` has `send` → `-1/0/n`, `getBufferedAmount`, `pause`/`resume` (Bun 1.4.x), `terminate`, `subscribe`/`publish` | probe + `bun-types@1.4.4`                                                        | The Bun transport sets server-wide limits to the plugin's, binds per-connection state through `data`, and feature-detects `pause`      |
| Node (undici) and Bun `WebSocket` clients accept a non-standard `{ headers, protocols }` init                                                                                                                                                                                                                                                                                                                                 | probe                                                                            | End-to-end test clients can authenticate with headers on both runtimes; browsers cannot                                                |
| A browser cannot read the status of a rejected handshake (it sees close `1006`)                                                                                                                                                                                                                                                                                                                                               | probe (`/deny` → client `error` + `1006`)                                        | Documented; the in-band alternative is closing with `4000 + status` from `@OnConnect` (§5.8)                                           |

## 3. Goals and non-goals

### Goals (v0.1)

- **Declarative gateways** with compile-time analysis: `@Gateway`, `@OnConnect`, `@OnMessage(event)`,
  `@OnDisconnect`, parameter decorators, generated `invoke` functions type-checked by `tsc`.
- **Typed messages**: payloads validated with any Standard Schema library (Zod, Valibot, ArkType);
  typed server events through an event map; typed per-connection data.
- **Request/reply** (acknowledgements) and errors with stable codes on the wire.
- **Rooms and broadcast**, encoded once per broadcast, with per-recipient backpressure.
- **Security by reuse**: handshake guards are HTTP guards; message guards for per-event
  authorization; origin check against cross-site WebSocket hijacking on by default; payload, rate,
  connection and buffer limits on by default.
- **Robustness**: inbound and outbound backpressure, heartbeats, handler timeouts, graceful
  shutdown with close frames, no unbounded buffer anywhere.
- **Identical behaviour** on the four HTTP adapters, on Node.js 24 and Bun.
- **Observability**: handshakes through `http:request`, messages through a new `websocket:message`
  hook, connections through `websocket:connection`; logs, RED metrics and spans in
  `@znight/observability`.
- **Testing**: in-memory connections (`TestApp.connect()`), real-network clients, unit-test fakes.

### Non-goals (v0.1)

- **Socket.IO protocol compatibility**, long-polling fallback, Engine.IO. SSE already works through
  `HttpResponse.stream()`.
- **A client SDK.** The protocol (§5.3) fits in a screen; the test client is not a browser library.
  Revisit in v0.2 with a typed client generated from the metadata.
- **Cluster-wide rooms.** Rooms are per process. The broadcast path has an internal seam (§8.8) for
  a v0.2 Redis/messaging bridge; no public adapter API is frozen now.
- **WebSockets over HTTP/2 or HTTP/3** (RFC 8441, RFC 9220), WebTransport.
- **Delivery guarantees** beyond TCP: no persistence, replay or resumption (at-most-once).
- **Server-initiated requests** expecting a client acknowledgement.
- **WebSocket-specific interceptors.** Core AOP (`@Intercept`, `@Logged`, `@Traced`, `@Metric`)
  already applies to gateway methods, and hooks cover cross-cutting concerns.
- **A per-message request scope** (open question Q3).
- **Edge runtimes** (`honoAdapter().fetch` mounted in a server Znight does not own), Deno,
  uWebSockets.js.
- **AsyncAPI generation** (a natural v0.2 follow-up of the metadata).

## 4. Decisions at a glance

| Topic        | Decision                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server       | Always `HttpPlugin`'s server and port. A WebSocket-only service configures `HttpPlugin` without controllers (and gets health checks for free)                               |
| Interception | `node:http` servers: `shouldUpgradeCallback` (composed with an existing one) + an `'upgrade'` listener. `Bun.serve()`: checked in the adapter's `fetch` before Hono routing |
| Transport    | `auto`: Bun native with `honoAdapter()` on Bun, `ws` otherwise (Bun's built-in `ws` on Bun). Explicit `wsTransport()` / `bunTransport()` for options                        |
| Scope        | `request` scope = the connection. Gateways are singletons by default, `scope: 'request'` gives one instance per connection                                                  |
| Ordering     | Messages of a connection are handled one at a time, in order, after `@OnConnect` (`concurrency` per gateway)                                                                |
| Protocol     | `events` (JSON envelope `{ event, data?, id? }`, replies `{ id, data }` / `{ id, error }`, `$`-prefixed reserved events) or `raw`                                           |
| Guards       | Handshake: global HTTP guards then `@UseHandshakeGuard` (HTTP `CanActivate`). Messages: global then `@UseMessageGuard` (`WsGuard`)                                          |
| Defaults     | `origins: 'same-origin'`, `maxPayload: 1 MiB`, outbound buffer 1 MiB then close `1013`, heartbeat 30 s, handler timeout 30 s, compression off, shutdown close `1001`        |
| Codes        | `ZNIGHT030` InvalidGateway, `ZNIGHT031` WebSocketTransportUnavailable; range `030`–`039` reserved for the package                                                           |

## 5. User-facing API

### 5.1 Install and bootstrap

```sh
bun add @znight/core @znight/http @znight/websocket zod
npm i ws          # Node.js only: Bun ships its own `ws`
bun add -d @znight/compiler vite
```

```ts
// src/main.ts
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { WebSocketPlugin } from '@znight/websocket'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { AuthGuard } from './auth/auth.guard.js'
import { ServerConfig } from './config/server.config.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    // the server: routes, global guards (they also run on every WebSocket handshake), trustProxy, cors
    HttpPlugin.configure(c => ({ port: c.get(ServerConfig).port, guards: [AuthGuard] })),
    // gateways are served on the same port; plugin order does not matter
    WebSocketPlugin.configure(c => ({
      origins: c.get(ServerConfig).webOrigins, // ['https://chat.example.com']
      maxPayload: '64kb',
    })),
  ],
})
await app.start() // SIGTERM: stop handshakes, close sockets with 1001, run @OnDisconnect, drain HTTP
```

### 5.2 Gateways and handlers

| Decorator                                               | Target                 | Arguments    | Description                                                                                                                               |
| ------------------------------------------------------- | ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@Gateway(path?)` / `@Gateway(options)`                 | class                  | static       | A provider whose methods handle the connections of `path` (default `/`), joined to the `HttpPlugin` prefix                                |
| `@OnConnect()`                                          | method                 | —            | Runs once the handshake succeeded, before any message. Throwing closes the connection (§5.8)                                              |
| `@OnMessage(event?)`                                    | method                 | static       | Handles an event (`events` protocol). Without `event`: the default handler (unknown events; every message of a `raw` gateway). Repeatable |
| `@OnDisconnect()`                                       | method                 | —            | Runs once per connection whose `@OnConnect` completed, after in-flight handlers, before rooms are left and the scope closes               |
| `@Payload(schema?)`                                     | parameter              | value        | The message `data` (`events`) or the raw `string \| Uint8Array` (`raw`), validated by `schema`                                            |
| `@Conn()`                                               | parameter              | —            | The `WsConnection`                                                                                                                        |
| `@Ctx()`                                                | parameter              | —            | The `WsMessageContext` (`@OnMessage` handlers only)                                                                                       |
| `@UseHandshakeGuard(...guards)`                         | class                  | value (rest) | Extra HTTP guards (`CanActivate`) of the handshake, after the `HttpPlugin` global guards                                                  |
| `@UseMessageGuard(...guards)`                           | class / method         | value (rest) | `WsGuard`s run before each handler (global → class → method)                                                                              |
| `createRouteDecorator` decorators (from `@znight/http`) | class / handler method | value        | Class: handshake **and** message metadata. Method: message metadata only (nearest wins, RFC 0001 groups)                                  |

`@Gateway` options (all static, read by the compiler):

| Option         | Default               | Description                                                                                                   |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `path`         | `'/'`                 | HTTP path grammar (`/chat`, `/docs/:docId`, `/feeds/*`)                                                       |
| `scope`        | `'singleton'`         | `'request'`: one gateway instance per connection (fields hold per-connection state). `'transient'` is refused |
| `protocol`     | `'events'`            | `'events'` (envelope, routing by event) or `'raw'` (one default handler, any frame)                           |
| `protocols`    | —                     | Accepted subprotocols, in preference order. When set, a client offering none of them is refused (400)         |
| `maxPayload`   | plugin `maxPayload`   | Largest inbound message (`'64kb'`), at most the plugin value on Bun (§8.6)                                    |
| `concurrency`  | `1`                   | Messages of one connection handled in parallel. `1` keeps the order                                           |
| `rateLimit`    | —                     | `{ messages, intervalMs, onLimit?: 'reject' \| 'close' }`, a token bucket per connection                      |
| `backpressure` | plugin `backpressure` | `{ limit?, onLimit?: 'close' \| 'drop' }`: `'drop'` suits lossy streams (cursors, tickers)                    |

```ts
// src/chat/chat.protocol.ts — the contract of /chat, shared by the gateway and the tests
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

/** Events the server sends on /chat (typed `emit`). */
export interface ChatEvents {
  'message.new': ChatMessage
  'presence.joined': { readonly room: string; readonly user: string }
  'presence.left': { readonly room: string; readonly user: string }
}

/** Per-connection data, set in @OnConnect. */
export interface ChatData {
  user: Principal
}

export type ChatConnection = WsConnection<ChatData, ChatEvents>
```

```ts
// src/chat/chat.gateway.ts
import type { Lazy } from '@znight/core'
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
  WsServer,
} from '@znight/websocket'

import { Authenticated, Roles } from '../auth/access.js'
import { RequestUser } from '../auth/request-user.js'
import { ConnectionQuotaGuard } from './connection-quota.guard.js'
import {
  type ChatConnection,
  type ChatEvents,
  type ChatMessage,
  JoinRoom,
  KickUser,
  SendMessage,
} from './chat.protocol.js'
import { MessageService } from './message.service.js'
import { ModeratorGuard } from './moderator.guard.js'

@Gateway({ path: '/chat', protocols: ['chat.v1'], rateLimit: { messages: 30, intervalMs: 1_000 } })
@Authenticated() // the handshake's access decision (RFC 0001 group), enforced by the global AuthGuard
@UseHandshakeGuard(ConnectionQuotaGuard) // runs after the global HTTP guards: at most 5 tabs per user
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
    // the handshake guards ran in this connection's scope: RequestUser is the authenticated caller
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
  async send(@Conn() conn: ChatConnection, @Payload(SendMessage) input: SendMessage): Promise<ChatMessage> {
    if (!conn.rooms.has(input.room)) throw new WsException('FORBIDDEN', `Join "${input.room}" first`)
    const message = await this.messages.post(conn.data.user, input)
    this.#chat.to(input.room).emit('message.new', message) // encoded once, sent to every member
    return message
  }

  @OnMessage('room.kick')
  @Roles(['moderator']) // message-level decision...
  @UseMessageGuard(ModeratorGuard) // ...enforced by a message guard reading Roles.get(ctx)
  kick(@Payload(KickUser) input: KickUser): void {
    this.#chat.to(`user:${input.user}`).leave(input.room)
  }

  @OnDisconnect()
  disconnected(@Conn() conn: ChatConnection): void {
    for (const room of conn.rooms) {
      if (!room.startsWith('user:')) this.#chat.to(room).emit('presence.left', { room, user: conn.data.user.name })
    }
  }
}
```

Rules worth knowing:

- A handler's return value is the **reply** of a message that carried an `id`; it is ignored
  otherwise (a `debug` log, once per handler, says so in development).
- Handlers may be `async`; a connection's next message waits for the current one (`concurrency: 1`).
- Handlers are inherited from analysable base classes (shared handlers in an abstract base gateway).
- Core AOP applies: `@Logged()`, `@Traced()`, `@Metric()` or any `@Intercept` on a handler work.

### 5.3 The wire protocol

**`events` gateways** exchange UTF-8 JSON text frames (the default `jsonCodec`; a custom codec, such
as MessagePack over binary frames, can replace it, §5.9).

| Direction       | Frame                                                                                               | Meaning                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| client → server | `{ "event": "message.send", "data": {...} }`                                                        | Fire and forget                                                                                         |
| client → server | `{ "event": "message.send", "data": {...}, "id": 7 }`                                               | Request: expects exactly one reply. `id`: a string (≤ 64 chars) or a safe integer, chosen by the client |
| server → client | `{ "id": 7, "data": {...} }`                                                                        | Success reply (`data` omitted when the handler returned `undefined`)                                    |
| server → client | `{ "id": 7, "error": { "code": "BAD_REQUEST", "message": "Invalid payload", "details": [...] } }`   | Failure reply                                                                                           |
| server → client | `{ "event": "message.new", "data": {...} }`                                                         | Server event (`conn.emit`, broadcasts)                                                                  |
| server → client | `{ "event": "$error", "data": { "event": "message.send", "code": "FORBIDDEN", "message": "..." } }` | Failure of a message without `id`                                                                       |
| client ↔ server | `{ "event": "$ping", "id": 1 }` → `{ "id": 1, "data": { "t": 1730000000000 } }`                     | Application-level ping (browsers cannot send ping frames); never reaches handlers                       |
- Event names match `^[A-Za-z][\w.:/-]{0,127}$`. Names starting with `$` are reserved.
- Unknown fields are ignored. A frame that is not a JSON object with a string `event` gets
  `$error` / `BAD_FRAME`. A binary frame gets `UNSUPPORTED_FRAME`. Neither closes the connection.
- Error codes are strings; built-in ones: `BAD_FRAME`, `UNSUPPORTED_FRAME`, `BAD_REQUEST`
  (validation, `details: [{ path, message }]`), `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
  `CONFLICT`, `UNPROCESSABLE`, `RATE_LIMITED`, `UNKNOWN_EVENT`, `TIMEOUT`, `INTERNAL` (message hidden
  unless `exposeErrors`).

**`raw` gateways** have no envelope: the default handler receives each frame (`string` for text,
`Uint8Array` for binary), `conn.send()` sends frames as they are, and there are no replies, no
`$error`, no `$ping` (errors are logged and close the connection only with `close`, §5.8).

### 5.4 Connections, rooms and broadcasts

```ts
interface WsConnection<TData extends object = Record<string, unknown>, E extends object = Record<string, unknown>> {
  readonly id: string // crypto.randomUUID(), unique per connection
  readonly gateway: string // path pattern, prefix included ('/api/chat')
  readonly requestId: string // the handshake's request id (logs, x-request-id)
  /** The handshake, detached from its socket: headers, query, params, ip, state, requestId. */
  readonly handshake: HttpContext
  readonly params: Readonly<Record<string, string>> // = handshake.params ('/docs/:docId')
  readonly protocol: string // negotiated subprotocol, '' when none
  readonly data: TData // per-connection state, an empty object at first
  readonly rooms: ReadonlySet<string>
  readonly readyState: 'open' | 'closing' | 'closed'
  readonly bufferedAmount: number // outbound bytes not yet written to the socket
  readonly signal: AbortSignal // aborted when the connection starts closing
  readonly closeInfo: WsCloseInfo | undefined // { code, reason, initiator } once closed
  emit<K extends keyof E & string>(event: K, data: E[K]): WsSendResult // events gateways
  send(frame: string | Uint8Array): WsSendResult // a raw frame (raw gateways, or bypassing the codec)
  join(room: string | readonly string[]): void
  leave(room: string): void
  /** The other members of `room` (this connection excluded). */
  to(room: string | readonly string[]): Broadcast<E>
  /** Resolves once the outbound buffer is below the low-water mark; rejects once closed. */
  drained(): Promise<void>
  close(code?: number, reason?: string): void // close frame, then terminate after closeTimeoutMs
  terminate(): void // no close frame
}
type WsSendResult = 'sent' | 'queued' | 'dropped'
type WsCloseInfo = {
  readonly code: number
  readonly reason: string
  readonly initiator: 'client' | 'server' | 'shutdown' | 'heartbeat' | 'backpressure' | 'error'
}

/** Injectable singleton (external provided by WebSocketPlugin). */
abstract class WsServer {
  /**
   * The connections and rooms of a gateway: its class, or its path as declared in `@Gateway` ('/chat',
   * without the HTTP prefix). Lazy: never throws; using the handle for an unknown gateway is a TypeError.
   */
  of<E extends object = Record<string, unknown>>(
    gateway: (abstract new (...args: never[]) => object) | string,
  ): GatewayChannel<E>
  readonly connections: number // every gateway of this process
}
interface GatewayChannel<E> {
  readonly path: string
  readonly size: number // open connections of the gateway (this process)
  connection(id: string): WsConnection | undefined
  connections(): IterableIterator<WsConnection>
  members(room: string): ReadonlySet<WsConnection>
  rooms(): ReadonlyMap<string, number> // room → size
  to(room: string | readonly string[]): Broadcast<E> // union of rooms
  except(target: WsConnection | string | readonly (WsConnection | string)[]): Broadcast<E> // a connection, an id
  emit<K extends keyof E & string>(event: K, data: E[K]): void // every connection of the gateway
  send(frame: string | Uint8Array): void
}
interface Broadcast<E> {
  to(room: string | readonly string[]): Broadcast<E>
  except(target: WsConnection | string | readonly (WsConnection | string)[]): Broadcast<E>
  exceptRoom(room: string | readonly string[]): Broadcast<E>
  emit<K extends keyof E & string>(event: K, data: E[K]): void
  send(frame: string | Uint8Array): void
  join(room: string): void // make the selected connections join / leave a room
  leave(room: string): void
  close(code?: number, reason?: string): void
}
```

- Rooms are strings scoped **per gateway** (`lobby` of `/chat` ≠ `lobby` of `/game`), created on
  first join, deleted when empty, left automatically after `@OnDisconnect`.
- A broadcast encodes the frame **once**, then sends it to each selected connection; each recipient
  applies its own backpressure policy (a slow client never slows the others). Broadcasts return
  `void`: counts would be wrong in a future cluster (§8.8); `stats()` has the totals.
- Send to a user on all their tabs with a `user:<id>` room, as above.

### 5.5 Typed events and schemas

- **Inbound**: `@Payload(Schema)` validates with any Standard Schema; the handler receives the
  **output** (defaults, transforms). The generated `invoke` passes the schema output to the handler,
  so `tsc` rejects a parameter type that does not match the schema (as for `@Body`).
- **Outbound**: `WsConnection<TData, E>`, `GatewayChannel<E>` and `Broadcast<E>` type `emit` with
  an event map (`ChatEvents`). Outbound frames are not validated at runtime (open question Q7).
- **Per-connection data**: `TData` types `conn.data`, an empty object until `@OnConnect` fills it.
  What handshake guards computed is reachable through request-scoped providers (same scope) or
  `conn.handshake.state` (the handshake's `ctx.state`).
- A non-primitive `@Payload()` without schema is ZNIGHT017 (warning; error with
  `strictValidation`). `string`, `Uint8Array`, `string | Uint8Array` and `unknown` are accepted.

### 5.6 Authentication, authorization and origins

**Handshake guards are HTTP guards.** The upgrade request runs, in order: the origin check, the
`HttpPlugin` global `guards`, then `@UseHandshakeGuard` guards, with `ctx.route.meta` holding the
gateway's route decorators. The rest-api `AuthGuard` (API key in `x-api-key`, `Public.get(ctx)`,
`Roles.get(ctx)`, `Lazy<RequestUser>`) protects gateways without a line of change. Headers a guard
sets with `ctx.setHeader()` are sent with the `101` response (`set-cookie`...).

```ts
// a handshake guard: an ordinary HTTP guard
@Injectable()
export class ConnectionQuotaGuard implements CanActivate {
  constructor(
    private readonly ws: WsServer,
    private readonly user: Lazy<RequestUser>,
  ) {}

  canActivate(): boolean {
    const user = this.user.get().principal.name // filled by the global AuthGuard, same scope
    if (this.ws.of('/chat').members(`user:${user}`).size >= 5) {
      throw new TooManyRequestsException('At most 5 chat connections per user') // 429, connection refused
    }
    return true
  }
}
```

**Message guards** authorize events. They run in the connection scope (request-scoped providers
filled at the handshake are available) **before** payload validation, like HTTP guards run before
body parsing. Returning anything but `true` answers `FORBIDDEN`; throw a `WsException` (or an
`HttpException`, mapped by status) for another code.

```ts
export interface WsGuard {
  canHandle(ctx: WsMessageContext): boolean | Promise<boolean>
}

@Injectable()
export class ModeratorGuard implements WsGuard {
  constructor(private readonly user: Lazy<RequestUser>) {}

  canHandle(ctx: WsMessageContext): boolean {
    const roles = Roles.get(ctx) // the handler's @Roles, else the gateway's (ctx.route.meta)
    return roles === undefined || roles.some(role => this.user.get().hasRole(role))
  }
}
```

`Roles.get(ctx)` works because `RouteDecorator.get` is widened to any object with
`route?.meta` (§8.2.4); `WsMessageContext.route` carries the effective metadata of the handler.

**Browsers cannot set headers on a WebSocket.** The recommended pattern (and the one of the wave 7
example) is a **ticket**: an authenticated `POST /ws/tickets` returns a random, single-use ticket
valid 30 s; the browser connects to `/chat?ticket=…`; the global `AuthGuard` accepts a ticket only
on upgrade requests (`ctx.header('upgrade') === 'websocket'`) and consumes it. Bearer tokens in the
query string end up in proxy logs; the `Sec-WebSocket-Protocol` token trick is discouraged; cookie
sessions work but make the origin check essential.

**Origins (cross-site WebSocket hijacking).** Browsers send cookies with cross-site handshakes and
WebSockets have no CORS. The `origins` option is therefore **access control**, checked before any
guard:

- `'same-origin'` (default): accept requests **without** `Origin` (non-browser clients) and those
  whose `Origin` equals the request's own origin (`ctx.protocol` and `host`, honouring
  `trustProxy` from RFC 0001); refuse others with `403 Origin not allowed`.
- `'*'`: accept every origin (APIs authenticated by headers or tickets only).
- A list of exact origins and anchored `RegExp`s, or `(origin, ctx) => boolean | Promise<boolean>`,
  validated at boot like RFC 0001's `cors.origin` (same normalisation rules).

### 5.7 Scopes and injection

| Injectable                 | Scope                      | Provided by                                |
| -------------------------- | -------------------------- | ------------------------------------------ |
| `WsServer`                 | singleton                  | `WebSocketPlugin`                          |
| `WebSocketPlugin`          | singleton                  | `WebSocketPlugin`                          |
| `WsConnection`             | request (= the connection) | `WebSocketPlugin`, seeded at the handshake |
| `HttpContext`, `RequestId` | request (= the connection) | `HttpPlugin`, the handshake request        |
- The request scope opened by the handshake **lasts until the connection closed**: request-scoped
  providers created by guards or handlers (`RequestUser`, a per-connection cache) live for the whole
  connection and are disposed after `@OnDisconnect`, in reverse creation order.
- Singletons reach them through `Lazy<T>` (as in HTTP; injecting them directly is ZNIGHT003).
- `@Gateway({ scope: 'request' })` creates the gateway **inside** the connection scope at the
  handshake (a factory error answers `500`), so its constructor may inject `WsConnection` and
  `HttpContext` directly and keep per-connection state in fields:

```ts
@Gateway({ path: '/docs/:docId', scope: 'request' })
@Authenticated()
export class DocumentGateway {
  #version = 0 // per connection

  constructor(
    private readonly conn: WsConnection,
    private readonly documents: DocumentService,
  ) {}

  @OnConnect()
  async open(): Promise<void> {
    const doc = await this.documents.open(this.conn.params['docId'] ?? '') // 4404 when missing, §5.8
    this.#version = doc.version
    this.conn.join(doc.id)
  }
}
```

- Per-message values are **arguments** (`@Payload`, `@Ctx`), never injected: with `concurrency > 1`
  two messages of a connection run at the same time in the same scope.
- `ctx.state` (`WsMessageContext.state`) is a fresh `Map` per message, shared by message guards and
  the handler; `conn.handshake.state` is the handshake's `ctx.state`.

### 5.8 Errors and close codes

```ts
class WsException extends Error {
  constructor(code: string, message?: string, details?: unknown, options?: { close?: number; cause?: unknown })
  readonly code: string
  readonly details: unknown
  readonly close: number | undefined // close the connection with this code after replying
}
class WsValidationException extends WsException {} // code BAD_REQUEST, details [{ path, message }], issues
```

| Thrown in                  | `WsException`                                              | `HttpException` (from services)                                                                                                                                   | Validation failure           | Anything else                                                      |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| a message handler or guard | reply / `$error` with its code; closes when `close` is set | code by status (400 `BAD_REQUEST`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`, 422 `UNPROCESSABLE`, 429 `RATE_LIMITED`, 5xx `INTERNAL`) | `BAD_REQUEST` with `details` | `INTERNAL`, logged with gateway, event, connection and request ids |
| `@OnConnect`               | closes with `close`, else `1008`                           | closes with `4000 + status` (`4401`, `4403`, `4404`)                                                                                                              | closes `4400`                | closes `1011`, logged                                              |
| `@OnDisconnect`            | logged                                                     | logged                                                                                                                                                            | —                            | logged                                                             |

Plugin-level `exceptionMappers` (`WsExceptionMapper.map(error, ctx) → WsException | undefined`)
run first, in order, like HTTP mappers.

Close codes used by the runtime (normative):

| Code                 | When                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `1000`               | `conn.close()` default                                                                                                                    |
| `1001`               | shutdown (`shutdown.code`, `1012` "service restart" is a common alternative)                                                              |
| `1008`               | policy: a `WsException` from `@OnConnect` without `close`; inbound queue overflow when the transport cannot pause                         |
| `1009`               | message above `maxPayload`                                                                                                                |
| `1011`               | unexpected error in `@OnConnect`                                                                                                          |
| `1013`               | slow consumer: outbound buffer above `backpressure.limit` with `onLimit: 'close'`                                                         |
| `4000 + HTTP status` | `HttpException` in `@OnConnect` (the graphql-ws convention: `4401`, `4403`, `4404`, `4429`); `rateLimit` with `onLimit: 'close'` → `4429` |
| (none, local `1006`) | heartbeat timeout, `terminate()`, close timeout                                                                                           |

A **rejected handshake** answers an HTTP error (guards, origin, protocol checks), with the same
body and exception mappers as any HTTP error. Browsers only see `1006`; applications that must tell
"unauthorized" from "network error" in a browser authenticate in `@OnConnect` instead and close
with `4401`.

### 5.9 Plugin options

`WebSocketPlugin.configure(options | (container) => options)` (name `websocket`; a function is
evaluated in `onBootstrap`, as for `HttpPlugin`).

| Option               | Default                                                            | Description                                                                                                  |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `transport`          | `'auto'`                                                           | `'auto'`, `wsTransport(options?)` (`@znight/websocket/ws`) or `bunTransport()` (`@znight/websocket/bun`)     |
| `origins`            | `'same-origin'`                                                    | §5.6                                                                                                         |
| `maxPayload`         | `'1mb'`                                                            | Largest inbound message after decompression (`ByteSize`); gateways may lower it                              |
| `maxConnections`     | `Infinity`                                                         | Open connections per process; above: `503` with `retry-after: 1`                                             |
| `maxPendingMessages` | `32`                                                               | Inbound queue per connection before reading pauses (§8.6)                                                    |
| `backpressure`       | `{ limit: '1mb', onLimit: 'close' }`                               | Outbound buffer per connection; `onLimit: 'drop'` drops frames instead of closing (`1013`)                   |
| `heartbeat`          | `{ intervalMs: 30_000 }`                                           | `false` disables (§8.7)                                                                                      |
| `handshakeTimeoutMs` | `10_000`                                                           | Upgrade requests whose guards have not answered by then get `408`                                            |
| `handlerTimeoutMs`   | `30_000`                                                           | Per message (and `@OnConnect`): `TIMEOUT` reply, `ctx.signal` aborted; `Infinity` disables                   |
| `closeTimeoutMs`     | `2_000`                                                            | Wait for the client's close frame before terminating                                                         |
| `compression`        | `false`                                                            | `permessage-deflate` (server-wide; `true` = shared compressor)                                               |
| `codec`              | `jsonCodec`                                                        | `events` codec: `{ decode(frame, binary) → { event, data?, id? }; encode(outbound) → string \| Uint8Array }` |
| `messageGuards`      | `[]`                                                               | Global `WsGuard`s (classes or instances)                                                                     |
| `exceptionMappers`   | `[]`                                                               | `WsExceptionMapper`s (classes or instances)                                                                  |
| `exposeErrors`       | `false`                                                            | Send the message of unexpected errors                                                                        |
| `shutdown`           | `{ code: 1001, reason: 'Server shutting down', timeoutMs: 3_000 }` | §8.9; keep `timeoutMs` below `HttpPlugin.drainTimeoutMs` and `hookTimeoutMs`                                 |

The instance (`app.getPlugin<WebSocketPlugin>('websocket')`, or injected) exposes `server`
(`WsServer`), `transport` (name), `gateways` (summaries: path, gateway, events), `connections`,
`stats()` (`{ connections, opened, closed, messagesIn, messagesOut, bytesIn, bytesOut, dropped,
slowConsumerCloses }`), `connect(path, options?)` (§5.10) and `initRoots()` (classes of
`messageGuards` and `exceptionMappers`, the `PluginInitRoots` contract of architecture §10).

### 5.10 Testing

**In memory** (no socket, no `listen`): `WebSocketPlugin.connect()` runs the real handshake
through the HTTP pipeline (guards, hooks, origin, protocols) with an in-memory request, then
connects an in-memory transport. `TestApp.connect()` delegates to it, like `TestApp.inject()` does
to `HttpPlugin`.

```ts
// test/chat.ws.test.ts
import { expect, test } from 'bun:test'
import { WsHandshakeError } from '@znight/testing'
import type { ChatMessage } from '../src/chat/chat.protocol.js'
import { ALICE_KEY, BOB_KEY, createApp } from './support/app.js'

test('members chat in a room', async () => {
  await using app = await createApp() // TestApp.create({ metadata, plugins: [http, websocket], ... })
  const ticket = async (key: string): Promise<string> =>
    (await app.inject({ method: 'POST', url: '/ws/tickets', headers: { 'x-api-key': key } })).json<{ ticket: string }>()
      .ticket

  await using alice = await app.connect('/chat', { query: { ticket: await ticket(ALICE_KEY) }, protocols: ['chat.v1'] })
  await using bob = await app.connect('/chat', { query: { ticket: await ticket(BOB_KEY) }, protocols: ['chat.v1'] })
  expect(alice.protocol).toBe('chat.v1')

  expect(await alice.request('room.join', { room: 'general' })).toEqual({ members: 1 })
  await bob.request('room.join', { room: 'general' })
  expect(await alice.next('presence.joined')).toEqual({ room: 'general', user: 'bob' })

  const sent = await alice.request<ChatMessage>('message.send', { room: 'general', text: 'hi' })
  expect(await bob.next('message.new')).toEqual(sent) // frames are buffered: no race

  await expect(alice.request('message.send', { room: 'general', text: '' })).rejects.toMatchObject({
    code: 'BAD_REQUEST', // a WsRequestError
    details: [{ path: 'text', message: expect.any(String) }],
  })
})

test('the handshake is authenticated', async () => {
  await using app = await createApp()
  const refused = app.connect('/chat', { query: { ticket: 'forged' } })
  await expect(refused).rejects.toBeInstanceOf(WsHandshakeError)
  await expect(refused).rejects.toMatchObject({ status: 401 })
  await expect(app.connect('/chat', { headers: { origin: 'https://evil.example' } })).rejects.toMatchObject({
    status: 403,
  })
})
```

```ts
// what TestApp.connect() resolves with (also returned by connectWebSocket(url) over the network)
interface TestWsClient extends AsyncDisposable {
  readonly protocol: string
  readonly frames: readonly unknown[] // every decoded frame received, in order
  send(event: string, data?: unknown): void
  request<T = unknown>(event: string, data?: unknown, options?: { timeoutMs?: number }): Promise<T> // rejects with WsRequestError { code, message, details }
  /** Data of the oldest server event (matching `event`) not consumed by a previous next(); frames are buffered from the start. Default timeout 1 000 ms. */
  next<T = unknown>(event?: string, options?: { timeoutMs?: number }): Promise<T>
  sendRaw(frame: string | Uint8Array): void
  nextRaw(options?: { timeoutMs?: number }): Promise<string | Uint8Array>
  close(code?: number, reason?: string): Promise<WsCloseInfo>
  readonly closed: Promise<WsCloseInfo>
}
// app.connect(path, { query?, headers?, protocols?, origin? }): Promise<TestWsClient>; rejects with
// WsHandshakeError { status, headers, body, json() } when the handshake is refused
```

**Over the network** (end-to-end tests, Node and Bun): `connectWebSocket(url, { headers?,
protocols? })` from `@znight/testing` wraps the global `WebSocket` with the same `TestWsClient`
interface (both runtimes accept `headers`).

**Unit tests**: `TestBed` builds the gateway with mocked dependencies; `@znight/websocket/testing`
provides fakes that record what the code under test does.

```ts
import { TestBed } from '@znight/testing'
import { WsServer } from '@znight/websocket'
import { createTestConnection, createTestServer } from '@znight/websocket/testing'

test('send broadcasts to the room', async () => {
  // metadata: the generated module; MESSAGE, ALICE: test fixtures
  const server = createTestServer() // records broadcasts: { gateway, rooms, except, event, data }
  const { instance, mocks } = await TestBed.create(ChatGateway, { metadata, overrides: [[WsServer, server]] })
  mocks.get(MessageService).post.mockResolvedValue(MESSAGE)
  const conn = createTestConnection<ChatData, ChatEvents>({ data: { user: ALICE }, rooms: ['general'] })

  expect(await instance.send(conn, { room: 'general', text: 'hi' })).toBe(MESSAGE)
  expect(server.broadcasts).toEqual([
    { gateway: '/chat', rooms: ['general'], except: [], event: 'message.new', data: MESSAGE },
  ])
  expect(conn.emitted).toEqual([]) // frames sent to this connection only
})
```

`TestApp`'s default boot closure (architecture §10) gains the gateways of
`metadata.extensions.websocket` with their guards, read structurally (`@znight/testing` still does
not depend on feature packages).

## 6. Compile-time analysis and validations

### 6.1 Decorator specs (`@znight/websocket/compiler`)

| Identity                      | Targets       | Params               |
| ----------------------------- | ------------- | -------------------- |
| `@znight/websocket#Gateway`   | class         | `['static']`         |
| `#OnConnect`, `#OnDisconnect` | method        | `[]`                 |
| `#OnMessage`                  | method        | `['static']`         |
| `#Payload`                    | parameter     | `['value']`          |
| `#Conn`, `#Ctx`               | parameter     | `[]`                 |
| `#UseHandshakeGuard`          | class         | `[]`, rest `'value'` |
| `#UseMessageGuard`            | class, method | `[]`, rest `'value'` |

### 6.2 Analysis (normative)

For every class carrying a websocket decorator, `analyzeClass`:

1. **Gateway.** Without `@Gateway`: like messaging, the decorators are reported (ZNIGHT005) unless
   the class is abstract or a base class of a gateway (checked in `validate`). With it:
   `registerProvider(cls, { scope })`; the path is normalised and checked with the pure helpers of
   `@znight/http/path` (`normalizePath`, `checkRoutePath`).
2. **Guards.** `@UseHandshakeGuard` and `@UseMessageGuard` arguments go through
   `resolveClassRef(arg, { from: cls, role })` (helper classes are auto-registered as singletons;
   the gateway → guard edges count for ZNIGHT003 and ZNIGHT019, never for ZNIGHT002).
3. **Metadata.** Route decorators of the class and of each handler are read with the http helper
   of §6.4 (one decision per group per target, RFC 0001).
4. **Handlers** are collected from the class and its analysable bases (the most derived declaration
   of a method wins). Each method has at most one role: `@OnConnect`, `@OnDisconnect` or one or more
   `@OnMessage`. Handlers must be public, non-static, named methods (same rules as routes).
5. **Parameters.** Every parameter carries exactly one websocket parameter decorator, except an
   optional parameter (left `undefined`). `@Payload` and `@Ctx` only on `@OnMessage` handlers; one
   `@Payload` per handler. The `@Payload` schema must be a Standard Schema reference (as `@Body`).
   A decorator named like a websocket one but imported from `@znight/http` or `@znight/messaging`
   (`Ctx`, `Headers`) is reported with the import to use, and reciprocally the http extension leaves
   the parameters of `@OnMessage` handlers to this extension (its existing `reportHandlerParams`).
6. `ctx.store()` keeps a plain `GatewayData` (token, identity, path, options, meta, guards, handlers
   with their parameter plans and schema `ValueRef`s, locations).

`validate` (after binding) checks what needs every gateway: duplicate paths, base classes, the
RFC 0001 required groups on handshakes, and the cross-handler rules of the table below.

### 6.3 Diagnostics

**Reused codes:**

| Code      | WebSocket cases                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZNIGHT003 | A singleton gateway uses a request-scoped guard (directly or through transients), or injects `WsConnection` / `HttpContext` directly. Hint: `Lazy<T>` or `@Gateway({ scope: 'request' })`                                                                                                                                                                                     |
| ZNIGHT005 | Wrong target, non-static argument, decorator applied twice, `@UseHandshakeGuard()` without guard, a handler that is static / private / `#private` / computed, a websocket decorator on a class that is neither a gateway nor one of its bases, `@Gateway` + `@Controller` / `@Consumer` on one class (core rule), a parameter decorator imported from another feature package |
| ZNIGHT007 | Gateway path grammar (as routes); two gateways with the same path shape (`/docs/:id` and `/docs/:docId`)                                                                                                                                                                                                                                                                      |
| ZNIGHT017 | Non-primitive `@Payload()` without schema (warning, error with `strictValidation`)                                                                                                                                                                                                                                                                                            |
| ZNIGHT023 | (RFC 0001) a gateway without a decision of a required route decorator group; at boot, a handshake whose guard chain does not enforce it                                                                                                                                                                                                                                       |

**New codes.** The range **`ZNIGHT030`–`ZNIGHT039` is reserved for `@znight/websocket`**.
Codes below `030` stay with core and the shared packages (RFC 0001 took `023`; `024`–`029` remain
free for them); later feature packages take the next decades (`040`–`049`, ...). Codes are still
declared in `@znight/core` (`ErrorCode`, `ERROR_DESCRIPTIONS`), shared by compiler and runtime.

| Code          | Name                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Severity        | When           |
| ------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------- |
| ZNIGHT030     | `InvalidGateway`                | Invalid gateway: unknown or invalid `@Gateway` option (scope `'transient'`, protocol, subprotocol tokens, `maxPayload`, `concurrency`, `rateLimit`, `backpressure`); several `@OnConnect` or `@OnDisconnect` methods; an event handled twice; several default handlers; an invalid or reserved (`$`) event name; `@OnMessage(event)` or several handlers on a `raw` gateway; `@Payload` / `@Ctx` outside `@OnMessage`, two `@Payload`; an undecorated required handler parameter; a method with several roles; a gateway without handler (warning). At boot: invalid `WebSocketPlugin` options, malformed `metadata.extensions.websocket` | error / warning | build, startup |
| ZNIGHT031     | `WebSocketTransportUnavailable` | Gateways cannot be served: no `HttpPlugin` in the application; an adapter without upgrade support; `ws` not installed on Node.js; `bunTransport()` outside `Bun.serve()`, `wsTransport()` with `honoAdapter()` on Bun; upgrade routes added after the server started listening                                                                                                                                                                                                                                                                                                                                                            | error           | startup        |
| ZNIGHT032–039 | —                               | Reserved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                 |                |

```text
✗ ZNIGHT030: ChatGateway handles "message.send" twice: ChatGateway.send and ChatGateway.post
  --> src/chat/chat.gateway.ts:58:3
   |
58 |   @OnMessage('message.send')
   |   ^^^^^^^^^^^^^^^^^^^^^^^^^^
   = hint: An event has a single handler per gateway: merge the methods, or rename one of the events
  ::: src/chat/chat.gateway.ts:41:3 first handled here

✗ ZNIGHT030: Event name "$ping" is reserved (ChatGateway.ping)
  --> src/chat/chat.gateway.ts:70:14
   = hint: Names starting with "$" are protocol events; "$ping" is answered by Znight itself

✗ ZNIGHT031: WebSocketPlugin needs HttpPlugin: gateways are served by the HTTP server
   = hint: Add HttpPlugin.configure() to the plugins (without controllers for a WebSocket-only service)

✗ ZNIGHT031: The "ws" package is required to serve WebSocket gateways on Node.js
   = hint: npm i ws (Bun provides it: nothing to install there)
```

### 6.4 Exports added to `@znight/http/compiler`

The websocket extension must read route decorators exactly as the http extension does (keys,
values, groups, RFC 0001 rules). Two exports become public, stable API of `@znight/http/compiler`
(an import-free entry, already allowed by the boundaries):

```ts
/** Route decorator metadata of a class or method (the exact logic of @Controller and routes). */
export function readRouteMeta(
  ctx: AnalyzeContext<unknown>,
  cls: ClassInfo,
  decorators: readonly DecoratorInfo[],
): MetaEntry[]
/** Required route decorator groups seen in the compile (RFC 0001), for ZNIGHT023 on other route kinds. */
export function requiredRouteGroups(ctx: ValidateContext<unknown>): ReadonlyMap<string, readonly string[]>
```

`tests/boundaries.test.ts` allows `@znight/websocket/compiler` to import `@znight/http/compiler` and
`@znight/http/path` (both runtime-free), and nothing else of `@znight/http`.

## 7. Generated metadata and runtime contract

### 7.1 Types (`metadata.extensions.websocket`, augmenting `ZnightExtensionsMetadata`)

```ts
interface WebSocketMetadata {
  gateways: GatewayDefinition[] // sorted by token
}
interface GatewayDefinition {
  token: Token
  path: string // normalizePath(@Gateway path), WITHOUT the HttpPlugin prefix
  protocol: 'events' | 'raw'
  protocols?: string[]
  maxPayload?: number // bytes
  concurrency?: number
  rateLimit?: { messages: number; intervalMs: number; onLimit: 'reject' | 'close' }
  backpressure?: { limit?: number; onLimit?: 'close' | 'drop' } // bytes
  meta: Record<string, unknown> // route decorators of the class: handshake and messages
  handshakeGuards: Token[] // @UseHandshakeGuard, in order
  messageGuards: Token[] // @UseMessageGuard on the class, in order
  onConnect?: WsLifecycleDefinition
  onDisconnect?: WsLifecycleDefinition
  handlers: WsHandlerDefinition[] // declaration order, bases first
}
interface WsLifecycleDefinition {
  method: string
  invoke: (gateway: any, connection: WsConnection) => unknown
}
interface WsHandlerDefinition {
  method: string
  event?: string // absent: default handler
  meta: Record<string, unknown> // route decorators of the method (merged over the gateway's at boot, nearest wins)
  guards: Token[] // @UseMessageGuard on the method
  params: { index: number; source: 'payload' | 'connection' | 'context'; schema?: boolean; optional?: boolean }[] // informational
  invoke: (gateway: any, ctx: WsMessageContext) => unknown
}
```

Optional fields are omitted when absent; values are literals of the shared emitter (§3.3 of the
architecture), so `generate --check` and the golden test cover the section.

### 7.2 Generated code (target shape, `serve` mode, abridged)

```ts
import type { WsConnection, WsMessageContext } from '@znight/websocket'
import { validatePayload } from '@znight/websocket'
import { ChatGateway } from '../chat/chat.gateway.js'
import { JoinRoom, KickUser, SendMessage } from '../chat/chat.protocol.js'
// ...
  extensions: {
    ['websocket']: {
      ['gateways']: [
        {
          ['token']: 'src/chat/chat.gateway.ts#ChatGateway',
          ['path']: '/chat',
          ['protocol']: 'events',
          ['protocols']: ['chat.v1'],
          ['rateLimit']: { ['messages']: 30, ['intervalMs']: 1000, ['onLimit']: 'reject' },
          ['meta']: { ['authenticated']: true },
          ['handshakeGuards']: ['src/chat/connection-quota.guard.ts#ConnectionQuotaGuard'],
          ['messageGuards']: [],
          ['onConnect']: { ['method']: 'connected', ['invoke']: (g: ChatGateway, c: WsConnection) => g.connected(c as never) },
          ['onDisconnect']: { ['method']: 'disconnected', ['invoke']: (g: ChatGateway, c: WsConnection) => g.disconnected(c as never) },
          ['handlers']: [
            {
              ['method']: 'join',
              ['event']: 'room.join',
              ['meta']: {},
              ['guards']: [],
              ['params']: [{ ['index']: 0, ['source']: 'connection' }, { ['index']: 1, ['source']: 'payload', ['schema']: true }],
              ['invoke']: async (g: ChatGateway, m: WsMessageContext) =>
                g.join(m.connection as never, await validatePayload(JoinRoom, m.data)),
            },
            {
              ['method']: 'kick',
              ['event']: 'room.kick',
              ['meta']: { ['roles']: ['moderator'] },
              ['guards']: ['src/chat/moderator.guard.ts#ModeratorGuard'],
              ['params']: [{ ['index']: 0, ['source']: 'payload', ['schema']: true }],
              ['invoke']: async (g: ChatGateway, m: WsMessageContext) => g.kick(await validatePayload(KickUser, m.data)),
            },
            // send: like join, with SendMessage
          ],
        },
      ],
    },
  },
```

### 7.3 `invoke` generation

| Parameter                            | Expression                                                     |
| ------------------------------------ | -------------------------------------------------------------- |
| `@Payload()`                         | `m.data as never`                                              |
| `@Payload(S)`                        | `await validatePayload(S, m.data)` (the arrow becomes `async`) |
| `@Conn()`                            | `m.connection as never` (`c as never` in lifecycle invokers)   |
| `@Ctx()`                             | `m`                                                            |
| optional parameter without decorator | `undefined`                                                    |

`as never` keeps the handler's own `WsConnection<TData, E>` generics. Unused arrow parameters are
omitted (`noUnusedParameters`); the generated module imports `validatePayload` and the types only when
used. Runtime helpers exported by `@znight/websocket` for generated code:

```ts
/** Standard Schema validation; throws WsValidationException (BAD_REQUEST, details [{ path, message }]). */
function validatePayload<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): InferSchemaOutput<S> | Promise<InferSchemaOutput<S>>
```

### 7.4 Manifest and package layout

```jsonc
"znight": {
  "apiVersion": 1,
  "compiler": "@znight/websocket/compiler",
  "provides": [
    { "export": "WsServer", "plugin": "WebSocketPlugin", "scope": "singleton" },
    { "export": "WebSocketPlugin", "plugin": "WebSocketPlugin", "scope": "singleton" },
    { "export": "WsConnection", "plugin": "WebSocketPlugin", "scope": "request" }
  ]
}
```

Tokens: `@znight/websocket#WsServer`, `#WebSocketPlugin`, `#WsConnection` (`WsTokens`). Subpath
exports: `.` (decorators, plugin, `WsServer`, types, exceptions, `validatePayload`, `jsonCodec`),
`./ws` (`wsTransport`), `./bun` (`bunTransport`), `./testing` (`createTestConnection`,
`createTestServer`), `./compiler`. `src/` follows the repository rules (`.ts` imports,
`erasableSyntaxOnly`, `isolatedDeclarations`, no decorators in sources).

## 8. Runtime architecture

### 8.1 Overview

```text
                 ┌──────────────────────── HttpPlugin (owns server, port, pipeline) ─────────────────────┐
 client ── TCP ─►│ adapter: node | express | fastify | hono(@hono/node-server) | hono(Bun.serve)          │
                 │   ├─ ordinary request ───────────────► pipeline ─► guards ─► controllers             │
                 │   └─ GET + upgrade: websocket on a gateway path (upgrade table, raw path)            │
                 │        └─► pipeline: runInScope{HttpContext, RequestId} ─► hooks.run('http:request')  │
                 │              ─► protocol checks ─► origin ─► global guards ─► handshake guards        │
                 │              ─► UpgradeProvider.accept ─────────────────────────────────────────────┐ │
                 └────────────────────────────────────────────────────────────────────────────────────┼─┘
                                                                                                      ▼
   WebSocketPlugin ── transport (ws | bun | memory) ── WsConnection (scope held until close)
        │                                       └─ inbound queue ─► hooks.run('websocket:message')
        ├─ WsServer / GatewayChannel / rooms             ─► decode ─► handler ─► message guards ─► invoke ─► reply
        └─ heartbeat timer, stats, shutdown
```

### 8.2 Changes to `@znight/http` (P0 prerequisites)

#### 8.2.1 Upgrade routes on `HttpPlugin`

```ts
// @znight/http
export interface UpgradeProvider {
  readonly name: string // plugin name, in messages
  readonly routes: readonly UpgradeRoute[]
  /** Server-wide settings the adapter needs before listening (Bun.serve `websocket` handlers). */
  serverOptions?(runtime: 'node' | 'bun'): { readonly bunWebSocket?: unknown } | undefined
  /** Called when HttpPlugin.onStop starts: refuse new upgrades, close connections gracefully. Idempotent. */
  drain?(): Promise<void>
}
export interface UpgradeRoute {
  readonly path: string // without the plugin prefix
  readonly owner: Token // gateway token: ctx.route.controller, route summaries
  readonly meta: Readonly<Record<string, unknown>> // ctx.route.meta during the handshake
  readonly guards: readonly Token[] // after the global guards
  /** Cheap checks before the guards (origin, subprotocols, capacity). Throw an HttpException to refuse. */
  precheck?(ctx: HttpContext): void | Promise<void>
  /** After the guards: take the connection. Throw an HttpException to refuse. */
  accept(ctx: HttpContext, upgrade: PendingUpgrade): Promise<void>
}
export interface PendingUpgrade {
  readonly native: NodeUpgrade | BunUpgrade | MemoryUpgrade
  /** Headers of the 101 response: ctx headers, wrappers' responseHeaders, the request id. */
  readonly headers: Readonly<Record<string, HeaderValue>>
  /** The request scope (and the in-flight count) stays open until `closed` settles. */
  hold(closed: Promise<void>): void
}
type NodeUpgrade = {
  readonly kind: 'node'
  readonly request: IncomingMessage
  readonly socket: Duplex
  readonly head: Uint8Array
}
type BunUpgrade = { readonly kind: 'bun'; readonly request: Request; readonly server: unknown }
type MemoryUpgrade = { readonly kind: 'memory'; readonly peer: unknown }

class HttpPlugin {
  /** From another plugin's register/onBootstrap, before the server listens (ZNIGHT031 afterwards). */
  addUpgradeProvider(provider: UpgradeProvider): void
  /** In-memory handshake (WebSocketPlugin.connect): the same pipeline, without the adapter. */
  upgradeInMemory(request: InjectRequest, native: MemoryUpgrade): Promise<InjectResponse | undefined>
}
```

- Upgrade routes live in their **own route table**, consulted only for upgrade requests, so they
  can be added after `HttpPlugin.onBootstrap` (plugin order does not matter) and never change the
  ordinary routing. The prefix applies; trailing slashes follow `trailingSlash`, except that
  `'redirect'` behaves as `'ignore'` (WebSocket clients do not follow redirects).
- A plain `GET` on a gateway path without an HTTP route answers **`426 Upgrade Required`** with
  `upgrade: websocket` (fallback handler) instead of `404`. An HTTP route on the same path keeps
  serving plain requests (a page and its socket may share `/chat`).
- `plugin.routes` lists upgrade routes too (`method: 'GET'`, `upgrade: 'websocket'`), and the RFC
  0001 boot check covers them like any route.
- `HttpPlugin.onStop` calls the providers' `drain()` together with its own drain, within
  `drainTimeoutMs`; `WebSocketPlugin.onStop` calls the same idempotent drain, so either plugin order
  shuts down cleanly.

#### 8.2.2 The upgrade pipeline (normative)

A new pipeline target `upgrade` reuses `#serve`: same scope seeds, same `http:request` event
(`route` = gateway pattern), same exception mappers and error rendering.

1. **Protocol checks**: `sec-websocket-version` must be `13` (else `426` with
   `sec-websocket-version: 13`); `sec-websocket-key` must be a base64 16-byte nonce (else `400`).
2. **Draining**: `503` with `retry-after: 1` and `connection: close`.
3. `precheck`: origin (`403`), subprotocol (`400 Unsupported WebSocket subprotocol`), capacity (`503`).
4. Global guards, then the route's guards (`ctx.route.meta` = gateway meta). `false` → `403`.
5. `accept`: the transport completes the handshake (`101`, `event.status = 101`).
6. `hooks.run('http:request')` resolves: the handshake is logged and measured (`status: 101`,
   duration of the handshake only).
7. The scope stays open until the connection's `closed` promise settles (after `@OnDisconnect`);
   it is then disposed like any request scope.

A refusal is rendered as an `AdapterReply` and written by the adapter (raw HTTP/1.1 on the socket
for `node`, a `Response` for `bun`, a `WsHandshakeError` for `memory`). The handshake is bounded by
`handshakeTimeoutMs` (`408`).

#### 8.2.3 The adapter capability

```ts
interface HttpAdapter {
  // ...existing members
  /** Optional: WebSocket upgrades. Absent → ZNIGHT031 when gateways exist. */
  readonly upgrades?: AdapterUpgrades
}
interface AdapterUpgrades {
  readonly runtime: 'node' | 'bun'
  /** Called once before listen() when the plugin has upgrade routes. */
  enable(options: {
    /** Whether a websocket upgrade request (raw target, headers) is for Znight. */
    readonly match: (url: string, headers: Readonly<Record<string, string | undefined>>) => boolean
    /** Runs the upgrade pipeline; resolves with a refusal to write, or undefined once the transport took over. */
    readonly handle: (request: AdapterRequest, native: NodeUpgrade | BunUpgrade) => Promise<AdapterReply | undefined>
    readonly bunWebSocket?: unknown
  }): void
}
```

| Adapter            | Runtime   | Interception                                                                   | Transport (`auto`)  |
| ------------------ | --------- | ------------------------------------------------------------------------------ | ------------------- |
| `nodeAdapter()`    | Node      | its `http.Server`: `shouldUpgradeCallback` + `'upgrade'`                       | `ws` (npm)          |
| `nodeAdapter()`    | Bun       | same (Bun's `node:http` supports both, verified)                               | `ws` = Bun built-in |
| `expressAdapter()` | Node, Bun | the server it creates or receives                                              | `ws`                |
| `fastifyAdapter()` | Node, Bun | `instance.server`                                                              | `ws`                |
| `honoAdapter()`    | Node      | the `@hono/node-server` server (its own `websocket` option is not used)        | `ws`                |
| `honoAdapter()`    | Bun       | `#bunFetch`, before Hono routing; `websocket` handlers passed to `Bun.serve()` | Bun native          |
| `connect()`        | any       | `HttpPlugin.upgradeInMemory`                                                   | memory              |
- `shouldUpgradeCallback` is **composed**: `req => match(req) || previous(req)`, where `previous` is
  the server's callback before Znight (Node's default counts `'upgrade'` listeners). Znight's
  `'upgrade'` listener ignores requests it does not match, so a user-provided server can keep its
  own upgrade handlers (GraphQL over WebSocket on another path). **Impl.** On Node < 24.12 (no
  `shouldUpgradeCallback`), Znight answers every websocket upgrade: `404` on non-gateway paths.
  `@znight/websocket` declares `engines.node >= 24.12`.
- `@fastify/websocket` (or any other upgrade handler) must not claim gateway paths; documented.
- `honoAdapter().fetch` (a server Znight does not own) cannot upgrade: ZNIGHT031.

#### 8.2.4 Two small http API changes

- `RouteDecorator<T>.get(ctx: RouteMetaCarrier)` with
  `interface RouteMetaCarrier { readonly route?: { readonly meta: Readonly<Record<string, unknown>> } | undefined }`
  (backward compatible: `HttpContext` satisfies it).
- `@znight/http/compiler` exports `readRouteMeta` and `requiredRouteGroups` (§6.4).

### 8.3 Transports

```ts
export interface WebSocketTransport {
  readonly name: string // 'ws' | 'bun' | 'memory'
  readonly accepts: 'node' | 'bun' | 'memory' // which native upgrade it completes
  /** Server-wide settings, once at bootstrap (limits, compression, heartbeat). */
  configure(settings: TransportSettings): void
  /** Completes an accepted handshake. `events` receives the socket events of this connection. */
  accept(
    native: NodeUpgrade | BunUpgrade | MemoryUpgrade,
    init: AcceptInit,
    events: SocketEvents,
  ): TransportSocket | Promise<TransportSocket>
  /** Bun only: the `websocket` handlers of Bun.serve(). */
  bunWebSocket?(): unknown
  close(): Promise<void>
}
interface AcceptInit {
  readonly protocol: string // '' when none
  readonly headers: Readonly<Record<string, HeaderValue>> // extra 101 headers
  readonly maxPayload: number
}
interface SocketEvents {
  message(frame: string | Uint8Array, binary: boolean): void
  pong(): void
  drain(): void
  close(code: number, reason: string): void
}
interface TransportSocket {
  send(frame: string | Uint8Array, binary: boolean): 'sent' | 'queued' | 'dropped'
  readonly bufferedAmount: number
  ping(): void
  pause(): boolean // false when unsupported
  resume(): void
  close(code: number, reason: string): void
  terminate(): void
  readonly extensions: string
}
```

|               | `ws` (`wsTransport`)                                                                                                                                                                        | Bun (`bunTransport`)                                                                                                                                                                                                                   | memory              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Accept        | `new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate, handleProtocols })`; `handleUpgrade(req, socket, head)` after the guards; extra headers through the `'headers'` event | `server.upgrade(request, { data: binding, headers })`; `open` may run **inside** `upgrade()`, so the binding is complete before the call                                                                                               | in-process pair     |
| Inbound limit | `maxPayload` per server = plugin `maxPayload`; smaller gateway limits checked per message                                                                                                   | `maxPayloadLength` = plugin value (server-wide); gateway limits checked per message                                                                                                                                                    | checked per message |
| Send status   | `bufferedAmount` vs limit; `send(cb)` callbacks track drain                                                                                                                                 | `send()` → `n` / `-1` (queued) / `0` (dropped); `backpressureLimit` = the largest limit of any gateway, `closeOnBackpressureLimit: false`: the per-gateway policy is applied by the plugin from `getBufferedAmount()`; `drain` handler | immediate           |
| Pause reading | `ws.pause()` / `resume()`                                                                                                                                                                   | `ws.pause()` / `resume()` (Bun 1.4.x; feature-detected)                                                                                                                                                                                | queue               |
| Heartbeat     | shared timer, ping frames (§8.7)                                                                                                                                                            | `idleTimeout` + `sendPings`                                                                                                                                                                                                            | none                |
| Errors        | an `'error'` listener on every socket (an unhandled one kills the process)                                                                                                                  | `error` handler                                                                                                                                                                                                                        | —                   |
| Loading       | `ws` loaded lazily (non-literal dynamic import), optional peer on Node; Bun's built-in on Bun                                                                                               | no import                                                                                                                                                                                                                              | —                   |

`'auto'` picks `bun` when the adapter's `upgrades.runtime` is `bun`, `ws` otherwise. The transport
socket is the only object holding native handles; after `accept`, `conn.handshake` is a detached
`HttpContext` (native request and response set to `undefined`, body methods throw) so that a
connection never retains the `IncomingMessage` or its buffers.

### 8.4 Connection lifecycle and message pipeline (normative)

1. **Open.** After the `101`, the plugin emits `websocket:connection` (`type: 'open'`) and enqueues
   `@OnConnect` as the first task of the connection. Messages received meanwhile wait in the queue.
2. **Inbound frame.** Size check (gateway `maxPayload`: close `1009`), rate limit (`reject` →
   `RATE_LIMITED`; `close` → `4429`), then the frame joins the connection's queue; at
   `maxPendingMessages` the transport pauses reading (TCP backpressure) and resumes at half; a
   transport that cannot pause closes the connection with `1008` at twice the limit.
3. **Dispatch.** Up to `concurrency` tasks run at a time, each in the connection's captured async
   context (the handshake scope, `AsyncLocalStorage.snapshot()`), through
   `hooks.run('websocket:message', event, ...)`:
   1. decode (`events`: codec; `$ping` is answered before the hook and counted apart);
   2. select the handler: the exact event, else the default handler, else `UNKNOWN_EVENT`
      (`outcome: 'unhandled'`);
   3. message guards: plugin `messageGuards` → gateway → method (`outcome: 'rejected'` → `FORBIDDEN`);
   4. `invoke` (payload validation inside), bounded by `handlerTimeoutMs` (`TIMEOUT`; the handler's
      `ctx.signal` is aborted, its promise is left to settle, a late result is discarded);
   5. reply: `{ id, data }` when the frame had an `id`; errors as `{ id, error }` or `$error`.
      `event.outcome` / `event.error` are set before `run` resolves.
4. **Close** (client frame, `conn.close()`, heartbeat, backpressure, shutdown, error):
   `readyState = 'closing'`, `conn.signal` aborted, queued messages discarded, running tasks awaited
   (each bounded by its handler timeout), `@OnDisconnect` (only after a successful `@OnConnect`;
   errors logged), rooms left, `websocket:connection` (`type: 'close'`, code, reason, initiator,
   duration), then the held scope is released (request-scoped instances disposed).

`WsMessageContext`:

```ts
interface WsMessageContext {
  readonly connection: WsConnection
  readonly event: string | undefined // undefined on raw gateways
  readonly id: string | number | undefined
  readonly data: unknown // decoded `data` (events) or the frame (raw)
  readonly binary: boolean
  readonly bytes: number
  readonly receivedAt: number // performance.now()
  readonly signal: AbortSignal // aborted on timeout or when the connection closes
  readonly state: Map<string | symbol, unknown> // per message: guards → handler
  readonly route: {
    readonly path: string
    readonly gateway: Token
    readonly handler: string | undefined
    readonly event: string | undefined
    readonly meta: Readonly<Record<string, unknown>>
  }
}
```

### 8.5 Outbound path and backpressure

- `conn.emit` encodes with the codec, then sends; a broadcast encodes once. A frame for a closing
  or closed connection is `'dropped'` silently.
- **Before** sending, if `bufferedAmount + frame size > backpressure.limit` (the gateway's, else the
  plugin's): `onLimit: 'close'`
  closes with `1013` ("slow consumer", `initiator: 'backpressure'`); `onLimit: 'drop'` drops the
  frame. Both are counted in `stats()`. No unbounded queue exists anywhere in Znight.
- `await conn.drained()` lets producers follow the client's pace (resolves below a low-water mark
  of `limit / 4`; rejects with `WsClosedError` once the connection closes). `send` returning
  `'queued'` is the signal to await it:

```ts
@Gateway({ path: '/ticker/:symbol', protocol: 'raw' })
@Public()
export class TickerGateway {
  constructor(private readonly prices: PriceFeed) {}

  @OnConnect()
  start(@Conn() conn: WsConnection): void {
    const symbol = conn.params['symbol'] ?? ''
    if (!this.prices.has(symbol))
      throw new WsException('NOT_FOUND', `Unknown symbol ${symbol}`, undefined, { close: 4404 })
    // not awaited: @OnConnect must return for the connection to receive messages
    this.#pump(conn, symbol).catch(() => conn.close(1011, 'Feed failed'))
  }

  async #pump(conn: WsConnection, symbol: string): Promise<void> {
    for await (const tick of this.prices.ticks(symbol, conn.signal)) {
      if (conn.send(encodeTick(tick)) === 'queued') await conn.drained() // binary frames at the client's pace
    }
  }
}
```

### 8.6 Limits summary

| Limit              | Default                           | Enforced by                                   | Exceeded                                            |
| ------------------ | --------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Inbound message    | 1 MiB (plugin), lower per gateway | transport (server-wide), plugin (per gateway) | close `1009`                                        |
| Inbound queue      | 32 messages                       | plugin                                        | pause reading; `1008` if the transport cannot pause |
| Message rate       | none (per gateway)                | plugin, token bucket                          | `RATE_LIMITED` or close `4429`                      |
| Outbound buffer    | 1 MiB                             | plugin (`ws`), Bun (`backpressureLimit`)      | close `1013` or drop                                |
| Connections        | `Infinity`                        | plugin, at the handshake                      | `503`                                               |
| Handshake duration | 10 s                              | plugin                                        | `408`                                               |
| Handler duration   | 30 s                              | plugin                                        | `TIMEOUT`                                           |
| Close handshake    | 2 s                               | transport                                     | terminate                                           |

Per-IP connection limits are a handshake guard (`ctx.ip`, correct behind proxies with RFC 0001's
`trustProxy`), shown in the guide.

### 8.7 Heartbeats

- **Contract**: a connection that sends nothing (no frame, no pong) for `2 × intervalMs` is
  terminated (`initiator: 'heartbeat'`, local code `1006`). Browsers answer ping frames by
  themselves.
- **`ws`**: one timer per plugin, not per connection: every `intervalMs`, a connection not seen
  alive since the previous tick is terminated, the others are marked and pinged. Any inbound frame
  or pong marks it alive. The timer is `unref()`ed (the server keeps the process alive).
- **Bun**: `idleTimeout = min(960, ceil(2 × intervalMs / 1000))` seconds with `sendPings: true`
  (Bun pings before the deadline). **Impl.** Detection granularity differs slightly.
- `heartbeat: false`: no pings; Bun's `idleTimeout` is set to `0`.

### 8.8 Rooms, broadcast and the cluster seam

Rooms are `Map<room, Set<connection>>` per gateway, plus each connection's own set. Every broadcast
goes through one internal function, `deliver({ gateway, rooms, except, frame, binary })`, taking an
**already encoded** frame. A v0.2 cluster bridge (Redis pub/sub, or `@znight/messaging` fan-out)
will wrap `deliver` without API change; that is why broadcasts return `void`. Until then the guide
shows the multi-instance pattern: publish through `@znight/messaging` (a topic consumed by every
instance, e.g. Kafka with a per-instance `groupId`), broadcast locally in the consumer.

Bun's native `server.publish()` is **not** used in v0.1 (open question Q5): it would duplicate room
membership in Bun, exclude the sender by default and bypass the per-recipient policy.

### 8.9 Plugin lifecycle and graceful shutdown

| Hook          | `WebSocketPlugin`                                                                                                                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`    | Declares `WsConnection` (request external), registers `WsServer` and itself; finds `HttpPlugin` (`ctx.getPlugin('http')`, else ZNIGHT031)                                                                                                                                     |
| `onBootstrap` | Resolves and validates options and metadata (ZNIGHT030), resolves guards and mappers (ZNIGHT001), selects the transport (ZNIGHT031), builds gateway plans (effective meta per handler), calls `http.addUpgradeProvider()`                                                     |
| `onStart`     | Starts the heartbeat timer. The server itself listens in `HttpPlugin.onStart`                                                                                                                                                                                                 |
| `onStop`      | `drain()`: refuse handshakes (`503`), stop the heartbeat, close every connection with `shutdown.code` / `reason` (in parallel), wait for close frames, running handlers and `@OnDisconnect` up to `shutdown.timeoutMs`, terminate the rest (their `@OnDisconnect` still runs) |
| `onDispose`   | `transport.close()` (`wss.close()`), release timers                                                                                                                                                                                                                           |

Ordering against `HttpPlugin` does not matter (§8.2.1). Configure
`shutdown.timeoutMs < HttpPlugin.drainTimeoutMs < shutdown.hookTimeoutMs` (defaults 3 s < 4 s < 5 s).
With HMR (`hot`), the old application closes its sockets and clients reconnect to the new one;
`shutdown.code: 1012` tells them it is a restart.

A plugin instance serves one application at a time (ZNIGHT004 otherwise, like `HttpPlugin`).

### 8.10 Hooks and observability

Two hooks are declared in `@znight/core` (`ZnightHooks`), so observers do not depend on the
package:

```ts
interface WebSocketMessageEvent {
  // 'websocket:message' (run / wrap, one per inbound message)
  readonly gateway: string // display name
  readonly path: string // gateway pattern, prefix included
  readonly event: string | undefined
  readonly handler: string | undefined
  readonly connectionId: string
  readonly requestId: string // the handshake's
  readonly bytes: number
  readonly context: unknown // WsMessageContext
  readonly startTime: number
  outcome?: 'ok' | 'error' | 'rejected' | 'unhandled' | 'timeout'
  error?: unknown
}
interface WebSocketConnectionEvent {
  // 'websocket:connection' (emit only)
  readonly type: 'open' | 'close'
  readonly gateway: string
  readonly path: string
  readonly connectionId: string
  readonly requestId: string
  readonly connection: unknown // WsConnection
  readonly openedAt: number
  readonly code?: number
  readonly reason?: string
  readonly initiator?: WsCloseInfo['initiator']
}
```

No hook runs per **outbound** frame (hot path); totals come from `stats()`.

`@znight/observability` gains (each switchable like the HTTP and messaging parts):

- **Handshakes**: nothing new, they are `http:request` events (`status: 101`, `route: '/chat'`).
- **Logs**: one `info` entry per closed connection (gateway, duration, code, initiator, messages
  in/out); message entries at `debug` (off by default, `logging.websocket.messages`); errors at
  `error` with the stack once. Log entries inside a connection carry its `requestId` (same scope)
  and `connectionId`.
- **Metrics** (prom-client): `websocket_connections_active` (gauge, `gateway`),
  `websocket_connections_total` (`gateway`, `initiator`), `websocket_messages_received_total` and
  `websocket_message_duration_seconds` (`gateway`, `event`, `outcome`; `event` is `unmatched` for
  unknown events and capped at 50 values per gateway, then `_OTHER`, like messaging types),
  `websocket_messages_sent_total`, `websocket_frames_dropped_total`,
  `websocket_slow_consumer_closes_total` (collected from `stats()`).
- **Traces**: one span per message (`WS <path> <event>`, kind `SERVER`), a **new trace** linked to
  the handshake's span context: a connection lives for hours, its messages must not be children of
  a long-ended HTTP span.

### 8.11 Performance targets (bench suite, Node and Bun, not CI-gating)

- Handshake overhead (no guard) within 15 % of a bare `ws` / `Bun.serve()` upgrade.
- Dispatch of a validated small message: < 5 µs of Znight overhead per message beyond the schema.
- Broadcast of a 100-byte event to 10 000 local connections: one encode, < 15 ms on `ws`/Node.
- < 2 KiB of Znight state per idle connection (transport excluded), no timer per connection.

### 8.12 Security considerations

- **CSWSH**: origin check on by default, before any guard (§5.6).
- **Resource exhaustion**: every buffer is bounded (§8.6); compression off by default
  (`maxPayload` applies after decompression on both transports); `rateLimit`, `maxConnections`,
  heartbeat and handshake timeout close the usual doors.
- **Secrets in URLs**: tickets (single use, 30 s) rather than tokens in the query; the
  `http:request` event and logs carry the path without query string.
- **Error disclosure**: `INTERNAL` without message unless `exposeErrors`.
- **Input**: payloads are validated by schemas (ZNIGHT017 flags unvalidated non-primitive ones);
  `JSON.parse` keeps `__proto__` as an own property; the envelope reader copies only known fields.

## 9. Dependencies

| Package                                                             | Kind              | Version                         | Why                                                                                                                 |
| ------------------------------------------------------------------- | ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@znight/core`                                                      | dependency        | `workspace:*` (lockstep)        | container, hooks, errors                                                                                            |
| `@znight/http`                                                      | dependency        | `workspace:*` (lockstep)        | the server, the pipeline, `HttpContext`, exceptions, `@znight/http/path` and `/compiler` helpers                    |
| `ws`                                                                | **optional peer** | `^8.21.0` (dev: exact `8.22.0`) | the Node.js transport. Not needed on Bun (built-in). No `@types/ws`: the transport declares the few members it uses |
| `@znight/compiler`                                                  | optional peer     | `workspace:^`                   | compiler extension types                                                                                            |
| `hono`, `fastify`, `express`, `@hono/node-server`, `zod`, `valibot` | dev               | exact (as `@znight/http`)       | adapter matrix and schema tests                                                                                     |

Not used, deliberately:

- **`bufferutil`, `utf-8-validate`** (optional peers of `ws`): native addons with install friction;
  `ws` 8 validates UTF-8 with Node's `buffer.isUtf8`. Users may add `bufferutil` for large binary
  frames; the bench suite measures it.
- **`crossws`** (0.4.16, unjs): cross-runtime hooks over Node/Bun/Deno/uWS, but no drain signal, a
  vendored `ws` on Node, API breaks across 0.x minors, and its own upgrade flow would bypass the
  Znight pipeline and scope.
- **`@fastify/websocket`** (11.3.4, on `ws` ^8.16), **`@hono/node-ws`**, `@hono/node-server` 2's
  `websocket` option, **`hono/bun`** helpers (deprecated in favour of `@hono/bun` for Hono 5),
  **`express-ws`**: one integration per adapter, each with different semantics, exactly what
  `@znight/http` avoids. Hono's `WSContext` has no backpressure, drain or pause.
- **Socket.IO** 4.x: a protocol, transports and adapters of its own; a possible third-party
  integration, not the foundation.
- **uWebSockets.js**: fastest, but distributed from GitHub only with native binaries; Bun already
  embeds uWS for the `bun` transport.

Ecosystem facts used here: versions of `ws` (8.22.0), `crossws` (0.4.16) and `@fastify/websocket`
(11.3.4) read from the npm registry on 2026-10-26; `hono` 4.13.14, `@hono/node-server` 2.1.5 and
`bun-types` 1.4.4 read in `node_modules`; Node 24.21 and Bun 1.4.4 behaviours verified with scratch
probes (§2); the Node version of `shouldUpgradeCallback` (24.12 / 25.1) and Bun's
`ServerWebSocket.pause()` (1.4.x reference) come from their documentation; statements about
Socket.IO, uWebSockets.js and `express-ws` rely on prior knowledge.

## 10. Open questions (with the recommended answer)

| #   | Question                                                                 | Recommendation                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Should the plugin run its own server when there is no `HttpPlugin`?      | **No.** One server keeps one set of guards, hooks, proxy and CORS settings, and one drain. A WebSocket-only service uses `HttpPlugin` without controllers (ZNIGHT031 says so)  |
| Q2  | Handshake guards: reuse HTTP guards, or a WebSocket-specific auth layer? | **Reuse HTTP guards.** The handshake _is_ HTTP; message guards cover per-event decisions                                                                                       |
| Q3  | Request scope per connection or per message?                             | **Per connection** (Spring's session scope; NestJS has none). Per-message values are arguments. Revisit a `messageScope` option only on demand: it needs nested scopes in core |
| Q4  | Envelope: Socket.IO-compatible, JSON-RPC 2.0, or our own?                | **Our own minimal envelope** (`event`/`data`/`id`), plus `raw` and pluggable codecs. Socket.IO compatibility drags its transports; JSON-RPC lacks server events                |
| Q5  | Use Bun's native `publish()` for rooms?                                  | **Not in v0.1**: uniform semantics and per-recipient backpressure first; adopt behind the internal `deliver` seam if the bench shows > 2× on Bun                               |
| Q6  | Default origin policy?                                                   | **`'same-origin'`** (+ requests without `Origin`): secure by default, like Spring. Development front-ends on another port configure `origins`                                  |
| Q7  | Validate outbound events at runtime?                                     | **No** (types only): cost on the hot path, and the server controls what it sends. A development-only check can come later                                                      |
| Q8  | Ship a browser client in v0.1?                                           | **No.** Document the protocol; `TestWsClient` stays a test tool. A typed client generated from the metadata (and AsyncAPI) in v0.2                                             |
| Q9  | Slow consumers: close or drop by default?                                | **Close (`1013`)**: dropping silently corrupts stateful streams; `onLimit: 'drop'` for lossy feeds (tickers, cursors)                                                          |
| Q10 | Should a handler's return value be sent without `id`?                    | **No**: replies are for requests only, so fire-and-forget stays free. A development `debug` log flags ignored results                                                          |
| Q11 | Default heartbeat?                                                       | **30 s** (detection within 60 s), below common proxy idle timeouts (60 s on AWS ALB and nginx)                                                                                 |
| Q12 | Rejected handshakes: HTTP status or accept-then-close?                   | **HTTP status** (standard, cheap, no socket for intruders); the `4401` close from `@OnConnect` is the documented alternative for browsers                                      |
| Q13 | Rooms across instances in v0.1?                                          | **No public API**: the internal seam only, and the messaging fan-out pattern in the guide                                                                                      |
| Q14 | `@Payload` vs reusing `@Message` (messaging) or `@Body` (http)?          | **`@Payload`**: "message" means the whole frame in WebSocket vocabulary; separate identities keep the extensions independent                                                   |
| Q15 | Minimum versions?                                                        | `node >= 24.12` (`shouldUpgradeCallback`; earlier 24.x works with the documented fallback) and `bun >= 1.3` (`pause` feature-detected)                                         |

## 11. Implementation plan

### 11.1 Milestones and tasks (one developer)

| #      | Milestone / task                                                                                                                                                                                                                                      | Priority      | Days       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------- |
| **M0** | **Prerequisites in core and http**                                                                                                                                                                                                                    |               |            |
| T1     | Core: `ZNIGHT030`/`031` (`ErrorCode`, descriptions, error-codes page), `websocket:message` / `websocket:connection` hook types                                                                                                                        | P0            | 0.5        |
| T2     | Http: `UpgradeProvider`, upgrade route table, `upgrade` pipeline target with scope hold, protocol checks, 426 fallback, route summaries, drain integration, `upgradeInMemory`                                                                         | P0            | 3          |
| T3     | Http adapters: `upgrades` capability for node, express, fastify, hono/Node (composed `shouldUpgradeCallback`, raw refusal writer) and hono/Bun (fetch interception, `websocket` handlers)                                                             | P0            | 2          |
| T4     | Http: `RouteMetaCarrier`, `readRouteMeta`, `requiredRouteGroups` exports; boundaries test update                                                                                                                                                      | P0            | 0.5        |
| **M1** | **Runtime**                                                                                                                                                                                                                                           |               |            |
| T5     | Transports `ws`, `bun`, `memory` + a shared conformance suite                                                                                                                                                                                         | P0            | 2.5        |
| T6     | Connection, codec and envelope, queue/concurrency/pause, rate limit, timeouts, replies, errors and close codes                                                                                                                                        | P0            | 3          |
| T7     | Rooms, `WsServer`, `GatewayChannel`, broadcast (encode once), outbound backpressure, `drained()`                                                                                                                                                      | P0            | 1.5        |
| T8     | Plugin: options, metadata validation, origin/protocol/capacity prechecks, heartbeat, shutdown, `stats()`, `connect()`, `initRoots()`                                                                                                                  | P0            | 2.5        |
| **M2** | **Compiler extension**: analyze, validate, generate, diagnostics, snapshots, golden test of a fixture app                                                                                                                                             | P0            | 3          |
| **M3** | **Testing**: `TestApp.connect`, `connectWebSocket`, `TestWsClient`, closure roots; `@znight/websocket/testing` fakes                                                                                                                                  | P0            | 1.5        |
| **M4** | **Observability**: logs, metrics, linked spans                                                                                                                                                                                                        | P1            | 1.5        |
| **M5** | **Docs and tooling**: README, architecture (§2, §4.8, §5, §7, §8.3, §9.1, new §9.5, §10, §11), `docs/packages/websocket.md`, `docs/guide/websockets.md`, decorators reference; CLI `znight g gateway`, `znight new --features websocket`; bench suite | P0 (bench P1) | 3          |
| **M6** | **Wave 7**: `examples/realtime-chat` (§12)                                                                                                                                                                                                            | P0            | 3          |
|        | **Total** (P0 ≈ 25)                                                                                                                                                                                                                                   |               | **≈ 27.5** |

Order: T1 → T2–T4 (one pull request: http stays green, upgrade routes tested with a fake
provider) → T5–T8 → M2 → M3 → M4/M5 → M6. RFC 0001 is not a prerequisite; when both land, the
ZNIGHT023 checks cover handshakes (one test each side).

### 11.2 Test plan

- **Unit (runtime, `packages/websocket/test`)**: envelope codec (ids, reserved events, malformed
  frames, unknown fields, `__proto__`), `validatePayload` with Zod and Valibot, error mapping table,
  close codes, scheduler (order with `concurrency: 1`, parallelism, `@OnConnect` first,
  `@OnDisconnect` last and only after a successful connect), pause/resume thresholds, rate limiter,
  handler timeout (fake timers), rooms (join/leave/auto-leave, empty room removal, union and
  except), broadcast encode-once (codec spy), backpressure (`close` vs `drop`, `drained()`),
  heartbeat (fake timers; one timer for N connections), stats, options validation (ZNIGHT030),
  transport selection (ZNIGHT031), detached handshake context.
- **Transport conformance** (one suite, three transports): accept with headers and subprotocol,
  text/binary frames, size limit `1009`, send statuses, pause, ping/pong, close handshake and close
  timeout, terminate, error listener present.
- **Http pipeline**: the upgrade target in `packages/http/test` with a fake provider: protocol
  checks (`426`, `400`), draining `503`, origin and guard refusals rendered by exception mappers,
  `http:request` event with `status: 101`, scope held until `closed`, `426` on plain GET, an HTTP
  route and a gateway sharing a path, prefix and trailing-slash policies, `plugin.routes`.
- **Adapter parity** (`adapters.test.ts` style, every case on node, fastify, express, hono): real
  sockets with the global `WebSocket` client: accept, refuse (`401` raw response read with a plain
  `http.request`), headers on `101`, non-gateway upgrades untouched (`shouldUpgradeCallback`
  composition with a user `'upgrade'` listener), `@fastify/websocket`-free coexistence of Fastify
  routes, shutdown with `1001`. Runs under **Node** (`ws` npm) and **Bun** (built-in `ws`, and the
  native transport through `hono-bun.test.ts`).
- **Compiler (`test/compiler`)**: fixture app; analysis of options, handlers, inheritance,
  parameters; every ZNIGHT030 case with location, hint and related location; reused codes (003,
  005, 007, 017, and 023 with RFC 0001); cross-package parameter decorators both ways (with the http
  and messaging extensions loaded); generated section snapshot; byte-identical output across
  incremental compiles; `tsc` type-checks a handler whose parameter does not match its schema
  (expected error); boundaries (`/compiler` never loads the runtime nor `ws`).
- **End to end (`tests/golden.test.ts`, `ZNIGHT_E2E=1`)**: the example's generated module is
  identical from sources and from `dist`, on Node and Bun.
- **Lifecycle**: SIGTERM with open connections (close frames received, `@OnDisconnect` run,
  request-scoped instances disposed, process exits), stop during a handshake, stop with a stuck
  handler (terminated at the deadline), HMR dispose, a plugin instance reused by a second
  application after the first stopped.
- **Bench (`ZNIGHT_BENCH=1`)**: the targets of §8.11, Node and Bun, with and without `bufferutil`.

## 12. Wave 7 example: `examples/realtime-chat`

**Purpose.** The tested reference for "real time with Znight": every snippet of the WebSocket guide
comes from it, and its tests are the guide's tests.

**Domain.** Chat rooms with presence, typing indicators, history, moderation and announcements, plus
a binary price ticker. Data stays in memory (rest-api shows the database side).

**Stack.** `nodeAdapter()` by default (`HTTP_ADAPTER=fastify|express|hono` switches it, for the
parity tests), Node 24 and Bun; `@znight/config`, `@znight/observability`, `@znight/messaging`
(memory driver), `zod`. A static `public/index.html` client (plain `WebSocket`, about 150 lines)
makes it usable from a browser.

**Authentication.** As in rest-api, API keys (`x-api-key`) for machine clients, which may connect
with the header directly; browsers obtain a **ticket** (`POST /ws/tickets`, single use, 30 s).
The global `AuthGuard` accepts a key, or a ticket on upgrade requests only, fills the
request-scoped `RequestUser` and enforces the RFC 0001 `access` group (`@Public`,
`@Authenticated`, `@Roles`).

| HTTP route                                | Access              | Shows                                                                    |
| ----------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `GET /`                                   | `@Public()`         | `HttpResponse.file()` of the browser client                              |
| `POST /ws/tickets`                        | `@Authenticated()`  | the ticket recipe                                                        |
| `GET /rooms`, `GET /rooms/:room/messages` | `@Authenticated()`  | `WsServer` read from a controller (live member counts), history          |
| `POST /rooms/:room/announcements`         | `@Roles(['admin'])` | HTTP → messaging → WebSocket fan-out (`AnnouncementConsumer` broadcasts) |
| `GET /health`                             | `@Public()`         | connections in the health payload                                        |

| Gateway                                                                                                                               | Events / frames                                                                                                                                                                                                                                                                                           | Shows                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/chat` (`ChatGateway`, `events`, subprotocol `chat.v1`, `@Authenticated()`, `@UseHandshakeGuard(ConnectionQuotaGuard)`, `rateLimit`) | `room.join` / `room.leave` (replies), `message.send` (validated, stored, broadcast, reply), `typing` (no reply, `onLimit: 'reject'` demo), `dm.send` (`user:<name>` rooms), `room.kick` (`@Roles(['moderator'])` + `ModeratorGuard`); server events `message.new`, `presence.*`, `typing`, `announcement` | the whole of §5, connection scope with `Lazy<RequestUser>`                                         |
| `/ticker/:symbol` (`TickerGateway`, `raw`, `@Public()`)                                                                               | binary ticks                                                                                                                                                                                                                                                                                              | raw protocol, path params, `drained()` backpressure, `conn.signal`, `4404` close from `@OnConnect` |
| `/rooms/:room/cursor` (`CursorGateway`, `scope: 'request'`, `backpressure: { limit: '64kb', onLimit: 'drop' }`)                       | cursor positions                                                                                                                                                                                                                                                                                          | a per-connection gateway instance with fields (injects `WsConnection`), lossy updates              |

**Layout:**

```text
examples/realtime-chat/
├─ public/index.html               browser client (ticket, reconnect with backoff, $ping latency)
├─ src/
│  ├─ main.ts                      plugins: observability, config, messaging (memory), http, websocket
│  ├─ plugins.ts                   shared with the tests (adapter from HTTP_ADAPTER)
│  ├─ config/                      ServerConfig (ports, webOrigins), AuthConfig (@Secret API keys)
│  ├─ auth/                        access.ts (groups), auth.guard.ts (key | ticket), tickets.ts, request-user.ts
│  ├─ chat/                        chat.protocol.ts, chat.gateway.ts, moderator.guard.ts,
│  │                               connection-quota.guard.ts, message.service.ts, room.controller.ts
│  ├─ announcements/               announcement.controller.ts, announcement.consumer.ts
│  ├─ ticker/                      ticker.gateway.ts, price-feed.ts (deterministic in tests)
│  ├─ cursor/                      cursor.gateway.ts
│  └─ health/
├─ test/
│  ├─ support/app.ts               TestApp with the shared plugins, API keys, ticket helper
│  ├─ chat.ws.test.ts              join/send/reply, presence, validation errors, unknown event, $ping, kick, dm
│  ├─ handshake.ws.test.ts         401 / 403 (origin) / 429 (quota) / 400 (subprotocol) / ticket reuse refused
│  ├─ limits.ws.test.ts            1009, rate limit, slow consumer 1013 with a paused client, drop policy
│  ├─ ticker.ws.test.ts            binary frames, backpressure, 4404
│  ├─ shutdown.ws.test.ts          app.stop(): 1001 received, @OnDisconnect ran, RequestUser disposed
│  ├─ gateway.unit.test.ts         TestBed + createTestConnection / createTestServer
│  ├─ build-check.test.ts          compile() of a fixture with a duplicate event → ZNIGHT030 at its location
│  └─ e2e.test.ts                  ZNIGHT_E2E: build, run on Node and on Bun for each adapter, connectWebSocket
└─ README.md                       "What it shows", protocol cheat sheet, "Try breaking it" (duplicate event,
                                   singleton gateway injecting WsConnection → ZNIGHT003, missing HttpPlugin → ZNIGHT031)
```

The guide (`docs/guide/websockets.md`) covers: gateways, protocol, rooms, auth (ticket, origins),
scopes, errors and close codes, backpressure, scaling out (the messaging fan-out), testing,
observability, and links each section to its file and test in this example.

## 13. Alternatives considered

| Alternative                                                                 | Verdict                                                                                                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateways as HTTP controllers (`@Controller` + `@WebSocket()` route)         | Rejected: mixes two handler models in one extension; the http extension stays free of message semantics, while upgrade routes in http stay generic |
| A standalone WebSocket server / port                                        | Rejected (Q1)                                                                                                                                      |
| Per-adapter integrations (`@fastify/websocket`, Hono helpers, `express-ws`) | Rejected: four behaviours, no shared pipeline, no Bun parity                                                                                       |
| `crossws` as the transport layer                                            | Rejected (§9)                                                                                                                                      |
| Only `ws`, also on `Bun.serve()`                                            | Impossible: `Bun.serve()` has no `node:http` upgrade; and Bun's native path is the fastest                                                         |
| Only Bun's native WebSockets                                                | Rejected: Node.js is a first-class target                                                                                                          |
| One `@UseGuard` for handshakes and messages                                 | Rejected: two interfaces (`CanActivate`, `WsGuard`) behind one name would confuse users and the compiler                                           |
| Unbounded outbound buffering (Socket.IO default)                            | Rejected: memory exhaustion by slow clients                                                                                                        |
| Message ordering left to the application (parallel by default)              | Rejected: ordering bugs are subtle; `concurrency` opts out                                                                                         |
