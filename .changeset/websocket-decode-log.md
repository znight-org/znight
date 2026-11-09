---
"@znight/websocket": patch
---

A codec throwing on a client frame is logged at `warn`, once per connection, instead of an error per frame.
