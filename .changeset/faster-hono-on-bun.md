---
"@znight/http": patch
---

Faster Hono adapter on Bun, with the same behaviour: a request body with a `Content-Length` is read at once (`request.bytes()`) instead of through a Web stream, responses go to `Bun.serve()` untouched (no `response.body` read, no wrapper without Hono middleware), and the GET and HEAD routes of a path are one Hono route.
