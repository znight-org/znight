# @znight/websocket

## 0.6.4

### Patch Changes

- 74b6b04: A codec throwing on a client frame is logged at `warn`, once per connection, instead of an error per frame.
- 74b6b04: A connection whose reading the server paused is terminated by the heartbeat after three ticks without any handler progress, instead of being kept forever while its handlers wait on a client that stopped reading.
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
  - @znight/compiler@0.6.4
  - @znight/core@0.6.4
  - @znight/http@0.6.4

## 0.6.3

### Patch Changes

- 69c2b5c: Fix audit findings: valid close frames (no half-closed connections), per-gateway `'queued'`, handler route metadata merged per group, safe `101` headers, throwing codecs, paused heartbeats and inbound event names.
- Updated dependencies [0eeac37]
- Updated dependencies [dede0c2]
- Updated dependencies [dc4be25]
  - @znight/compiler@0.6.3
  - @znight/core@0.6.3
  - @znight/http@0.6.3

## 0.6.2

### Patch Changes

- @znight/compiler@0.6.2
  - @znight/core@0.6.2
  - @znight/http@0.6.2

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
