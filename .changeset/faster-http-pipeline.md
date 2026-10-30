---
"@znight/http": patch
---

Faster request pipeline on every adapter (1.4× to 2.7× the requests per second on Node.js), with the same behaviour: the async context is captured for streamed bodies only, serialiser headers are not checked twice, text bodies reach the adapters as strings (`AdapterReply.text`), and the Hono adapter reads HTTP/1.1 requests from Node.js directly.
