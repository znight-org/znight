---
"@znight/testing": patch
---

`TestApp.connect()` opens in-memory WebSocket connections through `WebSocketPlugin`, `connectWebSocket()` connects over the network with the same `TestWsClient`, and `TestApp` boots the gateways of `metadata.extensions.websocket` with their guards (RFC 0003).
