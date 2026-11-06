# realtime-chat

> Work in progress: `@znight/websocket` ([RFC 0003](../../rfcs/0003-websocket.md)) is not published
> yet. This example is its tested reference.

Chat rooms over WebSockets, served by the `HttpPlugin` server on one port, plus a binary price
ticker. Data stays in memory.

## What it shows

- **Gateways** (`src/chat/chat.gateway.ts`): `@Gateway({ path: '/chat', protocols: ['chat.v1'], rateLimit })`,
  `@OnConnect`, `@OnMessage` handlers with Zod payloads (`@Payload(SendMessage)`), replies,
  `@OnDisconnect`, rooms (`conn.join`, a `user:<name>` room per user) and broadcasts
  (`WsServer.of(ChatGateway).to(room).emit(...)`, encoded once).
- **The handshake is an HTTP request**: the global `AuthGuard` (`src/auth/auth.guard.ts`) protects
  routes and handshakes alike, with an API key (`x-api-key`) or, for browsers, a single-use ticket
  (`POST /ws/tickets`, then `/chat?ticket=...`). The request scope is the connection: the
  `RequestUser` it fills is there for every message.
- **Access decisions** (RFC 0001): `@Authenticated()` on the gateway, `@Public()` on the ticker,
  checked at build time.
- **Handshake guards** (`ConnectionQuotaGuard`: at most five tabs per user, `429`) and **message
  guards** (`ModeratorGuard` reading `@Roles(['moderator'])` on `room.kick`).
- **A raw gateway** (`src/ticker/ticker.gateway.ts`): `/ticker/:symbol`, binary frames sent at the
  client's pace (`conn.send(...) === 'queued'` → `await conn.drained()`), a `4404` close from
  `@OnConnect` for an unknown symbol.
- **HTTP and WebSockets together**: `GET /rooms` reads live member counts from `WsServer`,
  `GET /health` counts connections.
- **Tests** in memory with `app.connect()` (real handshake, no socket) and over the network with
  `connectWebSocket()`.

## Run it

```sh
bun install
bun run build                                   # the packages' dist, for the CLI and Vite
bun run --cwd examples/realtime-chat dev        # http://localhost:3000, ws://localhost:3000/chat
bun run --cwd examples/realtime-chat test
```

API keys come from `CHAT_KEYS` (default `alice:alice-key:moderator,bob:bob-key`).

```sh
curl -X POST localhost:3000/ws/tickets -H 'x-api-key: bob-key'      # { "ticket": "..." }
curl localhost:3000/rooms -H 'x-api-key: bob-key'
curl localhost:3000/health
```

## Protocol cheat sheet (`/chat`, subprotocol `chat.v1`)

| Client sends                                                                          | Server answers                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `{ "event": "room.join", "data": { "room": "general" }, "id": 1 }`                    | `{ "id": 1, "data": { "members": 1 } }`             |
| `{ "event": "message.send", "data": { "room": "general", "text": "hi" }, "id": 2 }`   | the message as reply, and `message.new` to the room |
| `{ "event": "room.kick", "data": { "room": "general", "user": "bob" } }` (moderators) | `kicked` to every tab of `bob`                      |
| `{ "event": "$ping", "id": 3 }`                                                       | `{ "id": 3, "data": { "t": 1730000000000 } }`       |

Server events: `message.new`, `presence.joined`, `presence.left`, `kicked`; failures of messages
without `id` come as `$error`.

## Try breaking it

- Handle `message.send` in two methods: the build fails with `ZNIGHT050` at the second handler.
- Inject `WsConnection` in the constructor of the singleton `ChatGateway`: `ZNIGHT003` (use
  `@Gateway({ scope: 'request' })` or `@Conn()` parameters).
- Remove `@Authenticated()` from `ChatGateway`: `ZNIGHT023`, the handshake has no access decision.
