---
"@znight/http": patch
---

An adapter trusting every proxy hop (Fastify `trustProxy: true`, an Express `trust proxy` accepting any address, including a function or ranges) is refused at boot only when the `trustProxy` option of `HttpPlugin` is not set, since `ctx.ip` then comes from the adapter (0.6.3 refused it in every case). Migration from 0.6.2: set `HttpPlugin.configure({ trustProxy })` to your proxies (a hop count or addresses), or remove the framework setting.
