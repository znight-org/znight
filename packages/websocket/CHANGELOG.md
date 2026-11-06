# @znight/websocket

## 0.6.1

### Patch Changes

- Updated dependencies [3785557]
  - @znight/http@0.6.1
  - @znight/compiler@0.6.1
  - @znight/core@0.6.1

## 0.6.0

### Minor Changes

- f6cbef6: New `@znight/websocket` package (RFC 0003): WebSocket gateways served by the HTTP server, `@Gateway` classes with `@OnMessage` handlers, handshake and message guards, Standard Schema payload validation, rooms and broadcasts, backpressure, rate limits and heartbeats, checked at build time; native transport on Bun, `ws` on Node.js (`@znight/websocket/ws`), and `@znight/websocket/testing`.

### Patch Changes

- Updated dependencies [f6cbef6]
  - @znight/http@0.6.0
  - @znight/core@0.6.0
  - @znight/compiler@0.6.0
