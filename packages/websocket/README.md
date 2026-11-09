# @znight/websocket

WebSocket **gateways** for Znight, served by the `HttpPlugin` server on the same port. A gateway is
a provider class whose methods handle the connection lifecycle (`@OnConnect`, `@OnDisconnect`) and
inbound events (`@OnMessage`), with Standard Schema validation, replies, rooms, broadcasts,
backpressure, heartbeats and a graceful shutdown. Like every Znight feature, gateways are resolved
**at build time**: the compiler extension reads the decorators, reports invalid gateways
(ZNIGHT050...) and generates one `invoke` function per handler.

- The handshake **is an HTTP request**: request scope, `http:request` hook, `HttpPlugin` global
  guards, `@UseHandshakeGuard` guards, exception mappers, `trustProxy`. The request scope lasts as
  long as the connection: request-scoped providers filled by a guard are there for every message.
  Headers and cookies a guard sets are sent with the `101` response, minus those `res.setHeader()`
  would refuse on an HTTP route (a name that is not a token, a value with CR, LF or another control
  character): they are dropped.
- One server, every adapter: `node`, `fastify`, `express` and `hono` on Node.js and Bun. The `ws`
  transport serves `node:http` servers (Bun ships its own `ws`); Bun's native WebSocket serves
  `honoAdapter()` on `Bun.serve()`.
- A tiny wire protocol for `events` gateways (JSON `{ event, data?, id? }`), and `raw` gateways for
  anything else.

## Install

```sh
bun add @znight/core @znight/http @znight/websocket zod
npm i ws          # Node.js only: Bun provides it
bun add -d @znight/compiler vite
```

```ts
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { WebSocketPlugin } from '@znight/websocket'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000 }), WebSocketPlugin.configure({ maxPayload: '64kb' })],
})
await app.start()
```

## Gateways

```ts
import { z } from 'zod'
import {
  Conn,
  Gateway,
  OnConnect,
  OnDisconnect,
  OnMessage,
  Payload,
  WsException,
  WsServer,
  type WsConnection,
} from '@znight/websocket'

export const JoinRoom = z.object({ room: z.string().regex(/^[a-z0-9-]{1,32}$/) })
export type JoinRoom = z.output<typeof JoinRoom>
export const SendMessage = z.object({ room: z.string(), text: z.string().min(1).max(2000) })
export type SendMessage = z.output<typeof SendMessage>

interface ChatEvents {
  'message.new': { readonly room: string; readonly text: string }
}

@Gateway({ path: '/chat', protocols: ['chat.v1'], rateLimit: { messages: 30, intervalMs: 1_000 } })
export class ChatGateway {
  constructor(private readonly ws: WsServer) {}

  @OnConnect()
  connected(@Conn() conn: WsConnection): void {
    conn.join('lobby')
  }

  @OnMessage('room.join')
  join(@Conn() conn: WsConnection, @Payload(JoinRoom) input: JoinRoom): { members: number } {
    conn.join(input.room)
    return { members: this.ws.of(ChatGateway).members(input.room).size } // the reply
  }

  @OnMessage('message.send')
  send(@Conn() conn: WsConnection, @Payload(SendMessage) input: SendMessage): void {
    if (!conn.rooms.has(input.room)) throw new WsException('FORBIDDEN', `Join "${input.room}" first`)
    this.ws.of<ChatEvents>(ChatGateway).to(input.room).emit('message.new', input) // encoded once
  }

  @OnDisconnect()
  disconnected(): void {}
}
```

| Decorator                               | Target        | Description                                                                                         |
| --------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| `@Gateway(path?)` / `@Gateway(options)` | class         | A provider handling the connections of `path` (default `/`), joined to the `HttpPlugin` prefix      |
| `@OnConnect()`                          | method        | Runs once the handshake succeeded, before any message. Throwing closes the connection               |
| `@OnMessage(event?)`                    | method        | Handles an event; without event, the default handler (unknown events, every frame of a raw gateway) |
| `@OnDisconnect()`                       | method        | Runs once per connection whose `@OnConnect` completed, after its running handlers                   |
| `@Payload(schema?)`                     | parameter     | The message `data` (`events`) or the frame (`raw`), validated by a Standard Schema                  |
| `@Conn()`                               | parameter     | The `WsConnection`                                                                                  |
| `@Ctx()`                                | parameter     | The `WsMessageContext` of the message                                                               |
| `@UseHandshakeGuard(...guards)`         | class         | HTTP guards (`CanActivate`) of the handshake, after the `HttpPlugin` global guards                  |
| `@UseMessageGuard(...guards)`           | class, method | `WsGuard`s run before each handler (plugin, class, then method)                                     |
| `createRouteDecorator` decorators       | class, method | Class: handshake and messages; method: its messages (nearest wins per group)                        |

