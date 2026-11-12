# @znight/websocket

## 0.9.1

### Patch Changes

- Updated dependencies [5e828fc]
  - @znight/compiler@0.9.1
  - @znight/http@0.9.1
  - @znight/core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [394c247]
  - @znight/compiler@0.9.0
  - @znight/core@0.9.0
  - @znight/http@0.9.0

## 0.8.0

### Patch Changes

- @znight/compiler@0.8.0
  - @znight/core@0.8.0
  - @znight/http@0.8.0

## 0.7.3

### Patch Changes

- bb1c8f1: Report unexpected failures of handlers, `@OnConnect` and `@OnDisconnect` on the `error:report` hook (the original error of a mapped failure); a `WsException` with code `INTERNAL`, thrown or returned by a mapper, is now logged and reported as an unexpected failure.
- Updated dependencies [bb1c8f1]
- Updated dependencies [0804801]
- Updated dependencies [bb1c8f1]
  - @znight/core@0.7.3
  - @znight/http@0.7.3
  - @znight/compiler@0.7.3

## 0.7.2

### Patch Changes

- @znight/compiler@0.7.2
  - @znight/core@0.7.2
  - @znight/http@0.7.2

## 0.7.1

### Patch Changes

- 3cbfd77: The `homepage` of every package points to its page of the documentation site.
- Updated dependencies [3cbfd77]
  - @znight/compiler@0.7.1
  - @znight/core@0.7.1
  - @znight/http@0.7.1

## 0.7.0

### Patch Changes

- @znight/compiler@0.7.0
  - @znight/core@0.7.0
  - @znight/http@0.7.0

## 0.6.6

### Patch Changes

- Updated dependencies [d85b11b]
  - @znight/compiler@0.6.6
  - @znight/http@0.6.6
  - @znight/core@0.6.6

## 0.6.5

### Patch Changes

- 1a2b15c: A handshake whose client left is no longer completed, and `connect()` takes a `signal` that disconnects the in-memory client before the connection opens.
- Updated dependencies [1a2b15c]
- Updated dependencies [ad31655]
  - @znight/http@0.6.5
  - @znight/compiler@0.6.5
  - @znight/core@0.6.5

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
