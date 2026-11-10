---
"@znight/http": patch
---

`fastifyAdapter({ instance })` works with an instance that has its own not-found handler: unknown URLs reach that handler while Znight keeps its routes, `405`, automatic `OPTIONS` and CORS preflights (new `notFound: 'znight' | 'instance'` option).