`@Gateway` options (static): `path`, `scope` (`'singleton'` or `'request'`: one instance per
connection, which may inject `WsConnection`), `protocol` (`'events'` or `'raw'`), `protocols`
(accepted subprotocols; a client offering none of them is refused with `400`), `maxPayload`
(`'64kb'` or bytes; default: the plugin's `maxPayload`), `concurrency` (messages of a connection
handled at once, default `1`: in order),
`rateLimit` (`{ messages, intervalMs, onLimit?: 'reject' | 'close' }`) and `backpressure`
(`{ limit?, onLimit?: 'close' | 'drop' }`).

Handlers may be `async`; their return value is the reply of a message that carried an `id`.
Handlers are inherited from abstract base classes. Core AOP (`@Logged`, `@Traced`, `@Intercept`)
applies to handlers.

## Wire protocol (`events` gateways)

| Direction       | Frame                                                                          | Meaning                                   |
| --------------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| client → server | `{ "event": "message.send", "data": {...} }`                                   | fire and forget                           |
| client → server | `{ "event": "room.join", "data": {...}, "id": 7 }`                             | a request: one reply                      |
| server → client | `{ "id": 7, "data": {...} }` / `{ "id": 7, "error": { code, message } }`       | reply                                     |
| server → client | `{ "event": "message.new", "data": {...} }`                                    | server event (`emit`, broadcasts)         |
| server → client | `{ "event": "$error", "data": { "event": ..., "code": ..., "message": ... } }` | failure of a message without `id`         |
| client ↔ server | `{ "event": "$ping", "id": 1 }` → `{ "id": 1, "data": { "t": ... } }`          | application ping (never reaches handlers) |

Error codes: `BAD_FRAME`, `UNSUPPORTED_FRAME`, `BAD_REQUEST` (validation, `details: [{ path,
message }]`), `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UNPROCESSABLE`, `RATE_LIMITED`,
`UNKNOWN_EVENT`, `TIMEOUT`, `INTERNAL` (message hidden unless `exposeErrors`). A `WsException(code,
message?, details?, { close? })` answers its code; an `HttpException` thrown by a service is mapped
from its status. In `@OnConnect`, a `WsException` closes with its `close` code (default `1008`), an
`HttpException` with `4000 + status`, anything else with `1011`.

Every close frame the server sends carries a code a server may send (`1000`–`1014` except `1004`,
`1005` and `1006`, or `3000`–`4999`; `1011` replaces any other code) and a reason of at most 123
UTF-8 bytes (a longer one, such as an exception message holding client input, is cut on a code
point boundary). A transport that still refuses the close frame terminates the socket.

`raw` gateways have no envelope: the default handler receives each frame (`string` or
`Uint8Array`), `conn.send()` sends frames as they are.

## Connections, rooms and broadcasts

