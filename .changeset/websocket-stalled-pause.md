---
"@znight/websocket": patch
---

A connection whose reading the server paused is terminated by the heartbeat after three ticks without any handler progress, instead of being kept forever while its handlers wait on a client that stopped reading.