`WsConnection<TData, Events>`: `id`, `gateway`, `requestId`, `handshake` (the `HttpContext`),
`params`, `protocol`, `data` (per-connection state), `rooms`, `readyState`, `bufferedAmount`,
`signal`, `closeInfo` (set before `@OnDisconnect`), `emit(event, data)`, `send(frame)`,
`join(room)`, `leave(room)`, `to(room)` (the other members), `drained()`, `close(code?, reason?)`,
`terminate()`. `emit` and `send` return `'sent'`, `'queued'` (the outbound buffer is above half the
gateway's `backpressure.limit`: `await conn.drained()` before sending more) or `'dropped'`.

`WsServer` (injectable): `of(GatewayClass | '/path')` returns a lazy `GatewayChannel` (`path`,
`size`, `connection(id)`, `connections()`, `members(room)`, `rooms()`, `to(room)`, `except(...)`,
`emit`, `send`) and `connections` counts every connection. A broadcast encodes its frame once;
each recipient applies its own backpressure policy. Rooms are per gateway and per process.

## Plugin options

`WebSocketPlugin.configure(options | (container) => options)` (name `websocket`):

| Option               | Default                                                            | Description                                                                                                       |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `transport`          | `'auto'`                                                           | `wsTransport()` (`@znight/websocket/ws`) or `bunTransport()` (`@znight/websocket/bun`)                            |
| `origins`            | `'same-origin'`                                                    | `'*'`, exact origins and anchored `RegExp`s, or `(origin, ctx) => boolean`; checked first (`403`)                 |
| `maxPayload`         | `'1mb'`                                                            | Largest inbound message (`1009`); a gateway's own `maxPayload` overrides it                                       |
| `maxConnections`     | `Infinity`                                                         | Open connections per process (handshakes in flight count); above, `503` with `retry-after: 1`                     |
| `maxPendingMessages` | `32`                                                               | Inbound queue per connection before reading pauses                                                                |
| `backpressure`       | `{ limit: '1mb', onLimit: 'close' }`                               | Outbound buffer per connection: close with `1013`, or `'drop'` frames                                             |
| `heartbeat`          | `{ intervalMs: 30_000 }`                                           | `false` disables it; silent connections are terminated after two intervals                                        |
| `handshakeTimeoutMs` | `10_000`                                                           | `408` for handshakes whose guards did not answer                                                                  |
| `handlerTimeoutMs`   | `30_000`                                                           | Per message and `@OnConnect`: `TIMEOUT`, `ctx.signal` aborted                                                     |
| `closeTimeoutMs`     | `2_000`                                                            | Wait for the client's close frame before terminating                                                              |
| `codec`              | `jsonCodec`                                                        | Codec of `events` gateways (`WsCodec`: `{ decode(frame, binary), encode(message) }`); JSON text frames by default |
| `messageGuards`      | `[]`                                                               | Global `WsGuard`s (classes or instances)                                                                          |
| `exceptionMappers`   | `[]`                                                               | `WsExceptionMapper`s: `map(error, ctx) → WsException \| undefined`                                                |
| `exposeErrors`       | `false`                                                            | Send the message of unexpected errors                                                                             |
| `shutdown`           | `{ code: 1001, reason: 'Server shutting down', timeoutMs: 3_000 }` | Graceful shutdown: close frames, then terminate                                                                   |

The instance exposes `server` (`WsServer`), `transport`, `gateways`, `connections`, `stats()`
(`{ connections, opened, closed, messagesIn, messagesOut, bytesIn, bytesOut, dropped,
slowConsumerCloses }`), `connect(path, options?)` and `initRoots()`.

## Testing

```ts
import { TestApp, WsHandshakeError } from '@znight/testing'
import { HttpPlugin } from '@znight/http'
import { WebSocketPlugin } from '@znight/websocket'

await using app = await TestApp.create({
  metadata,
  plugins: [HttpPlugin.configure({ port: 0 }), WebSocketPlugin.configure()],
})
await using alice = await app.connect('/chat', { protocols: ['chat.v1'] }) // in memory, real handshake
expect(await alice.request('room.join', { room: 'general' })).toEqual({ members: 1 })
await expect(app.connect('/chat', { origin: 'https://evil.example' })).rejects.toBeInstanceOf(WsHandshakeError)
```

`connectWebSocket(url, { headers?, protocols? })` of `@znight/testing` gives the same client over
the network. For unit tests, `@znight/websocket/testing` provides fakes:

```ts
import { createTestConnection, createTestServer } from '@znight/websocket/testing'

const server = createTestServer({ paths: [[ChatGateway, '/chat']] }) // records broadcasts
const conn = createTestConnection({ data: { user: 'alice' }, rooms: ['general'] }) // records emitted frames
```

## Compiler contract

The compiler extension (`@znight/websocket/compiler`) generates `metadata.extensions.websocket`
(gateways sorted by token, handlers in declaration order, bases first) and imports from
`@znight/websocket`:

- `validatePayload(schema, value)`: Standard Schema validation of `@Payload(schema)`; returns the
  schema output (synchronously for synchronous schemas) or throws `WsValidationException`
  (`BAD_REQUEST`, `details: [{ path, message }]`). Stable.
- the types `WsConnection` and `WsMessageContext` of the generated `invoke` functions.

```ts
['invoke']: async (g: ChatGateway, m: WsMessageContext) =>
  g.join(m.connection as never, await validatePayload(JoinRoom, m.data)),
```

Diagnostics: ZNIGHT050 (invalid gateway: options, duplicate events, reserved `$` events, several
`@OnConnect`, undecorated parameters, `@Payload` outside `@OnMessage`...), ZNIGHT005 (decorator
misuse, parameter decorators imported from another package), ZNIGHT007 (paths), ZNIGHT017
(`@Payload()` without schema on a structured type), ZNIGHT003 (a singleton gateway injecting
`WsConnection`), ZNIGHT023 (required route decisions). At boot: ZNIGHT050 (options, metadata) and
ZNIGHT051 (no `HttpPlugin`, no upgrade support, `ws` missing, mismatched transport).

## Limitations

- `conn.handshake` keeps the native request of the handshake.
- Rooms are per process: broadcast across instances through `@znight/messaging`.
- No HTTP/2 or HTTP/3 WebSockets, no Socket.IO protocol.
